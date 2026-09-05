import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { requireUser, AuthError } from '../_shared/auth.mjs';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return json({error:'method_not_allowed'},405);
  try {
    const body=await req.json();
    const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
    const actor=await requireUser(db,body,Deno.env.get('TELEGRAM_BOT_TOKEN'));
    const login=String(body.login||'').trim().toLowerCase(),password=String(body.password||'');
    if(!/^[a-z0-9._-]{3,40}$/.test(login))return json({error:'invalid_login'},400);
    if(password.length<10||password.length>128)return json({error:'weak_password'},400);
    let target=actor;
    if(body.action==='create_user') {
      if(actor.role!=='owner')throw new AuthError('forbidden',403);
      const name=String(body.name||'').trim();
      if(!name||name.length>100)return json({error:'name_required'},400);
      if(!['foreman','partner'].includes(body.role))return json({error:'invalid_role'},400);
      // Reserve the login atomically; no project data is created or changed here.
      const {data,error}=await db.from('app_users').insert({first_name:name,role:body.role,is_active:false,web_login:login}).select('*').single();
      if(error)return json({error:error.code==='23505'?'login_taken':'account_create_failed'},400);
      target=data;
    } else if(body.action==='set_credentials') {
      if(body.user_id&&body.user_id!==actor.id) {
        if(actor.role!=='owner')throw new AuthError('forbidden',403);
        const {data,error}=await db.from('app_users').select('*').eq('id',body.user_id).single();
        if(error)throw error;target=data;
      }
      // A web user changing their own password must also know their current password.
      if(target.id===actor.id&&body.accessToken) {
        const auth=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
        const {error}=await auth.auth.signInWithPassword({email:`${actor.id}@login.adma.invalid`,password:String(body.currentPassword||'')});
        if(error)return json({error:'current_password_invalid'},403);
      }
      const {data:other,error:lookupError}=await db.from('app_users').select('id').eq('web_login',login).neq('id',target.id).maybeSingle();
      if(lookupError)throw lookupError;
      if(other)return json({error:'login_taken'},409);
    } else return json({error:'unknown_action'},400);
    const {data:existing,error:lookup}=await db.auth.admin.getUserById(target.id);
    if(lookup&&lookup.status!==404)return json({error:'account_lookup_failed'},503);
    const result=existing?.user
      ? await db.auth.admin.updateUserById(target.id,{password})
      : await db.auth.admin.createUser({id:target.id,email:`${target.id}@login.adma.invalid`,password,email_confirm:true});
    // Internal synthetic email is a credential identifier; no real mailbox is claimed or emailed.
    if(result.error)return json({error:'account_create_failed'},400);
    const patch:any={web_login:login,updated_at:new Date().toISOString()};
    if(body.action==='create_user')patch.is_active=true;
    const {error}=await db.from('app_users').update(patch).eq('id',target.id);
    if(error)return json({error:'account_link_failed'},500);
    return json({ok:true,login,user_id:target.id});
  } catch(e) {return json({error:e instanceof AuthError?e.message:'account_update_failed'},e instanceof AuthError?e.status:500);}
});
