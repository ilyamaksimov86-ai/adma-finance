import { requireUser, credentialsFromForm, AuthError } from '../_shared/auth.mjs';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"content-type"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
const mimeExtensions=new Map([['application/pdf','pdf'],['image/jpeg','jpg'],['image/png','png'],['image/webp','webp']]);
Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return json({error:'method_not_allowed'},405);
  try{
    const form=await req.formData(),file=form.get('file');
    if(!(file instanceof File))return json({error:'file_required'},400);
    if(file.size>10*1024*1024)return json({error:'file_too_large'},413);
    const lower=(file.name||'').toLowerCase(),inferred=lower.endsWith('.pdf')?'application/pdf':lower.match(/\.jpe?g$/)?'image/jpeg':lower.endsWith('.png')?'image/png':lower.endsWith('.webp')?'image/webp':'';
    const mime=mimeExtensions.has(file.type)?file.type:inferred;if(!mimeExtensions.has(mime))return json({error:'unsupported_file'},400);
    const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
    const user=await requireUser(db,credentialsFromForm(form),Deno.env.get('TELEGRAM_BOT_TOKEN'));
    if(user.role!=='owner'&&user.role!=='partner')return json({error:'forbidden'},403);
    const entity=String(form.get('entity')||'document').replace(/[^a-z0-9_-]/gi,'').slice(0,40)||'document';
    const path=`${user.id}/${entity}/${crypto.randomUUID()}.${mimeExtensions.get(mime)}`;
    const {error}=await db.storage.from('finance-documents').upload(path,new Uint8Array(await file.arrayBuffer()),{contentType:mime,cacheControl:'3600',upsert:false});if(error)throw error;
    return json({ok:true,path});
  }catch(e){const message=e instanceof Error?e.message:'unknown_error';return json({error:message},e instanceof AuthError?e.status:['missing_hash','bad_signature','expired_init_data','missing_user'].includes(message)?401:500)}
});
