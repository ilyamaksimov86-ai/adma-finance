import { requireUser, AuthError } from '../_shared/auth.mjs';
import { removeStorageObject } from '../_shared/storage-cleanup.mjs';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id=(value:unknown)=>{const result=String(value||'');if(!uuid.test(result))throw new Error('invalid_id');return result};
const text=(value:unknown,max:number,required=false)=>{const result=String(value??'').trim();if(required&&!result)throw new Error('required_field');if(result.length>max)throw new Error('field_too_long');return result||null};
const techInput=(value:any)=>({title:text(value?.title,240,true),category:text(value?.category,160,true),description:text(value?.description,20000)});
const issueInput=(value:any)=>({title:text(value?.title,240,true),category:text(value?.category,160,true),problem:text(value?.problem,12000),cause:text(value?.cause,12000),solution:text(value?.solution,12000),prevention:text(value?.prevention,12000)});
const checklistInput=(value:unknown)=>{if(!Array.isArray(value))throw new Error('invalid_checklist');if(value.length>100)throw new Error('checklist_too_long');return value.map((item:any,position:number)=>({item_text:text(item?.item_text??item?.text,1000,true),position}))};

Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});if(req.method!=='POST')return json({error:'method_not_allowed'},405);
 try{
  const body=await req.json(),db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}}),user=await requireUser(db,body,Deno.env.get('TELEGRAM_BOT_TOKEN'));
  if(!['owner','partner'].includes(user.role))throw new AuthError('forbidden',403);const action=String(body.action||'load');
  if(action==='load'){
   const [cards,items,issues,attachments]=await Promise.all([
    db.from('knowledge_tech_cards').select('*,author:app_users!knowledge_tech_cards_created_by_fkey(first_name,last_name,web_login,telegram_username)').order('updated_at',{ascending:false}),
    db.from('knowledge_tech_checklist_items').select('*').order('position',{ascending:true}),
    db.from('knowledge_issues').select('*,author:app_users!knowledge_issues_created_by_fkey(first_name,last_name,web_login,telegram_username)').order('updated_at',{ascending:false}),
    db.from('knowledge_attachments').select('*,author:app_users!knowledge_attachments_created_by_fkey(first_name,last_name,web_login,telegram_username)').order('created_at',{ascending:false}),
   ]);for(const result of [cards,items,issues,attachments])if(result.error)throw result.error;
   return json({ok:true,tech_cards:cards.data||[],checklist_items:items.data||[],issues:issues.data||[],attachments:attachments.data||[]});
  }
  if(action==='get_file_url'){
   const attachmentId=id(body.id),file=await db.from('knowledge_attachments').select('storage_path').eq('id',attachmentId).single();if(file.error)throw file.error;const signed=await db.storage.from('knowledge-files').createSignedUrl(file.data.storage_path,3600);if(signed.error)throw signed.error;return json({ok:true,url:signed.data?.signedUrl||null,expires_in:3600});
  }
  if(action==='save_tech_card'){
   const raw=body.tech_card||{},value=techInput(raw),items=checklistInput(body.checklist_items||[]);let data,error;
   if(raw.id)({data,error}=await db.from('knowledge_tech_cards').update({...value,updated_at:new Date().toISOString()}).eq('id',id(raw.id)).select('*').single());
   else({data,error}=await db.from('knowledge_tech_cards').insert({...value,created_by:user.id}).select('*').single());
   if(error)throw error;const cardId=data.id;
   const removed=await db.from('knowledge_tech_checklist_items').delete().eq('tech_card_id',cardId);if(removed.error)throw removed.error;
   if(items.length){const inserted=await db.from('knowledge_tech_checklist_items').insert(items.map(item=>({...item,tech_card_id:cardId}))).select('*');if(inserted.error)throw inserted.error;return json({ok:true,tech_card:data,checklist_items:inserted.data||[]})}
   return json({ok:true,tech_card:data,checklist_items:[]});
  }
  if(action==='save_issue'){
   const raw=body.issue||{},value=issueInput(raw);let data,error;
   if(raw.id)({data,error}=await db.from('knowledge_issues').update({...value,updated_at:new Date().toISOString()}).eq('id',id(raw.id)).select('*').single());
   else({data,error}=await db.from('knowledge_issues').insert({...value,created_by:user.id}).select('*').single());
   if(error)throw error;return json({ok:true,issue:data});
  }
  if(action==='delete_tech_card'||action==='delete_issue'){
   const entity=action==='delete_tech_card'?'tech_card':'issue',table=entity==='tech_card'?'knowledge_tech_cards':'knowledge_issues',column=entity==='tech_card'?'tech_card_id':'issue_id',itemId=id(body.id);
   const files=await db.from('knowledge_attachments').select('storage_path').eq(column,itemId);if(files.error)throw files.error;
   const removed=await db.from(table).delete().eq('id',itemId);if(removed.error)throw removed.error;
   const cleanup=await Promise.all((files.data||[]).map((file:any)=>removeStorageObject(db,'knowledge-files',file.storage_path)));
   return json({ok:true,cleanup_pending:cleanup.some(Boolean)});
  }
  if(action==='delete_attachment'){
   const attachmentId=id(body.id),old=await db.from('knowledge_attachments').select('storage_path').eq('id',attachmentId).single();if(old.error)throw old.error;
   const removed=await db.from('knowledge_attachments').delete().eq('id',attachmentId);if(removed.error)throw removed.error;
   return json({ok:true,cleanup_pending:await removeStorageObject(db,'knowledge-files',old.data.storage_path)});
  }
  return json({error:'unknown_action'},400);
 }catch(error){const message=error instanceof Error?error.message:'unknown_error',bad=['invalid_id','required_field','field_too_long','invalid_checklist','checklist_too_long'];return json({error:message},error instanceof AuthError?error.status:bad.includes(message)?400:500)}
});
