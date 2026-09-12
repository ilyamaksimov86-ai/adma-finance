import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const sql=readFileSync(new URL('../supabase/migrations/20260911123020_add_backup_v1.sql',import.meta.url),'utf8');

const includedTables=[
 'app_users','company_expenses','designer_interactions','designers','expenses',
 'finance_act_costs','finance_act_payments','finance_acts',
 'finance_waybill_payments','finance_waybills','knowledge_attachments',
 'knowledge_issues','knowledge_tech_cards','knowledge_tech_checklist_items',
 'lead_interactions','leads','master_assignments','masters','project_documents',
 'project_members','project_photos','project_stages','project_tasks','projects',
];

test('backup migration is additive and service-only',()=>{
 assert.match(sql,/create table public\.backup_runs/);
 assert.match(sql,/alter table public\.backup_runs enable row level security/);
 assert.match(sql,/revoke all on table public\.backup_runs from public, anon, authenticated/);
 assert.match(sql,/grant select, insert, update, delete on table public\.backup_runs to service_role/);
 assert.doesNotMatch(sql,/drop\s+(table|column)|truncate\s+table/i);
 assert.doesNotMatch(sql,/insert\s+into\s+public\.(?!backup_runs)/i);
});

test('registry classifies every approved public table and no system schema',()=>{
 for(const table of includedTables){
  assert.match(sql,new RegExp(`\\('${table}',true`),`${table} must be included`);
 }
 assert.match(sql,/\('backup_runs',false,[^\n]*'internal backup metadata'/);
 assert.match(sql,/\('storage_cleanup_queue',false,[^\n]*'internal cleanup queue'/);
 assert.doesNotMatch(sql,/\('(auth|storage|realtime|vault|cron)\./);
 assert.match(sql,/unclassified public tables/i);
 assert.match(sql,/(password|token|secret|credential|session|key)/i);
});

test('private registry and staging preserve bounded checked chunks',()=>{
 assert.match(sql,/create schema if not exists private/);
 assert.match(sql,/create table private\.backup_table_registry/);
 assert.match(sql,/create table private\.backup_snapshot_chunks/);
 assert.match(sql,/primary key \(run_id,table_name,chunk_index\)/);
 assert.match(sql,/row_count integer not null/);
 assert.match(sql,/body text not null/);
 assert.match(sql,/bytes bigint not null/);
 assert.match(sql,/checksum text not null check \(checksum ~ '\^\[0-9a-f\]\{64\}\$'\)/);
 assert.match(sql,/revoke all on (schema|all tables in schema) private from public, anon, authenticated/);
});

test('claim and terminal RPCs enforce concurrency, age and safe failure',()=>{
 assert.match(sql,/create unique index backup_runs_one_running_uidx[\s\S]*where status = 'running'/);
 assert.match(sql,/interval '15 minutes'/);
 assert.match(sql,/interval '72 hours'/);
 assert.match(sql,/skipped_recent/);
 assert.match(sql,/already_running/);
 assert.match(sql,/left\([\s\S]*1000\)/);
 assert.match(sql,/where id = p_run_id[\s\S]*and status = 'running'/);
 assert.match(sql,/p_checksum is null[\s\S]*p_duration_ms is null/);
 assert.match(sql,/p_table_count\s*<>\s*24/);
 assert.match(sql,/status <> 'success'[\s\S]*checksum is not null[\s\S]*duration_ms is not null/);
});

test('backup claims and retention share a fail-closed maintenance lease',()=>{
 assert.match(sql,/create table private\.backup_maintenance_state[\s\S]*retention_started_at timestamptz[\s\S]*retention_owner uuid/);
 assert.match(sql,/claim_backup_run[\s\S]*retention_started_at[\s\S]*maintenance_busy/);
 assert.match(sql,/create or replace function public\.begin_backup_retention\(\)[\s\S]*returns uuid[\s\S]*retention_owner/);
 assert.match(sql,/create or replace function public\.end_backup_retention\(p_owner uuid\)[\s\S]*retention_owner = p_owner/);
 assert.match(sql,/revoke all on function public\.begin_backup_retention\(\)/);
 assert.match(sql,/grant execute on function public\.begin_backup_retention\(\) to service_role/);
 assert.match(sql,/revoke all on function public\.end_backup_retention\(uuid\)/);
 assert.match(sql,/grant execute on function public\.end_backup_retention\(uuid\) to service_role/);
});

test('snapshot RPC captures all business tables in one statement snapshot',()=>{
 assert.match(sql,/create or replace function private\.assert_backup_snapshot_contract\(\)[\s\S]*language plpgsql[\s\S]*stable/i);
 assert.match(sql,/create or replace function private\.read_backup_table_snapshot[\s\S]*language plpgsql[\s\S]*stable/i);
 assert.match(sql,/insert into private\.backup_snapshot_chunks[\s\S]*private\.assert_backup_snapshot_contract\(\)[\s\S]*cross join lateral private\.read_backup_table_snapshot/i);
 assert.doesNotMatch(sql,/set default_transaction_isolation to 'repeatable read'/);
 assert.match(sql,/set timezone = 'UTC'/);
 assert.match(sql,/numeric[\s\S]*::text/i);
 assert.match(sql,/digest\([\s\S]*'sha256'/i);
 assert.match(sql,/order by[\s\S]*primary/i);
 assert.match(sql,/\(rn-1\)\/500/);
 assert.match(sql,/json_build_object/i);
 assert.match(sql,/'columns',[\s\S]*con\.conkey[\s\S]*'referenced_columns',[\s\S]*con\.confkey/i);
 assert.match(sql,/raise exception 'snapshot table set mismatch'/);
 assert.match(sql,/array\[[\s\S]*'app_users'[\s\S]*'projects'[\s\S]*\]::text\[\]/);
 assert.match(sql,/format\([\s\S]*%I/);
 assert.match(sql,/set search_path = ''/);
});

test('secret-column guard covers explicit credential and signing key names',()=>{
 const helper=sql.match(/create or replace function private\.read_backup_table_snapshot[\s\S]*?\n\$\$;/i)?.[0]??'';
 for(const name of ['encryption_key','private_key','signing_key','jwt','session']){
  assert.match(sql,new RegExp(name),`${name} must be guarded`);
  assert.match(helper,new RegExp(name),`${name} must be guarded inside the statement-snapshot reader`);
 }
});

test('snapshot readers are registry-bound and service-only',()=>{
 for(const fn of [
  'claim_backup_run','prepare_backup_snapshot','read_backup_snapshot_chunks',
  'read_backup_snapshot_tables','read_backup_table_page','verify_backup_secret',
  'finish_backup_run','fail_backup_run','clear_backup_snapshot','read_backup_live_schema',
  'read_backup_config','record_backup_restore_dry_run',
 ]){
  assert.match(sql,new RegExp(`revoke all on function public\\.${fn}\\(`),`${fn} must revoke PUBLIC execution`);
  assert.match(sql,new RegExp(`grant execute on function public\\.${fn}\\(`),`${fn} must grant service role execution`);
 }
 assert.match(sql,/read_backup_table_page[\s\S]*backup_table_registry[\s\S]*included/i);
 assert.match(sql,/p_limit[\s\S]*between 1 and 25/i);
 assert.match(sql,/assert_backup_restore_row_size[\s\S]*262144/i);
 assert.match(sql,/read_backup_snapshot_chunks\(p_run_id uuid,p_offset integer default 0,p_limit integer default 100\)/);
 assert.match(sql,/p_limit not between 1 and 100/);
 assert.match(sql,/backup_config[\s\S]*source_git_checkpoint text[\s\S]*spec_checkpoint text/);
 assert.match(sql,/metadata = metadata \|\| jsonb_build_object\('restore_dry_run',p_result\)/);
 assert.match(sql,/read_backup_live_schema\(\)[\s\S]*unclassified public tables[\s\S]*return query/i);
});

test('backup bucket and daily vault-authenticated cron are private',()=>{
 assert.match(sql,/values \('adma-backups','adma-backups',false/);
 assert.match(sql,/vault\.create_secret[\s\S]*backup_cron_secret/);
 assert.match(sql,/cron\.schedule\([\s\S]*'backup-adma-daily-check'[\s\S]*'43 2 \* \* \*'/);
 assert.match(sql,/X-Backup-Secret/);
 assert.match(sql,/timeout_milliseconds := 30000/);
 assert.equal((sql.match(/url := 'https:\/\/blaacuwwvyatfiyjnsrw\.supabase\.co\/functions\/v1\/backup-adma'/g)??[]).length,1);
 assert.doesNotMatch(sql,/create policy[\s\S]*adma-backups/i);
});
