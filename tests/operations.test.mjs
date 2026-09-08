import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

const migration=readFileSync(new URL('../supabase/migrations/20260908090000_add_project_operations_stage6.sql',import.meta.url),'utf8');
const indexMigration=readFileSync(new URL('../supabase/migrations/20260908091000_add_project_photos_stage_index.sql',import.meta.url),'utf8');
const apiSource=readFileSync(new URL('../supabase/functions/project-operations-api/index.ts',import.meta.url),'utf8');
const uploadSource=readFileSync(new URL('../supabase/functions/project-file-upload/index.ts',import.meta.url),'utf8');
const cloud=readFileSync(new URL('../cloud.js',import.meta.url),'utf8');

function parsers(){
 const source=apiSource.replace(/^import .*;\s*$/gm,'');
 return new Function('Deno','createClient','requireUser','AuthError',`${stripTypeScriptTypes(source)}\nreturn {documentInput,taskInput,photoInput};`)({env:{get:()=>''},serve(){}},()=>({}),async()=>({}),class extends Error{});
}

test('stage 6 migration is additive, private and project-scoped',()=>{
 for(const table of ['project_documents','project_tasks','project_photos']){
  assert.match(migration,new RegExp(`create table if not exists public\\.${table}`));
  assert.match(migration,new RegExp(`alter table public\\.${table} enable row level security`));
  assert.match(migration,new RegExp(`project_id uuid not null references public\\.projects\\(id\\) on delete restrict`));
 }
 assert.match(migration,/values \('project-files','project-files',false,10485760/);
 assert.match(migration,/stage_id uuid references public\.project_stages\(id\) on delete set null/);
 assert.match(indexMigration,/create index if not exists idx_project_photos_stage on public\.project_photos\(stage_id\)/);
 assert.doesNotMatch(migration,/drop\s+(table|column)|truncate|delete\s+from/i);
 assert.doesNotMatch(indexMigration,/drop\s+(table|column)|truncate|delete\s+from/i);
});

test('documents, tasks and photos validate canonical metadata',()=>{
 const {documentInput,taskInput,photoInput}=parsers();
 assert.deepEqual(documentInput({title:'  Договор  ',category:'contract',document_date:'2026-09-08'}),{title:'Договор',category:'contract',document_date:'2026-09-08',description:null});
 assert.throws(()=>documentInput({title:'Документ',category:'act'}),/invalid_document_category/);
 const task=taskInput({project_id:'11111111-1111-4111-8111-111111111111',title:'  Позвонить  ',priority:'urgent',status:'in_progress',deadline:'2026-09-09'});
 assert.equal(task.title,'Позвонить');assert.equal(task.priority,'urgent');assert.equal(task.stage_id,null);
 assert.throws(()=>taskInput({...task,status:'overdue'}),/invalid_task_status/);
 assert.deepEqual(photoInput({stage_id:null,caption:'  Стены  ',shot_date:'2026-09-08'}),{stage_id:null,caption:'Стены',shot_date:'2026-09-08'});
});

test('cross-project links and canonical assignees are enforced in API',()=>{
 for(const table of ['project_stages','finance_acts','finance_waybills']) assert.match(apiSource,new RegExp(`checkLink\\('${table.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}'`));
 assert.match(apiSource,/link_project_mismatch/);
 assert.match(apiSource,/assignee_not_on_project/);
 assert.match(apiSource,/master_not_on_project/);
 assert.match(apiSource,/project_members/);
});

test('file bytes use private Storage with cleanup handling',()=>{
 assert.match(uploadSource,/storage\.from\('project-files'\)\.upload/);
 assert.match(uploadSource,/removeStorageObject\(db,'project-files',path\)/);
 assert.match(apiSource,/removeStorageObject\(db,'project-files',old\.storage_path\)/);
 assert.match(apiSource,/cleanup_pending:cleanupPending/);
 assert.match(apiSource,/createSignedUrl\(row\.storage_path,3600\)/);
});

test('frontend scopes modules to the open project and computes overdue tasks',()=>{
 assert.match(cloud,/projectId === project\.id/);
 assert.match(cloud,/function taskBucket\(task/);
 assert.match(cloud,/task\.deadline && task\.deadline < today/);
 assert.match(cloud,/\['completed', 'cancelled'\]\.includes\(task\.status\)/);
 assert.match(cloud,/multiple required/);
 assert.match(cloud,/prepareReceiptFile\(file\)/);
 assert.match(cloud,/Акты и Накладные хранятся в Финансах без дублирования/);
});
