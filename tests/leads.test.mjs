import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

const migration=readFileSync(new URL('../supabase/migrations/20260908150000_add_leads_crm_stage8.sql',import.meta.url),'utf8');
const apiSource=readFileSync(new URL('../supabase/functions/leads-api/index.ts',import.meta.url),'utf8');
const cloud=readFileSync(new URL('../cloud.js',import.meta.url),'utf8');

function parsers(){const source=apiSource.replace(/^import .*;\s*$/gm,'');return new Function('Deno','createClient','requireUser','AuthError',`${stripTypeScriptTypes(source)}\nreturn {leadInput,projectInput,normalizedPhone};`)({env:{get:()=>''},serve(){}},()=>({}),async()=>({}),class extends Error{})}

test('stage 8 migration is additive, private and uses canonical foreign keys',()=>{
 assert.match(migration,/create table if not exists public\.leads/);assert.match(migration,/create table if not exists public\.lead_interactions/);
 assert.match(migration,/designer_id uuid references public\.designers\(id\)/);assert.match(migration,/project_id uuid unique references public\.projects\(id\)/);
 assert.match(migration,/alter table public\.leads enable row level security/);assert.match(migration,/revoke all on table public\.leads,public\.lead_interactions from public,anon,authenticated/);
 assert.doesNotMatch(migration,/drop\s+(table|column)|truncate|delete\s+from/i);
});

test('lead metadata requires designer source and loss reason',()=>{
 const {leadInput,projectInput,normalizedPhone}=parsers();const value=leadInput({client_name:' Иван ',project_name:' ЖК Тест ',source:'designer',designer_id:'11111111-1111-4111-8111-111111111111',status:'new',phone:'+7 (900) 111-22-33'});
 assert.equal(value.client_name,'Иван');assert.equal(value.designer_id,'11111111-1111-4111-8111-111111111111');assert.equal(normalizedPhone(value.phone),'79001112233');
 assert.throws(()=>leadInput({client_name:'Иван',project_name:'ЖК',source:'designer'}),/invalid_id/);assert.throws(()=>leadInput({client_name:'Иван',project_name:'ЖК',status:'lost'}),/loss_reason_required/);
 assert.equal(projectInput({name:'ЖК',status:'preparation',area_sqm:'86'}).area_sqm,86);assert.throws(()=>projectInput({name:'ЖК',area_sqm:0}),/invalid_number/);
});

test('contact and project conversion business rules live in backend',()=>{
 assert.match(migration,/select \* into target from public\.leads where id=p_lead_id for update/);assert.match(migration,/lead_already_converted/);assert.match(migration,/if target\.status<>'contract'/);
 assert.match(migration,/insert into public\.projects/);assert.match(migration,/update public\.leads set project_id=new_project\.id/);assert.match(migration,/return to_jsonb\(new_project\)/);assert.match(migration,/status='has_project'/);
 assert.match(migration,/status='referred_lead'/);assert.match(migration,/sync_lead_last_contact/);assert.match(apiSource,/db\.rpc\('convert_lead_to_project'/);
});

test('frontend computes overdue state and reuses linked entities',()=>{
 assert.match(cloud,/const leadOverdue=x=>/);assert.match(cloud,/x\.status==='lost'\|\|\(x\.status==='contract'&&x\.projectId\)/);assert.match(cloud,/designer_id:form\.elements\.source\.value==='designer'/);
 assert.match(cloud,/data-open-linked/);assert.match(cloud,/leadView==='funnel'/);assert.match(cloud,/possible_duplicate/);
});
