import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {removeStorageObject} from '../supabase/functions/_shared/storage-cleanup.mjs';

const migration=readFileSync(new URL('../supabase/migrations/20260908190000_add_storage_cleanup_queue.sql',import.meta.url),'utf8');
const worker=readFileSync(new URL('../supabase/functions/storage-cleanup/index.ts',import.meta.url),'utf8');
const adma=readFileSync(new URL('../supabase/functions/adma-api/index.ts',import.meta.url),'utf8');
const finance=readFileSync(new URL('../supabase/functions/finance-api/index.ts',import.meta.url),'utf8');
const operations=readFileSync(new URL('../supabase/functions/project-operations-api/index.ts',import.meta.url),'utf8');
const knowledge=readFileSync(new URL('../supabase/functions/knowledge-api/index.ts',import.meta.url),'utf8');

function cleanupHandler(db){
 let serve;
 const source=worker.replace(/^import .*;\s*$/gm,'');
 new Function('Deno','createClient',stripTypeScriptTypes(source))(
  {env:{get:()=> 'test-config'},serve:handler=>serve=handler},()=>db);
 return serve;
}

test('successful storage deletion does not enqueue cleanup',async()=>{
 let queued=false;
 const db={storage:{from:()=>({remove:async()=>({error:null})})},from:()=>{queued=true;}};
 assert.equal(await removeStorageObject(db,'receipts','user/receipt.jpg'),false);
 assert.equal(queued,false);
});

test('failed storage deletion is durably queued without exposing the path',async()=>{
 let row;
 const db={
  storage:{from:()=>({remove:async()=>({error:new Error('temporary storage failure')})})},
  from:table=>({insert:async value=>{assert.equal(table,'storage_cleanup_queue');row=value;return{error:null};}}),
 };
 assert.equal(await removeStorageObject(db,'project-files','project/photo.jpg'),true);
 assert.equal(row.bucket,'project-files');
 assert.equal(row.object_path,'project/photo.jpg');
 assert.match(row.last_error,/temporary storage failure/);
});

test('backup bucket is never removed or queued',async()=>{
 let touched=false;
 const db={storage:{from:()=>{touched=true;}},from:()=>{touched=true;}};
 await assert.rejects(removeStorageObject(db,'adma-backups','blobs/sha256/aa/hash'),/protected_bucket/);
 assert.equal(touched,false);
});

test('cleanup worker permanently rejects a crafted backup-bucket job without removal',async()=>{
 let removed=false,update;
 const queue={
  select:()=>({is:()=>({lte:()=>({order:()=>({limit:async()=>({data:[{id:'job-1',bucket:'adma-backups',object_path:'blobs/sha256/aa/hash',attempts:0}],error:null})})})})}),
  update:value=>{update=value;return{eq:()=>({is:async()=>({error:null})})};},
 };
 const db={rpc:async()=>({data:true,error:null}),from:()=>queue,storage:{from:()=>({remove:async()=>{removed=true;return{error:null};}})}};
 const response=await cleanupHandler(db)(new Request('https://test.invalid',{method:'POST',headers:{'X-Cleanup-Secret':'valid'}}));
 assert.equal(response.status,200);assert.equal(removed,false);
 assert.equal(update.last_error,'protected_bucket');assert.ok(update.completed_at);
});

test('cleanup migration is additive, private, indexed and hourly',()=>{
 assert.match(migration,/create table if not exists public\.storage_cleanup_queue/);
 assert.match(migration,/enable row level security/);
 assert.match(migration,/revoke all on table public\.storage_cleanup_queue from anon, authenticated/);
 assert.match(migration,/storage_cleanup_queue_pending_path_uidx/);
 assert.match(migration,/vault\.create_secret/);
 assert.match(migration,/cron\.schedule\([\s\S]*'storage-cleanup-hourly'/);
 assert.match(migration,/'17 \* \* \* \*'/);
 assert.doesNotMatch(migration,/drop\s+(table|column)|truncate\s+table/i);
});

test('cleanup worker requires a private secret and uses idempotent retries',()=>{
 assert.match(worker,/x-cleanup-secret/);
 assert.match(worker,/verify_storage_cleanup_secret/);
 assert.match(worker,/\.is\('completed_at',null\)/);
 assert.match(worker,/\.remove\(\[job\.object_path\]\)/);
 assert.match(worker,/Math\.min\(24 \* 60/);
 assert.doesNotMatch(worker,/console\.log\([^\n]*object_path/);
});

test('all storage-backed delete APIs use the durable helper',()=>{
 assert.match(adma,/removeStorageObject\(db,"receipts",old\.receipt_path\)/);
 assert.match(finance,/removeStorageObject\(db,'finance-documents',path\)/);
 assert.match(operations,/removeStorageObject\(db,'project-files',old\.storage_path\)/);
 assert.match(knowledge,/removeStorageObject\(db,'knowledge-files',file\.storage_path\)/);
});
