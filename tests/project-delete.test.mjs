import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const sql=readFileSync(new URL('../supabase/migrations/20260912120000_add_project_hard_delete.sql',import.meta.url),'utf8');

test('project hard delete is one service-role-only invoker transaction',()=>{
 assert.match(sql,/create or replace function public\.hard_delete_project\(\s*p_project_id uuid,\s*p_actor_id uuid,\s*p_confirmation text\s*\)/i);
 assert.match(sql,/language plpgsql\s+security invoker\s+set search_path = ''/i);
 assert.match(sql,/from public\.app_users[\s\S]*role = 'owner'[\s\S]*is_active is true/i);
 assert.match(sql,/from public\.projects[\s\S]*where id = p_project_id[\s\S]*for update/i);
 assert.match(sql,/p_confirmation is distinct from v_project_name/i);
 assert.match(sql,/revoke execute on function public\.hard_delete_project\(uuid, uuid, text\) from public, anon, authenticated/i);
 assert.match(sql,/grant execute on function public\.hard_delete_project\(uuid, uuid, text\) to service_role/i);
 assert.doesNotMatch(sql,/security definer/i);
});

test('project hard delete queues every project-owned file class and never backup storage',()=>{
 assert.match(sql,/select e\.receipt_path[^\n]*'receipts'[^\n]*\n\s*from public\.expenses e/i);
 assert.match(sql,/select a\.file_path[^\n]*'finance-documents'[^\n]*\n\s*from public\.finance_acts a/i);
 assert.match(sql,/select w\.file_path[^\n]*'finance-documents'[^\n]*\n\s*from public\.finance_waybills w/i);
 assert.match(sql,/select d\.storage_path[^\n]*'project-files'[^\n]*\n\s*from public\.project_documents d/i);
 assert.match(sql,/select p\.storage_path[^\n]*'project-files'[^\n]*\n\s*from public\.project_photos p/i);
 assert.match(sql,/on conflict \(bucket, object_path\) where completed_at is null do nothing/i);
 assert.doesNotMatch(sql,/adma-backups/i);
 assert.doesNotMatch(sql,/storage\.objects|storage\.buckets/i);
});

test('project hard delete handles RESTRICT children before the project and relies on canonical FK actions',()=>{
 for(const table of ['project_tasks','project_documents','project_photos','master_assignments'])assert.match(sql,new RegExp(`delete from public\\.${table} where project_id = p_project_id`,'i'));
 assert.match(sql,/delete from public\.projects where id = p_project_id/i);
 assert.doesNotMatch(sql,/delete from public\.(leads|expenses|finance_acts|finance_waybills|project_members|project_stages)/i);
 assert.doesNotMatch(sql,/update public\.leads/i);
});
