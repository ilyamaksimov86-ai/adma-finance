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
function backupHandler(db,overrides={}) {
 let serve;
 const source=readFileSync(new URL('../supabase/functions/backup-adma/index.ts',import.meta.url),'utf8').replace(/^import .*;\s*$/gm,'');
 const js=stripTypeScriptTypes(source);
 const EdgeRuntime={waitUntil:overrides.waitUntil??(()=>{})};
 new Function('Deno','createClient','runBackup','runRestoreDryRun','assertBackupId','createSupabaseBackupDeps','EdgeRuntime',js)(
  {env:{get:key=>key==='SUPABASE_URL'?'https://test.invalid':'test-config'},serve:h=>serve=h},()=>db,
  overrides.runBackup??(async()=>({status:'success'})),overrides.runRestoreDryRun??(async()=>({mode:'dry-run'})),
  value=>value,overrides.createSupabaseBackupDeps??(()=>({db:{readConfig:async()=>({source_git_checkpoint:'a'.repeat(40),spec_checkpoint:'spec'})}})),EdgeRuntime);
 return serve;
}
function projectParser() {
 const source=readFileSync(new URL('../supabase/functions/adma-api/index.ts',import.meta.url),'utf8').replace(/^import .*;\s*$/gm,'');
 const js=stripTypeScriptTypes(source);
 return new Function('Deno','createClient','requireUser','AuthError',`${js}\nreturn projectInput;`)(
  {env:{get:()=> 'test-config'},serve(){}},()=>({}),async()=>actor,AuthError);
}
function stageParser() {
 const source=readFileSync(new URL('../supabase/functions/adma-api/index.ts',import.meta.url),'utf8').replace(/^import .*;\s*$/gm,'');
 const js=stripTypeScriptTypes(source);
 return new Function('Deno','createClient','requireUser','AuthError',`${js}\nreturn stageInput;`)(
  {env:{get:()=> 'test-config'},serve(){}},()=>({}),async()=>actor,AuthError);
}
const request=body=>new Request('https://test.invalid',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(body)});
const actor={id:'existing-user',role:'foreman',is_active:true};
const credentials={action:'set_credentials',login:'ilya',password:'new-password-123',initData:'test'};
test('all modified Edge Functions parse',()=>{
 for(const name of ['adma-api','receipt-upload','reimbursement-pdf','account-admin','web-auth','finance-api','finance-file-upload','masters-api','project-operations-api','project-file-upload','designers-api','leads-api','knowledge-api','knowledge-file-upload','storage-cleanup','backup-adma']){
  const source=readFileSync(new URL(`../supabase/functions/${name}/index.ts`,import.meta.url),'utf8').replace(/^import .*;\s*$/gm,'');
  assert.doesNotThrow(()=>new Function(stripTypeScriptTypes(source)));
 }
});
test('backup function rejects missing and invalid secrets before backup or Storage access',async()=>{
 let created=false,storageTouched=false;const rpcCalls=[];
 const missing=backupHandler({}, {createSupabaseBackupDeps:()=>{created=true;return{};}});
 const missingResponse=await missing(new Request('https://test.invalid',{method:'POST',body:'{"action":"backup"}'}));
 assert.equal(missingResponse.status,401);assert.equal(created,false);

 const db={rpc:async(name)=>{rpcCalls.push(name);return{data:false,error:null};},storage:{from:()=>{storageTouched=true;}}};
 const invalid=backupHandler(db);
 const invalidResponse=await invalid(new Request('https://test.invalid',{method:'POST',headers:{'X-Backup-Secret':'wrong'},body:'{"action":"backup"}'}));
 assert.equal(invalidResponse.status,401);
 assert.deepEqual(rpcCalls,['verify_backup_secret']);
 assert.equal(storageTouched,false);
});
test('backup function schedules backup, runs dry-run synchronously and rejects invalid actions',async()=>{
 const db={rpc:async name=>name==='verify_backup_secret'?{data:true,error:null}:{data:null,error:null}};
 const deps={db:{readConfig:async()=>({source_git_checkpoint:'a'.repeat(40),spec_checkpoint:'spec'})}};
 let pending,backupCalls=0,restoreCalls=0;
 const overrides={createSupabaseBackupDeps:()=>deps,waitUntil:value=>{pending=value;},runBackup:async()=>{backupCalls++;return{status:'success'};},runRestoreDryRun:async()=>{restoreCalls++;return{mode:'dry-run'};}};
 const serve=backupHandler(db,overrides);
 const backup=await serve(new Request('https://test.invalid',{method:'POST',headers:{'X-Backup-Secret':'ok'},body:'{"action":"backup"}'}));
 assert.equal(backup.status,202);await pending;assert.equal(backupCalls,1);
 const restore=await serve(new Request('https://test.invalid',{method:'POST',headers:{'X-Backup-Secret':'ok'},body:JSON.stringify({action:'restore_dry_run',backup_id:'2026-09-11T120000Z_123e4567-e89b-42d3-a456-426614174000'})}));
 assert.equal(restore.status,200);assert.equal(restoreCalls,1);
 const unsupported=await serve(new Request('https://test.invalid',{method:'POST',headers:{'X-Backup-Secret':'ok'},body:'{"action":"delete"}'}));
 assert.equal(unsupported.status,400);
 const nullBody=await serve(new Request('https://test.invalid',{method:'POST',headers:{'X-Backup-Secret':'ok'},body:'null'}));
 assert.equal(nullBody.status,400);
});
test('foreman cannot mutate the global master directory',async()=>{
 for(const body of [{action:'save_master',master:{}},{action:'save_assignment',assignment:{}},{action:'set_master_archived',id:'test'}]){
  const r=await handler('masters-api',{},actor)(request(body));assert.equal(r.status,403);
 }
});
test('foreman cannot load or mutate the designers CRM',async()=>{
 for(const body of [{action:'load'},{action:'save_designer',designer:{}},{action:'add_interaction',interaction:{}}]){
  const r=await handler('designers-api',{},actor)(request(body));assert.equal(r.status,403);
 }
});
test('foreman cannot load, mutate or convert leads',async()=>{
 for(const body of [{action:'load'},{action:'save_lead',lead:{}},{action:'convert_lead',lead_id:'test'}]){
  const r=await handler('leads-api',{},actor)(request(body));assert.equal(r.status,403);
 }
});
test('foreman cannot load or mutate profit data',async()=>{
 for(const body of [{action:'load'},{action:'save_act',act:{}},{action:'save_company_expense',expense:{}}]){
  const r=await handler('finance-api',{},actor)(request(body));assert.equal(r.status,403);
 }
});
test('foreman cannot load or mutate the knowledge base',async()=>{
 for(const body of [{action:'load'},{action:'save_tech_card',tech_card:{}},{action:'save_issue',issue:{}}]){
  const r=await handler('knowledge-api',{},actor)(request(body));assert.equal(r.status,403);
 }
});
test('finance file upload authenticates before storage',async()=>{
 let touched=false;const db={auth:{getUser:async()=>({error:Error('forged')})},storage:{from:()=>{touched=true;}}};
 const form=new FormData();form.append('accessToken','forged');form.append('file',new File(['%PDF'],'act.pdf',{type:'application/pdf'}));
 const r=await handler('finance-file-upload',db)(new Request('https://test.invalid',{method:'POST',body:form}));assert.equal(r.status,401);assert.equal(touched,false);
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
test('project file upload authenticates before touching private storage',async()=>{
 let touched=false;
 const db={auth:{getUser:async()=>({error:Error('forged')})},storage:{from:()=>{touched=true;}}};
 const form=new FormData();form.append('accessToken','forged');form.append('kind','photo');form.append('project_id','11111111-1111-4111-8111-111111111111');form.append('file',new File(['test'],'photo.jpg',{type:'image/jpeg'}));
 const r=await handler('project-file-upload',db)(new Request('https://test.invalid',{method:'POST',body:form}));assert.equal(r.status,401);assert.equal(touched,false);
});
test('knowledge file upload authenticates before touching private storage',async()=>{
 let touched=false;
 const db={auth:{getUser:async()=>({error:Error('forged')})},storage:{from:()=>{touched=true;}}};
 const form=new FormData();form.append('accessToken','forged');form.append('entity','tech_card');form.append('entity_id','11111111-1111-4111-8111-111111111111');form.append('file',new File(['test'],'guide.pdf',{type:'application/pdf'}));
 const r=await handler('knowledge-file-upload',db)(new Request('https://test.invalid',{method:'POST',body:form}));assert.equal(r.status,401);assert.equal(touched,false);
});
test('project metadata is normalized and validated',()=>{
 const parse=projectParser();
 const valid=parse({name:'  Новый объект  ',status:'preparation',area_sqm:'86.5',client_name:' Заказчик ',start_date:'2026-09-10',planned_end_date:'2027-01-20'});
 assert.deepEqual(valid.value,{contract_amount:null,name:'Новый объект',address:null,client_name:'Заказчик',client_phone:null,comment:null,contract_number:null,area_sqm:86.5,start_date:'2026-09-10',planned_end_date:'2027-01-20',actual_end_date:null,warranty_until:null,status:'preparation',designer_id:null});
 assert.equal(parse({name:'Объект',area_sqm:0}).error,'invalid_area');
 assert.equal(parse({name:'Объект',status:'unknown'}).error,'invalid_status');
 assert.equal(parse({name:'Объект',start_date:'2026-10-01',planned_end_date:'2026-09-01'}).error,'invalid_project_dates');
 assert.equal(parse({name:'Объект',comment:'x'.repeat(2001)}).error,'field_too_long');
});
test('foreman cannot create or edit an object',async()=>{
 const create=await handler('adma-api',{},actor)(request({action:'create_project',project:{name:'Запрещено'}}));
 const update=await handler('adma-api',{},actor)(request({action:'update_project',project:{id:'project-1',name:'Запрещено'}}));
 assert.equal(create.status,403);assert.equal(update.status,403);
});
test('project stage metadata is normalized and validated',()=>{
 const parse=stageParser();
 const valid=parse({name:'  Электрика  ',position:10,progress:65,status:'in_progress',planned_start:'2026-09-01',planned_end:'2026-09-20',work_cost:'180000'});
 assert.equal(valid.value.name,'Электрика');assert.equal(valid.value.progress,65);assert.equal(valid.value.work_cost,180000);
 assert.equal(parse({name:'Этап',progress:101}).error,'invalid_stage_progress');
 assert.equal(parse({name:'Этап',status:'unknown'}).error,'invalid_stage_status');
 assert.equal(parse({name:'Этап',planned_start:'2026-10-01',planned_end:'2026-09-01'}).error,'invalid_stage_dates');
 assert.equal(parse({name:'Этап',comment:'x'.repeat(2001)}).error,'field_too_long');
});
test('foreman cannot create, edit or delete schedule stages',async()=>{
 for(const body of [
  {action:'create_stage',stage:{project_id:'project-1',name:'Запрещено'}},
  {action:'update_stage',stage:{id:'stage-1',progress:50}},
  {action:'delete_stage',id:'stage-1'},
 ]) assert.equal((await handler('adma-api',{},actor)(request(body))).status,403);
});
