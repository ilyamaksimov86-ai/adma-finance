import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256Hex} from '../supabase/functions/_shared/backup/core.mjs';
import {runBackup,runRestoreDryRun,assertManifestRunBinding,assertRestoreBounds} from '../supabase/functions/_shared/backup/orchestrator.mjs';

const uuid='123e4567-e89b-42d3-a456-426614174000';
const runId='223e4567-e89b-42d3-a456-426614174000';
const backupId=`2026-09-11T120000Z_${uuid}`;

async function fixture({claimResult='started',failAt=null,clock=()=>0}={}){
 const events=[];const uploads=[];const files=new Map();const logs=[];
 const body='{"id":"project-1"}';
 const checksum=await sha256Hex(body);
 const tableChecksum=await sha256Hex(checksum);
 const chunk={table_name:'projects',chunk_index:0,row_count:1,body,bytes:new TextEncoder().encode(body).byteLength,checksum};
 const table={table_name:'projects',columns:[{name:'id',type:'text',nullable:false,ordinal:1}],numeric_columns:[],primary_key:['id'],foreign_keys:[],row_count:1,bytes:chunk.bytes,part_count:1,checksum:tableChecksum};
 const stop=stage=>{if(failAt===stage)throw new Error(`customer/private/path ${stage}`);};
 const db={
  async claim(_id,force){events.push('claim');stop('claim');return{result:claimResult,run_id:runId,backup_id:_id,force};},
  async prepare(){events.push('prepare-db');stop('prepare-db');return{table_count:1,row_count:1,database_bytes:chunk.bytes};},
  async readChunks(_run,offset){return offset===0?[chunk]:[];},
  async readTables(){return[table];},
  async finish(){events.push('mark-success');stop('mark-success');return true;},
  async fail(){events.push('mark-failed');},
  async clear(){events.push('clear-staging');stop('clear-staging');},
 };
 const storage={
  async upload(bucket,path,bytes,options){
   events.push(path.endsWith('/manifest.json')?'upload-manifest':'upload-db');stop(events.at(-1));
   if(failAt===`hang-${events.at(-1)}`)return new Promise(()=>{});
   uploads.push(path);files.set(`${bucket}/${path}`,bytes instanceof Uint8Array?bytes:new TextEncoder().encode(bytes));
   assert.equal(options.upsert,false);
  },
  async download(bucket,path){
   events.push(path.endsWith('/manifest.json')?'verify-manifest':'verify-db');stop(events.at(-1));
   const value=files.get(`${bucket}/${path}`);if(!value){const error=new Error('missing');error.status=404;throw error;}return value;
  },
 };
 return {events,uploads,logs,deps:{db,storage,clock,uuid:()=>uuid,now:()=>new Date('2026-09-11T12:00:00.000Z'),sourceGitCheckpoint:'9ddebffea4ced78aa3002f7c1fe5b2d1255fa3e0',specCheckpoint:'backup-v1-design-2026-09-11',expectedTables:['projects'],logger:{info:value=>logs.push(value),error:value=>logs.push(value)},backupStorage:async()=>{events.push('backup-storage');stop('backup-storage');return[];},validateStorageEntries:async()=>{events.push('verify-storage');stop('verify-storage');return true;},retention:async()=>{events.push('retention');stop('retention');}}};
}

test('successful backup follows atomic lifecycle order',async()=>{
 const {deps,events}=await fixture();
 const result=await runBackup(deps);
 assert.equal(result.status,'success');
 assert.deepEqual(events,['claim','prepare-db','upload-db','verify-db','backup-storage','verify-storage','upload-manifest','verify-manifest','mark-success','clear-staging','retention']);
});

test('manifest is the last snapshot upload and verification precedes success',async()=>{
 const {deps,uploads,events}=await fixture();
 await runBackup(deps);
 assert.match(uploads.at(-1),/\/manifest\.json$/);
 assert.ok(events.indexOf('verify-manifest')<events.indexOf('mark-success'));
});

test('every stage after a claimed run records failure and never success',async()=>{
 for(const stage of ['prepare-db','upload-db','verify-db','backup-storage','verify-storage','upload-manifest','verify-manifest','mark-success']){
  const {deps,events}=await fixture({failAt:stage});
  const result=await runBackup(deps);
  assert.equal(result.status,'failed',stage);
  assert.equal(events.includes('mark-success'),stage==='mark-success');
  assert.ok(events.includes('mark-failed'),stage);
 }
});

test('a claim transport failure has no run to mark and still returns a technical failure',async()=>{
 const {deps,events}=await fixture({failAt:'claim'});
 const result=await runBackup(deps);
 assert.equal(result.status,'failed');
 assert.deepEqual(events,['claim']);
});

test('recent, already-running and maintenance-busy claims stop before snapshot work',async()=>{
 for(const claimResult of ['skipped_recent','already_running','maintenance_busy']){
  const {deps,events}=await fixture({claimResult});
  const result=await runBackup(deps);
  assert.equal(result.status,claimResult);
  assert.deepEqual(events,['claim']);
 }
});

test('force is passed only to claim and cannot bypass an active run',async()=>{
 const {deps,events}=await fixture({claimResult:'already_running'});
 let forced=false;const claim=deps.db.claim;
 deps.db.claim=async(id,force)=>{forced=force;return claim(id,force);};
 const result=await runBackup(deps,{force:true});
 assert.equal(forced,true);assert.equal(result.status,'already_running');assert.deepEqual(events,['claim']);
});

test('internal deadline fails before an incomplete snapshot can succeed',async()=>{
 let tick=0;
 const {deps,events}=await fixture({clock:()=>tick++===0?0:200000});
 const result=await runBackup(deps,{deadlineMs:135000});
 assert.equal(result.status,'failed');
 assert.equal(events.includes('mark-success'),false);
 assert.ok(events.includes('mark-failed'));
});

test('a hung storage operation is bounded by the internal deadline',async()=>{
 const {deps,events}=await fixture({failAt:'hang-upload-db',clock:Date.now});
 const started=Date.now();
 const result=await runBackup(deps,{deadlineMs:20});
 assert.equal(result.status,'failed');
 assert.equal(result.code,'backup_deadline_exceeded');
 assert.ok(Date.now()-started<500);
 assert.equal(events.includes('mark-success'),false);
 assert.ok(events.includes('mark-failed'));
});

test('technical responses and logs never contain customer data',async()=>{
 const {deps,logs}=await fixture({failAt:'upload-db'});
 const result=await runBackup(deps);
 const output=JSON.stringify({result,logs});
 assert.doesNotMatch(output,/customer|private\/path/);
 assert.deepEqual(Object.keys(result).sort(),['backup_id','code','message','run_id','status']);
 assert.ok(result.message.length<=1000);
});

test('restore manifest must match the successful run identity, checksum and path',()=>{
 const checksum='a'.repeat(64);
 const path='database/2026-09-11T120000Z_123e4567-e89b-42d3-a456-426614174000/manifest.json';
 const run={id:runId,backup_id:backupId,checksum,metadata:{manifest_path:path}};
 const manifest={run_id:runId,backup_id:backupId,integrity_checksum:checksum};
 assert.equal(assertManifestRunBinding(manifest,run,path),true);
 assert.throws(()=>assertManifestRunBinding({...manifest,run_id:uuid},run,path),/manifest_run_mismatch/);
 assert.throws(()=>assertManifestRunBinding({...manifest,integrity_checksum:'b'.repeat(64)},run,path),/manifest_run_mismatch/);
 assert.throws(()=>assertManifestRunBinding(manifest,{...run,metadata:{manifest_path:'database/other/manifest.json'}},path),/manifest_run_mismatch/);
});

test('restore rejects backups outside the bounded v1 validation envelope',()=>{
 const manifest={database:{row_count:1,bytes:1,tables:[{parts:[{}]}]},storage:{file_count:1,bytes:1,objects:[{}]},totals:{bytes:2}};
 assert.equal(assertRestoreBounds(manifest),true);
 assert.throws(()=>assertRestoreBounds({...manifest,database:{...manifest.database,row_count:500001}}),/restore_row_limit/);
 assert.throws(()=>assertRestoreBounds({...manifest,database:{...manifest.database,tables:[{parts:Array(20001)}]}}),/restore_part_limit/);
 assert.throws(()=>assertRestoreBounds({...manifest,storage:{...manifest.storage,file_count:10001}}),/restore_object_limit/);
 assert.throws(()=>assertRestoreBounds({...manifest,totals:{bytes:128*1024*1024+1}}),/restore_byte_limit/);
});

test('restore bounds a hung storage download with the internal deadline',async()=>{
 const deps={
  clock:Date.now,
  db:{findSuccessfulRun:async()=>({id:runId,backup_id:backupId,checksum:'a'.repeat(64),metadata:{manifest_path:`database/${backupId}/manifest.json`}})},
  storage:{download:async()=>new Promise(()=>{})},
 };
 const started=Date.now();
 await assert.rejects(()=>runRestoreDryRun(deps,backupId,{deadlineMs:20}),/backup_deadline_exceeded/);
 assert.ok(Date.now()-started<500);
});
