import { requireUser, credentialsFromForm, AuthError } from '../_shared/auth.mjs';
import { removeStorageObject } from '../_shared/storage-cleanup.mjs';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mimes=new Set(['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','image/jpeg','image/png','image/webp','image/heic','image/heif']);
const extensions:any={'application/pdf':'pdf','application/msword':'doc','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx','application/vnd.ms-excel':'xls','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx','image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/heic':'heic','image/heif':'heif'};

Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});if(req.method!=='POST')return json({error:'method_not_allowed'},405);
 try{
  const form=await req.formData(),db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}}),user=await requireUser(db,credentialsFromForm(form),Deno.env.get('TELEGRAM_BOT_TOKEN'));
  if(!['owner','partner'].includes(user.role))throw new AuthError('forbidden',403);
  const entity=String(form.get('entity')||''),entityId=String(form.get('entity_id')||''),file=form.get('file');
  if(!['tech_card','issue'].includes(entity))return json({error:'invalid_entity'},400);if(!uuid.test(entityId))return json({error:'invalid_id'},400);
  if(!(file instanceof File)||!file.size)return json({error:'file_required'},400);if(file.size>10*1024*1024)return json({error:'file_too_large'},413);
  const mime=String(file.type||'').toLowerCase();if(!mimes.has(mime)||!extensions[mime])return json({error:'unsupported_file'},415);
  const sourceTable=entity==='tech_card'?'knowledge_tech_cards':'knowledge_issues',source=await db.from(sourceTable).select('id').eq('id',entityId).single();if(source.error)throw source.error;
  const originalName=String(file.name||'').trim().slice(0,300)||null,path=`${entity}/${entityId}/${crypto.randomUUID()}.${extensions[mime]}`;
  const uploaded=await db.storage.from('knowledge-files').upload(path,new Uint8Array(await file.arrayBuffer()),{contentType:mime,cacheControl:'3600',upsert:false});if(uploaded.error)throw uploaded.error;
  const row:any={tech_card_id:entity==='tech_card'?entityId:null,issue_id:entity==='issue'?entityId:null,storage_path:path,original_name:originalName,mime_type:mime,size_bytes:file.size,created_by:user.id};
  const inserted=await db.from('knowledge_attachments').insert(row).select('*').single();if(inserted.error){await removeStorageObject(db,'knowledge-files',path);throw inserted.error}
  return json({ok:true,attachment:inserted.data});
 }catch(error){const message=error instanceof Error?error.message:'unknown_error';return json({error:message},error instanceof AuthError?error.status:500)}
});
