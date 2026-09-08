import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

const migration=readFileSync(new URL('../supabase/migrations/20260908010000_add_masters_stage5.sql',import.meta.url),'utf8');
const apiSource=readFileSync(new URL('../supabase/functions/masters-api/index.ts',import.meta.url),'utf8');
const cloud=readFileSync(new URL('../cloud.js',import.meta.url),'utf8');

function parsers(){
 const source=apiSource.replace(/^import .*;\s*$/gm,'');
 return new Function('Deno','createClient','requireUser','AuthError',`${stripTypeScriptTypes(source)}\nreturn {masterInput,assignmentInput};`)({env:{get:()=>''},serve(){}},()=>({}),async()=>({}),class extends Error{});
}

test('stage 5 migration is additive, private and keeps assignment history',()=>{
 for(const table of ['masters','master_assignments']){
  assert.match(migration,new RegExp(`create table if not exists public\\.${table}`));
  assert.match(migration,new RegExp(`alter table public\\.${table} enable row level security`));
 }
 assert.match(migration,/stage_id uuid references public\.project_stages\(id\) on delete set null/);
 assert.match(migration,/master_id uuid not null references public\.masters\(id\) on delete restrict/);
 assert.match(migration,/project_id uuid not null references public\.projects\(id\) on delete restrict/);
 assert.match(migration,/idx_master_assignments_master_status_dates/);
 assert.doesNotMatch(migration,/drop\s+(table|column)|truncate|delete\s+from/i);
});

test('master fields and assignment dates are normalized and validated',()=>{
 const {masterInput,assignmentInput}=parsers();
 const master=masterInput({name:'  Иван  ',primary_specialty:'tile',additional_skills:['plumbing','tile','plumbing'],rating:'4.5',price_level:'high'});
 assert.equal(master.name,'Иван');assert.deepEqual(master.additional_skills,['plumbing']);assert.equal(master.rating,4.5);
 assert.throws(()=>masterInput({name:'Иван',primary_specialty:'unknown'}),/invalid_specialty/);
 assert.throws(()=>masterInput({name:'Иван',rating:6}),/invalid_rating/);
 const assignment=assignmentInput({master_id:'11111111-1111-4111-8111-111111111111',project_id:'22222222-2222-4222-8222-222222222222',stage_id:null,start_date:'2026-09-10',planned_end_date:'2026-09-20',status:'active'});
 assert.equal(assignment.stage_id,null);assert.equal(assignment.status,'active');
 assert.throws(()=>assignmentInput({...assignment,planned_end_date:'2026-09-01'}),/invalid_assignment_dates/);
});

test('availability, conflict warning and canonical assignment links are wired',()=>{
 assert.match(cloud,/function masterAvailability\(masterId\)/);
 assert.match(cloud,/\['planned','active'\]\.includes\(item\.status\)/);
 assert.match(cloud,/assignment_conflict/);
 assert.match(apiSource,/neq\('project_id',value\.project_id\)/);
 assert.match(apiSource,/stage\.project_id!==value\.project_id/);
 assert.match(apiSource,/status:'cancelled'/);
 assert.match(cloud,/filter\(x=>x\.projectId===p\.id&&x\.status!=='cancelled'\)/);
});
