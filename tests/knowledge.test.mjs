import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

const migration=readFileSync(new URL('../supabase/migrations/20260909010000_add_knowledge_base_v1.sql',import.meta.url),'utf8');
const api=readFileSync(new URL('../supabase/functions/knowledge-api/index.ts',import.meta.url),'utf8');
const upload=readFileSync(new URL('../supabase/functions/knowledge-file-upload/index.ts',import.meta.url),'utf8');
const cloud=readFileSync(new URL('../cloud.js',import.meta.url),'utf8');
const frontend=readFileSync(new URL('../src/cloud/knowledge.fragment.js',import.meta.url),'utf8');

function parsers(){const source=api.replace(/^import .*;\s*$/gm,'');return new Function('Deno','createClient','requireUser','AuthError','removeStorageObject',`${stripTypeScriptTypes(source)}\nreturn {techInput,issueInput,checklistInput};`)({env:{get:()=>''},serve(){}},()=>({}),async()=>({}),class extends Error{},async()=>false)}

test('knowledge migration is additive, normalized and private',()=>{
 for(const table of ['knowledge_tech_cards','knowledge_tech_checklist_items','knowledge_issues','knowledge_attachments']){
  assert.match(migration,new RegExp(`create table if not exists public\\.${table}`));
  assert.match(migration,new RegExp(`alter table public\\.${table} enable row level security`));
 }
 assert.match(migration,/revoke all on table[\s\S]*from public, anon, authenticated/);
 assert.match(migration,/values \('knowledge-files','knowledge-files',false,10485760/);
 assert.match(migration,/knowledge_attachments_owner_check/);
 assert.doesNotMatch(migration,/project_id|master_id|designer_id|lead_id|stage_id/);
 assert.doesNotMatch(migration,/drop\s+(table|column)|truncate|delete\s+from/i);
});

test('tech cards, checklist templates and issues validate fields',()=>{
 const {techInput,issueInput,checklistInput}=parsers();
 assert.deepEqual(techInput({title:'  Штукатурка  ',category:' Стены ',description:' Технология '}),{title:'Штукатурка',category:'Стены',description:'Технология'});
 assert.deepEqual(checklistInput([{text:' Проверить основание '},{item_text:' Загрунтовать '}]),[{item_text:'Проверить основание',position:0},{item_text:'Загрунтовать',position:1}]);
 assert.throws(()=>checklistInput(Array.from({length:101},()=>({text:'x'}))),/checklist_too_long/);
 assert.throws(()=>techInput({title:'',category:'Электрика'}),/required_field/);
 assert.equal(issueInput({title:'Трещина',category:'ГКЛ',problem:' Что произошло '}).problem,'Что произошло');
});

test('knowledge files use signed private access and durable cleanup',()=>{
 assert.match(upload,/storage\.from\('knowledge-files'\)\.upload/);
 assert.match(upload,/removeStorageObject\(db,'knowledge-files',path\)/);
 assert.match(api,/action==='get_file_url'/);
 assert.match(api,/createSignedUrl\(file\.data\.storage_path,3600\)/);
 assert.doesNotMatch(api,/attachments:await/);
 assert.match(api,/removeStorageObject\(db,'knowledge-files',file\.storage_path\)/);
 assert.match(api,/delete_attachment/);
});

test('frontend exposes only V1 knowledge capabilities',()=>{
 assert.match(cloud,/Техкарты/);assert.match(cloud,/Косяки/);assert.match(cloud,/Шаблон инструкции без отметок выполнения/);
 assert.match(cloud,/knowledgeSearch/);assert.match(cloud,/knowledgeCategory/);assert.match(cloud,/data-move="up"/);assert.match(cloud,/data-move="down"/);
 assert.doesNotMatch(frontend,/\b(?:AI|RAG|рейтинг|утверждено)\b/i);
});
