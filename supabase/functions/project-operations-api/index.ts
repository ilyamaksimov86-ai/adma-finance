import { requireUser, AuthError } from '../_shared/auth.mjs';
import { removeStorageObject } from '../_shared/storage-cleanup.mjs';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {...cors, "Content-Type":"application/json"}});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const documentCategories = new Set(['contract','estimate','addendum','design','technical','other']);
const taskStatuses = new Set(['new','in_progress','completed','cancelled']);
const taskPriorities = new Set(['low','normal','high','urgent']);
const id = (value: unknown) => { const result = String(value || ''); if (!uuid.test(result)) throw new Error('invalid_id'); return result; };
const date = (value: unknown) => { const result = String(value || ''); if (!result) return null; if (!isoDate.test(result)) throw new Error('invalid_date'); return result; };
const text = (value: unknown, max: number, required = false) => { const result = String(value ?? '').trim(); if (required && !result) throw new Error('required_field'); if (result.length > max) throw new Error('field_too_long'); return result || null; };

function documentInput(value: any) {
  const category = String(value?.category || 'other');
  if (!documentCategories.has(category)) throw new Error('invalid_document_category');
  return {title:text(value?.title,240,true), category, document_date:date(value?.document_date), description:text(value?.description,4000)};
}

function taskInput(value: any) {
  const status = String(value?.status || 'new');
  const priority = String(value?.priority || 'normal');
  if (!taskStatuses.has(status)) throw new Error('invalid_task_status');
  if (!taskPriorities.has(priority)) throw new Error('invalid_task_priority');
  const userId = value?.assignee_user_id ? id(value.assignee_user_id) : null;
  const masterId = value?.assignee_master_id ? id(value.assignee_master_id) : null;
  if (userId && masterId) throw new Error('multiple_assignees');
  return {project_id:id(value?.project_id), title:text(value?.title,240,true), description:text(value?.description,4000), assignee_user_id:userId, assignee_master_id:masterId, deadline:date(value?.deadline), priority, status, stage_id:value?.stage_id?id(value.stage_id):null, act_id:value?.act_id?id(value.act_id):null, waybill_id:value?.waybill_id?id(value.waybill_id):null};
}

function photoInput(value: any) {
  return {stage_id:value?.stage_id?id(value.stage_id):null, caption:text(value?.caption,2000), shot_date:date(value?.shot_date)};
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', {headers:cors});
  if (req.method !== 'POST') return json({error:'method_not_allowed'}, 405);
  try {
    const body = await req.json();
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {auth:{persistSession:false}});
    const user = await requireUser(db, body, Deno.env.get('TELEGRAM_BOT_TOKEN'));
    const privileged = user.role === 'owner' || user.role === 'partner';
    const action = String(body?.action || 'load');
    let cachedProjectIds: string[] | null | undefined;
    const allowedProjectIds = async () => {
      if (privileged) return null;
      if (cachedProjectIds) return cachedProjectIds;
      const {data,error} = await db.from('project_members').select('project_id').eq('user_id',user.id);
      if (error) throw error;
      cachedProjectIds = (data || []).map((item:any) => item.project_id);
      return cachedProjectIds;
    };
    const requireProject = async (value: unknown) => {
      const projectId = id(value);
      if (!privileged && !((await allowedProjectIds()) || []).includes(projectId)) throw new AuthError('forbidden',403);
      const {data,error} = await db.from('projects').select('id').eq('id',projectId).single();
      if (error) throw error;
      return data.id as string;
    };
    const checkLink = async (table: string, linkId: string | null, projectId: string) => {
      if (!linkId) return;
      const {data,error} = await db.from(table).select('id,project_id').eq('id',linkId).single();
      if (error) throw error;
      if (data.project_id !== projectId) throw new Error('link_project_mismatch');
    };
    const signRows = async (rows: any[]) => Promise.all(rows.map(async row => {
      const {data,error} = await db.storage.from('project-files').createSignedUrl(row.storage_path,3600);
      return {...row, file_url:error?null:data?.signedUrl||null, file_error:error?'file_unavailable':null};
    }));

    if (action === 'load') {
      const requested = body.project_id ? await requireProject(body.project_id) : null;
      const ids = requested ? [requested] : await allowedProjectIds();
      const selects:any = {
        project_documents:'*,author:app_users!project_documents_created_by_fkey(first_name,last_name,telegram_username,web_login)',
        project_tasks:'*,author:app_users!project_tasks_created_by_fkey(first_name,last_name,telegram_username,web_login)',
        project_photos:'*,author:app_users!project_photos_created_by_fkey(first_name,last_name,telegram_username,web_login)',
      };
      const scoped = (table:string) => {
        let query = db.from(table).select(selects[table]).order('created_at',{ascending:false});
        if (ids) query = ids.length ? query.in('project_id',ids) : query.eq('project_id','00000000-0000-0000-0000-000000000000');
        return query;
      };
      const [documents,tasks,photos] = await Promise.all([scoped('project_documents'),scoped('project_tasks'),scoped('project_photos')]);
      for (const result of [documents,tasks,photos]) if (result.error) throw result.error;
      return json({ok:true, documents:await signRows(documents.data||[]), tasks:tasks.data||[], photos:await signRows(photos.data||[])});
    }

    if (action === 'save_document') {
      const item = body.document || {};
      const itemId = id(item.id);
      const {data:old,error:oldError} = await db.from('project_documents').select('project_id').eq('id',itemId).single();
      if (oldError) throw oldError;
      await requireProject(old.project_id);
      const {data,error} = await db.from('project_documents').update({...documentInput(item),updated_at:new Date().toISOString()}).eq('id',itemId).select('*').single();
      if (error) throw error;
      return json({ok:true,document:data});
    }

    if (action === 'delete_document' || action === 'delete_photo') {
      const table = action === 'delete_document' ? 'project_documents' : 'project_photos';
      const itemId = id(body.id);
      const {data:old,error:oldError} = await db.from(table).select('project_id,storage_path').eq('id',itemId).single();
      if (oldError) throw oldError;
      await requireProject(old.project_id);
      const {error} = await db.from(table).delete().eq('id',itemId);
      if (error) throw error;
      const cleanupPending = await removeStorageObject(db,'project-files',old.storage_path);
      return json({ok:true, cleanup_pending:cleanupPending});
    }

    if (action === 'save_task') {
      const value = taskInput(body.task);
      const projectId = await requireProject(value.project_id);
      await Promise.all([checkLink('project_stages',value.stage_id,projectId),checkLink('finance_acts',value.act_id,projectId),checkLink('finance_waybills',value.waybill_id,projectId)]);
      if (value.assignee_user_id) {
        const {data:assignee,error} = await db.from('app_users').select('id,role,is_active').eq('id',value.assignee_user_id).single();
        if (error) throw error;
        if (!assignee.is_active) throw new Error('assignee_inactive');
        if (!['owner','partner'].includes(assignee.role)) {
          const {data:membership,error:membershipError} = await db.from('project_members').select('project_id').eq('project_id',projectId).eq('user_id',assignee.id).maybeSingle();
          if (membershipError) throw membershipError;
          if (!membership) throw new Error('assignee_not_on_project');
        }
      }
      if (value.assignee_master_id) {
        const [masterResult,assignmentResult] = await Promise.all([
          db.from('masters').select('id,is_active').eq('id',value.assignee_master_id).single(),
          db.from('master_assignments').select('id').eq('master_id',value.assignee_master_id).eq('project_id',projectId).neq('status','cancelled').limit(1).maybeSingle(),
        ]);
        if (masterResult.error) throw masterResult.error;
        if (assignmentResult.error) throw assignmentResult.error;
        if (!masterResult.data.is_active || !assignmentResult.data) throw new Error('master_not_on_project');
      }
      let data,error;
      if (body.task?.id) ({data,error} = await db.from('project_tasks').update({...value,updated_at:new Date().toISOString()}).eq('id',id(body.task.id)).eq('project_id',projectId).select('*').single());
      else ({data,error} = await db.from('project_tasks').insert({...value,created_by:user.id}).select('*').single());
      if (error) throw error;
      return json({ok:true,task:data});
    }

    if (action === 'delete_task') {
      const taskId = id(body.id);
      const {data:old,error:oldError} = await db.from('project_tasks').select('project_id').eq('id',taskId).single();
      if (oldError) throw oldError;
      await requireProject(old.project_id);
      const {error} = await db.from('project_tasks').delete().eq('id',taskId);
      if (error) throw error;
      return json({ok:true});
    }

    if (action === 'save_photo') {
      const item = body.photo || {};
      const itemId = id(item.id);
      const {data:old,error:oldError} = await db.from('project_photos').select('project_id').eq('id',itemId).single();
      if (oldError) throw oldError;
      await requireProject(old.project_id);
      const value = photoInput(item);
      await checkLink('project_stages',value.stage_id,old.project_id);
      const {data,error} = await db.from('project_photos').update({...value,updated_at:new Date().toISOString()}).eq('id',itemId).select('*').single();
      if (error) throw error;
      return json({ok:true,photo:data});
    }
    return json({error:'unknown_action'},400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_error';
    const bad = ['invalid_id','invalid_date','required_field','field_too_long','invalid_document_category','invalid_task_status','invalid_task_priority','multiple_assignees','link_project_mismatch','assignee_inactive','assignee_not_on_project','master_not_on_project'];
    return json({error:message}, error instanceof AuthError ? error.status : bad.includes(message) ? 400 : 500);
  }
});
