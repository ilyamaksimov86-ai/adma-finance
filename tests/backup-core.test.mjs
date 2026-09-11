import test from 'node:test';
import assert from 'node:assert/strict';
import {
 generateBackupId,assertBackupId,stableStringify,sha256Hex,backupEligibility,
 sealManifest,validateManifest,safeBackupError,
} from '../supabase/functions/_shared/backup/core.mjs';

const uuid='123e4567-e89b-42d3-a456-426614174000';
const backupId='2026-09-11T120000Z_123e4567-e89b-42d3-a456-426614174000';
const hashA='a'.repeat(64);
const tableHash='ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb';

function draftManifest(){
 return {
  format_version:1,
  implementation_version:'backup-v1',
  status:'complete',
  project_ref:'blaacuwwvyatfiyjnsrw',
  backup_id:backupId,
  created_at:'2026-09-11T12:00:00.000Z',
  source_git_checkpoint:'9ddebffea4ced78aa3002f7c1fe5b2d1255fa3e0',
  database:{
   table_count:1,row_count:1,bytes:20,
   tables:[{
    table_name:'projects',row_count:1,bytes:20,part_count:1,checksum:tableHash,
    columns:[{name:'id',type:'uuid',nullable:false,ordinal:1}],
    numeric_columns:[],primary_key:['id'],foreign_keys:[],
    parts:[{path:`database/${backupId}/tables/projects/part-000001.ndjson`,row_count:1,bytes:20,checksum:hashA}],
   }],
  },
  storage:{
   file_count:1,bytes:12,
   objects:[{
    source_bucket:'receipts',source_path:'user/receipt.jpg',source_size:12,
    source_mime_type:'image/jpeg',source_updated_at:'2026-09-11T11:00:00.000Z',
    source_etag:'etag',source_checksum:hashA,
    backup_blob_path:`blobs/sha256/aa/${hashA}`,backup_checksum:hashA,
    backed_up_at:'2026-09-11T12:00:01.000Z',
   }],
  },
 };
}

test('backup ids are sortable UTC values and reject traversal',()=>{
 assert.equal(generateBackupId(new Date('2026-09-11T12:34:56.789Z'),uuid),`2026-09-11T123456Z_${uuid}`);
 assert.equal(assertBackupId(backupId),backupId);
 for(const invalid of ['../manifest','x/../../y',`${backupId}/child`,'2026-09-11T120000Z_not-a-uuid']){
  assert.throws(()=>assertBackupId(invalid),/invalid_backup_id/);
 }
});

test('stable JSON recursively orders object keys, preserves arrays and decimal strings',()=>{
 const row={amount:'9007199254740993.17',nullable:null,flags:[true,false],meta:{z:1,a:'x'}};
 assert.equal(stableStringify(row),'{"amount":"9007199254740993.17","flags":[true,false],"meta":{"a":"x","z":1},"nullable":null}');
 assert.equal(JSON.parse(stableStringify(row)).amount,'9007199254740993.17');
 assert.throws(()=>stableStringify({amount:Number.POSITIVE_INFINITY}),/non_finite_number/);
});

test('SHA-256 is deterministic for text and bytes',async()=>{
 const expected='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
 assert.equal(await sha256Hex('abc'),expected);
 assert.equal(await sha256Hex(new TextEncoder().encode('abc')),expected);
});

test('backup eligibility skips under 72 hours and allows the boundary',()=>{
 const now=new Date('2026-09-11T12:00:00.000Z');
 assert.equal(backupEligibility(null,now),true);
 assert.equal(backupEligibility('2026-09-08T12:00:00.001Z',now),false);
 assert.equal(backupEligibility('2026-09-08T12:00:00.000Z',now),true);
});

test('manifest sealing is deterministic and detects tampering',async()=>{
 const first=await sealManifest(draftManifest());
 const second=await sealManifest(structuredClone(draftManifest()));
 assert.equal(first.integrity_checksum,second.integrity_checksum);
 assert.equal(await validateManifest(first),true);
 first.database.tables[0].parts[0].bytes=21;
 await assert.rejects(()=>validateManifest(first),/manifest_integrity_mismatch/);
});

test('manifest validation requires exact fields, counts, sizes, paths and hashes',async()=>{
 const missing=draftManifest();
 delete missing.project_ref;
 await assert.rejects(async()=>validateManifest(await sealManifest(missing)),/invalid_project_ref/);

 const wrongCount=draftManifest();
 wrongCount.database.row_count=2;
 await assert.rejects(async()=>validateManifest(await sealManifest(wrongCount)),/database_row_count_mismatch/);

 const wrongPath=draftManifest();
 wrongPath.database.tables[0].parts[0].path='../part.ndjson';
 await assert.rejects(async()=>validateManifest(await sealManifest(wrongPath)),/invalid_database_part_path/);
});

test('manifest forbids recursive backup sources',async()=>{
 const recursive=draftManifest();
 recursive.storage.objects[0].source_bucket='adma-backups';
 await assert.rejects(async()=>validateManifest(await sealManifest(recursive)),/invalid_source_bucket/);
});

test('safe errors are bounded, single-line and redact obvious credentials',()=>{
 const safe=safeBackupError(new Error(`Bearer super-secret-token\n${'x'.repeat(1200)}`));
 assert.ok(safe.length<=1000);
 assert.doesNotMatch(safe,/super-secret-token|\n/);
 assert.match(safe,/\[REDACTED\]/);
});
