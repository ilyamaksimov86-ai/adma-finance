import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {requireUser,credentialsFromForm,AuthError} from '../supabase/functions/_shared/auth.mjs';
function handler(name,db,actor) {
 let serve;
 const source=readFileSync(new URL(`../supabase/functions/${name}/index.ts`,import.meta.url),'utf8').replace(/^import .*;\s*$/gm,'');
 const js=stripTypeScriptTypes(source);
 new Function('Deno','createClient','requireUser','credentialsFromForm','AuthError',js)(
  {env:{get:()=> 'test-config'},serve:h=>serve=h},()=>db,actor ? async()=>actor : requireUser,credentialsFromForm,AuthError);
 return serve;
}
const request=body=>new Request('https://test.invalid',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(body)});
const actor={id:'existing-user',role:'foreman',is_active:true};
const credentials={action:'set_credentials',login:'ilya',password:'new-password-123',initData:'test'};
test('all modified Edge Functions parse',()=>{
 for(const name of ['adma-api','receipt-upload','reimbursement-pdf','account-admin','web-auth']){
  const source=readFileSync(new URL(`../supabase/functions/${name}/index.ts`,import.meta.url),'utf8').replace(/^import .*;\s*$/gm,'');
  assert.doesNotThrow(()=>new Function(stripTypeScriptTypes(source)));
 }
});
test('foreman cannot create a web account',async()=>{
 const r=await handler('account-admin',{},actor)(request({...credentials,action:'create_user',name:'Test',role:'partner'}));assert.equal(r.status,403);
});
test('foreman cannot reset another user password',async()=>{
 const r=await handler('account-admin',{},actor)(request({...credentials,user_id:'victim'}));assert.equal(r.status,403);
});
test('web password change requires current password',async()=>{
 const db={auth:{signInWithPassword:async()=>({error:Error('wrong')})}};
 const r=await handler('account-admin',db,actor)(request({...credentials,accessToken:'test',currentPassword:'wrong'}));assert.equal(r.status,403);assert.equal((await r.json()).error,'current_password_invalid');
});
test('creating credentials preserves the existing app UUID and creates no real email',async()=>{
 let created,patched;
 const db={auth:{admin:{getUserById:async()=>({data:{user:null},error:{status:404}}),createUser:async args=>{created=args;return{data:{user:{id:args.id}},error:null};}}},from:()=>({select:()=>({eq:()=>({neq:()=>({maybeSingle:async()=>({data:null})})})}),update:p=>{patched=p;return{eq:async()=>({error:null})};}})};
 const r=await handler('account-admin',db,actor)(request(credentials));assert.equal(r.status,200);assert.equal(created.id,actor.id);assert.equal(created.email,'existing-user@login.adma.invalid');assert.equal(patched.web_login,'ilya');
});
test('refresh for a disabled app user returns no session',async()=>{
 const db={auth:{refreshSession:async()=>({data:{user:{id:'blocked'},session:{access_token:'secret'}},error:null})},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{is_active:false}})})})})};
 const r=await handler('web-auth',db)(request({action:'refresh',refreshToken:'test'}));assert.equal(r.status,403);assert(!(await r.text()).includes('secret'));
});
test('receipt upload checks web identity before touching storage',async()=>{
 let touched=false;
 const db={auth:{getUser:async()=>({error:Error('forged')})},storage:{from:()=>{touched=true;}}};
 const form=new FormData();form.append('accessToken','forged');form.append('file',new File(['test'],'receipt.jpg',{type:'image/jpeg'}));
 const r=await handler('receipt-upload',db)(new Request('https://test.invalid',{method:'POST',body:form}));assert.equal(r.status,401);assert.equal(touched,false);
});
