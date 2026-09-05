import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json = (body:unknown,status=200) => new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
Deno.serve(async req => {
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return json({error:'method_not_allowed'},405);
  try {
    const body=await req.json();
    const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
    // Separate public Auth client: signing in must not replace the DB service session.
    const auth=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
    let result;
    if(body.action==='login') {
      const login=String(body.login||'').trim().toLowerCase();
      if(!/^[a-z0-9._-]{3,40}$/.test(login)||typeof body.password!=='string'||body.password.length>128)return json({error:'invalid_credentials'},401);
      const {data:appUser,error}=await db.from('app_users').select('id,is_active').eq('web_login',login).maybeSingle();
      if(error)throw error;
      // All passwords and login rate limits are handled by Supabase Auth.
      result=await auth.auth.signInWithPassword({email:`${appUser?.id||'unknown'}@login.adma.invalid`,password:body.password});
      if(result.error||!appUser||!appUser.is_active)return json({error:'invalid_credentials'},401);
    } else if(body.action==='refresh') {
      result=await auth.auth.refreshSession({refresh_token:String(body.refreshToken||'')});
      if(result.error)return json({error:'invalid_session'},401);
      const id=result.data.user?.id;
      const {data:u}=await db.from('app_users').select('is_active').eq('id',id).maybeSingle();
      if(!u?.is_active)return json({error:'not_approved'},403);
    } else if(body.action==='logout') {
      const {error}=await db.auth.admin.signOut(String(body.accessToken||''),'local');
      if(error)return json({error:'invalid_session'},401);
      return json({ok:true});
    } else return json({error:'unknown_action'},400);
    const session=result.data.session;
    if(!session)return json({error:'invalid_session'},401);
    return json({ok:true,session:{access_token:session.access_token,refresh_token:session.refresh_token,expires_at:session.expires_at}});
  } catch { return json({error:'auth_unavailable'},503); }
});
