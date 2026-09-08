import { requireUser, credentialsFromForm, AuthError } from '../_shared/auth.mjs';
import { removeStorageObject } from '../_shared/storage-cleanup.mjs';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json = (body:unknown,status=200) => new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const categories = new Set(['contract','estimate','addendum','design','technical','other']);
const documentMimes = new Set(['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','image/jpeg','image/png','image/webp']);
const photoMimes = new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif']);
const extensions:any = {'application/pdf':'pdf','application/msword':'doc','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx','application/vnd.ms-excel':'xls','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx','image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/heic':'heic','image/heif':'heif'};
const clean = (value:unknown,max:number,required=false) => { const result=String(value??'').trim(); if(required&&!result)throw new Error('required_field'); if(result.length>max)throw new Error('field_too_long'); return result||null; };
const date = (value:unknown) => { const result=String(value||''); if(!result)return null; if(!isoDate.test(result))throw new Error('invalid_date'); return result; };

Deno.serve(async req => {
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
  if(req.method!=='POST') return json({error:'method_not_allowed'},405);
  try {
    const form=await req.formData();
    const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
    const user=await requireUser(db,credentialsFromForm(form),Deno.env.get('TELEGRAM_BOT_TOKEN'));
    const kind=String(form.get('kind')||'');
    const projectId=String(form.get('project_id')||'');
    const stageId=String(form.get('stage_id')||'');
    const file=form.get('file');
    if(!['document','photo'].includes(kind)) return json({error:'invalid_kind'},400);
    if(!uuid.test(projectId)) return json({error:'invalid_project'},400);
    if(stageId&&!uuid.test(stageId)) return json({error:'invalid_stage'},400);
    if(!(file instanceof File)||!file.size) return json({error:'file_required'},400);
    if(file.size>10*1024*1024) return json({error:'file_too_large'},413);
    const privileged=user.role==='owner'||user.role==='partner';
    if(!privileged){
      const {data,error}=await db.from('project_members').select('project_id').eq('project_id',projectId).eq('user_id',user.id).maybeSingle();
      if(error)throw error;
      if(!data)return json({error:'forbidden'},403);
    }
    const {data:project,error:projectError}=await db.from('projects').select('id,status').eq('id',projectId).single();
    if(projectError)throw projectError;
    if(project.status==='archived')return json({error:'project_archived'},400);
    if(stageId){
      const {data:stage,error}=await db.from('project_stages').select('project_id').eq('id',stageId).single();
      if(error)throw error;
      if(stage.project_id!==projectId)return json({error:'stage_project_mismatch'},400);
    }
    const mime=String(file.type||'').toLowerCase();
    const allowed=kind==='document'?documentMimes:photoMimes;
    if(!allowed.has(mime)||!extensions[mime])return json({error:kind==='photo'?'image_required':'unsupported_document'},415);
    const originalName=clean(file.name,300);
    const metadata:any=kind==='document'
      ? {title:clean(form.get('title'),240,true),category:String(form.get('category')||'other'),document_date:date(form.get('document_date')),description:clean(form.get('description'),4000)}
      : {stage_id:stageId||null,caption:clean(form.get('caption'),2000),shot_date:date(form.get('shot_date'))};
    if(kind==='document'&&!categories.has(metadata.category))return json({error:'invalid_document_category'},400);
    const path=`${projectId}/${kind==='document'?'documents':'photos'}/${crypto.randomUUID()}.${extensions[mime]}`;
    const bytes=new Uint8Array(await file.arrayBuffer());
    const {error:uploadError}=await db.storage.from('project-files').upload(path,bytes,{contentType:mime,cacheControl:'3600',upsert:false});
    if(uploadError)throw uploadError;
    const row={project_id:projectId,...metadata,storage_path:path,original_name:originalName,mime_type:mime,size_bytes:file.size,created_by:user.id};
    const table=kind==='document'?'project_documents':'project_photos';
    const {data,error}=await db.from(table).insert(row).select('*').single();
    if(error){await removeStorageObject(db,'project-files',path);throw error;}
    const {data:signed}=await db.storage.from('project-files').createSignedUrl(path,3600);
    return json({ok:true,[kind]:{...data,file_url:signed?.signedUrl||null}});
  } catch(error) {
    const message=error instanceof Error?error.message:'unknown_error';
    const bad=['required_field','field_too_long','invalid_date'];
    return json({error:message},error instanceof AuthError?error.status:bad.includes(message)?400:500);
  }
});
