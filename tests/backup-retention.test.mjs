import test from 'node:test';
import assert from 'node:assert/strict';
import {sealManifest} from '../supabase/functions/_shared/backup/core.mjs';
import {planRetention} from '../supabase/functions/_shared/backup/retention.mjs';
import {runRetention} from '../supabase/functions/_shared/backup/orchestrator.mjs';

const oldBlob='a'.repeat(64);
const sharedBlob=`blobs/sha256/aa/${oldBlob}`;

function backupId(day,index){return `2026-08-${String(day).padStart(2,'0')}T020000Z_00000000-0000-4000-8000-${String(index).padStart(12,'0')}`;}

async function manifest(id,blobPaths=[]){
 const objects=blobPaths.map((path,index)=>({
  source_bucket:'receipts',source_path:`file-${index}.txt`,source_size:1,
  source_mime_type:'text/plain',source_updated_at:'2026-08-01T00:00:00.000Z',source_etag:null,
  source_checksum:path.slice(-64),backup_blob_path:path,backup_checksum:path.slice(-64),
  backed_up_at:'2026-08-01T02:00:00.000Z',
 }));
 return sealManifest({
  format_version:1,implementation_version:'backup-v1',status:'complete',project_ref:'blaacuwwvyatfiyjnsrw',
  environment:'production',backup_id:id,run_id:'223e4567-e89b-42d3-a456-426614174000',
  created_at:'2026-08-01T02:00:00.000Z',started_at:'2026-08-01T02:00:00.000Z',completed_at:'2026-08-01T02:00:01.000Z',
  source_git_checkpoint:'9ddebffea4ced78aa3002f7c1fe5b2d1255fa3e0',spec_checkpoint:'backup-v1-design-2026-09-11',
  database:{table_count:0,row_count:0,bytes:0,tables:[]},
  storage:{file_count:objects.length,bytes:objects.length,objects},
  totals:{bytes:objects.length},duration_ms:1000,warnings:[],errors:[],
 });
}

async function tenRuns(){
 const runs=[];const manifests={};
 for(let index=0;index<10;index++){
  const id=backupId(index+1,index+1);
  manifests[id]=await manifest(id,index===9?[sharedBlob]:[]);
  runs.push({id:manifests[id].run_id,backup_id:id,status:'success',completed_at:`2026-08-${String(index+1).padStart(2,'0')}T02:00:00.000Z`,checksum:manifests[id].integrity_checksum,metadata:{manifest_path:`database/${id}/manifest.json`}});
 }
 return {runs,manifests};
}

test('retention keeps exactly ten successes and never deletes the newest',async()=>{
 const runs=[];const manifests={};const objects=[];
 for(let index=0;index<12;index++){
  const id=backupId(index+1,index+1);
  manifests[id]=await manifest(id);
  runs.push({id:manifests[id].run_id,backup_id:id,status:'success',completed_at:`2026-08-${String(index+1).padStart(2,'0')}T02:00:00.000Z`,checksum:manifests[id].integrity_checksum,metadata:{manifest_path:`database/${id}/manifest.json`}});
  objects.push({path:`database/${id}/manifest.json`,created_at:'2026-08-01T00:00:00.000Z'});
 }
 runs.push({backup_id:backupId(20,99),status:'failed',completed_at:'2026-08-20T02:00:00.000Z'});
 const plan=await planRetention(runs,manifests,objects,new Date('2026-09-11T00:00:00Z'),10,[]);
 assert.equal(plan.retained_backup_ids.length,10);
 assert.ok(plan.retained_backup_ids.includes(backupId(12,12)));
 assert.equal(plan.snapshot_paths_to_delete.includes(`database/${backupId(12,12)}/manifest.json`),false);
 assert.deepEqual(plan.snapshot_paths_to_delete.sort(),[
  `database/${backupId(1,1)}/manifest.json`,`database/${backupId(2,2)}/manifest.json`,
 ].sort());
});

test('shared references stay while only old unreferenced blobs are removable',async()=>{
 const {runs,manifests}=await tenRuns();
 const orphanHash='b'.repeat(64),recentHash='c'.repeat(64);
 const plan=await planRetention(runs,manifests,[
  {path:sharedBlob,created_at:'2026-08-01T00:00:00.000Z'},
  {path:`blobs/sha256/bb/${orphanHash}`,created_at:'2026-08-01T00:00:00.000Z'},
  {path:`blobs/sha256/cc/${recentHash}`,created_at:'2026-09-10T00:00:00.000Z'},
 ],new Date('2026-09-11T00:00:00Z'),10,[]);
 assert.deepEqual(plan.blob_paths_to_delete,[`blobs/sha256/bb/${orphanHash}`]);
});

test('missing or invalid retained manifests disable all blob deletion',async()=>{
 const {runs,manifests}=await tenRuns();
 delete manifests[runs[0].backup_id];
 const orphan=`blobs/sha256/bb/${'b'.repeat(64)}`;
 const missing=await planRetention(runs,manifests,[{path:orphan,created_at:'2026-08-01T00:00:00Z'}],new Date('2026-09-11T00:00:00Z'),10,[]);
 assert.deepEqual(missing.blob_paths_to_delete,[]);
 assert.ok(missing.warnings.includes('blob_cleanup_disabled_invalid_retained_manifest'));

 manifests[runs[0].backup_id]={status:'complete'};
 const invalid=await planRetention(runs,manifests,[{path:orphan,created_at:'2026-08-01T00:00:00Z'}],new Date('2026-09-11T00:00:00Z'),10,[]);
 assert.deepEqual(invalid.blob_paths_to_delete,[]);
});

test('a retained manifest that does not match its run disables blob deletion',async()=>{
 const {runs,manifests}=await tenRuns();
 runs[0].checksum='b'.repeat(64);
 const orphan=`blobs/sha256/cc/${'c'.repeat(64)}`;
 const plan=await planRetention(runs,manifests,[{path:orphan,created_at:'2026-08-01T00:00:00Z'}],new Date('2026-09-11T00:00:00Z'),10,[]);
 assert.deepEqual(plan.blob_paths_to_delete,[]);
 assert.ok(plan.warnings.includes('blob_cleanup_disabled_invalid_retained_manifest'));
});

test('failed or incomplete snapshot objects wait seven days',async()=>{
 const {runs,manifests}=await tenRuns();
 const failed=backupId(20,99);
 runs.push({backup_id:failed,status:'failed',completed_at:'2026-08-20T02:00:00.000Z'});
 const plan=await planRetention(runs,manifests,[
  {path:`database/${failed}/tables/projects/part-000001.ndjson`,created_at:'2026-08-20T02:00:00.000Z'},
  {path:`database/${failed}/manifest.json`,created_at:'2026-09-10T02:00:00.000Z'},
 ],new Date('2026-09-11T00:00:00Z'),10,[]);
 assert.deepEqual(plan.snapshot_paths_to_delete,[`database/${failed}/tables/projects/part-000001.ndjson`]);
});

test('retention does no work without the database maintenance lease',async()=>{
 const events=[];
 const result=await runRetention({beginRetention:async()=>{events.push('begin');return false;}},{list:async()=>{events.push('list');return[];}},new Date(),[]);
 assert.deepEqual(result,{skipped:true,reason:'maintenance_busy'});
 assert.deepEqual(events,['begin']);
});

test('retention always releases an acquired maintenance lease',async()=>{
 const events=[];
 const db={
  beginRetention:async()=>{events.push('begin');return true;},
  listRuns:async()=>{events.push('runs');return[];},
  endRetention:async()=>{events.push('end');return true;},
 };
 const storage={list:async()=>{events.push('list');return[];},download:async()=>{throw new Error('unexpected_download');},remove:async()=>{events.push('remove');}};
 const result=await runRetention(db,storage,new Date('2026-09-11T00:00:00Z'),[]);
 assert.deepEqual(result.retained_backup_ids,[]);
 assert.deepEqual(events,['begin','runs','list','end']);
});

test('retention fails closed on stalled backup-bucket pagination and releases its lease',async()=>{
 const events=[];
 const rows=Array.from({length:1000},(_,index)=>({name:`object-${index}`,id:`id-${index}`,metadata:{}}));
 const db={beginRetention:async()=>true,listRuns:async()=>[],endRetention:async()=>{events.push('end');return true;}};
 const storage={list:async()=>rows,download:async()=>{throw new Error('unexpected_download');},remove:async()=>{events.push('remove');}};
 await assert.rejects(()=>runRetention(db,storage,new Date('2026-09-11T00:00:00Z'),[]),/storage_pagination_stalled/);
 assert.deepEqual(events,['end']);
});
