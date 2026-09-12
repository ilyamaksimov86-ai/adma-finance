import test from 'node:test';
import assert from 'node:assert/strict';
import {sealManifest,sha256Hex,stableStringify} from '../supabase/functions/_shared/backup/core.mjs';
import {topologicalTableOrder,classifyRows,classifyStorage,buildRestoreDryRun} from '../supabase/functions/_shared/backup/restore.mjs';
import {spawnSync} from 'node:child_process';
import {buildRequest,parseArgs,selectAggregateOutput} from '../scripts/backup-restore.mjs';

const backupId='2026-09-11T120000Z_123e4567-e89b-42d3-a456-426614174000';

async function fixture({parentId='p1'}={}){
 const parent={id:'p1',name:'Parent'};
 const child={id:'c1',parent_id:parentId,amount:'9007199254740993.17'};
 const tables=[
  {table_name:'parents',columns:[{name:'id',type:'text',nullable:false,ordinal:1},{name:'name',type:'text',nullable:false,ordinal:2}],numeric_columns:[],primary_key:['id'],foreign_keys:[]},
  {table_name:'children',columns:[{name:'id',type:'text',nullable:false,ordinal:1},{name:'parent_id',type:'text',nullable:false,ordinal:2},{name:'amount',type:'numeric',nullable:false,ordinal:3}],numeric_columns:['amount'],primary_key:['id'],foreign_keys:[{name:'children_parent_fk',columns:['parent_id'],referenced_schema:'public',referenced_table:'parents',referenced_columns:['id']}]},
 ];
 const databaseParts={};
 for(const table of tables){
  const row=table.table_name==='parents'?parent:child;
  const body=stableStringify(row);
  const path=`database/${backupId}/tables/${table.table_name}/part-000001.ndjson`;
  const checksum=await sha256Hex(body);
  table.row_count=1;table.bytes=new TextEncoder().encode(body).byteLength;table.part_count=1;
  table.parts=[{path,row_count:1,bytes:table.bytes,checksum}];
  table.checksum=await sha256Hex(checksum);
  databaseParts[path]=body;
 }
 const blobBytes=new TextEncoder().encode('file');
 const blobHash=await sha256Hex(blobBytes);
 const storageEntry={source_bucket:'receipts',source_path:'r/file.txt',source_size:blobBytes.byteLength,source_mime_type:'text/plain',source_updated_at:'2026-09-11T00:00:00.000Z',source_etag:null,source_checksum:blobHash,backup_blob_path:`blobs/sha256/${blobHash.slice(0,2)}/${blobHash}`,backup_checksum:blobHash,backed_up_at:'2026-09-11T12:00:00.000Z'};
 const databaseBytes=tables.reduce((n,t)=>n+t.bytes,0);
 const draft={format_version:1,implementation_version:'backup-v1',status:'complete',project_ref:'blaacuwwvyatfiyjnsrw',environment:'production',backup_id:backupId,run_id:'223e4567-e89b-42d3-a456-426614174000',created_at:'2026-09-11T12:00:00.000Z',started_at:'2026-09-11T12:00:00.000Z',completed_at:'2026-09-11T12:00:01.000Z',source_git_checkpoint:'9ddebffea4ced78aa3002f7c1fe5b2d1255fa3e0',spec_checkpoint:'backup-v1-design-2026-09-11',database:{table_count:2,row_count:2,bytes:databaseBytes,tables},storage:{file_count:1,bytes:blobBytes.byteLength,objects:[storageEntry]},totals:{bytes:databaseBytes+blobBytes.byteLength},duration_ms:1000,warnings:[],errors:[]};
 return {mode:'dry-run',manifest:await sealManifest(draft),expectedTables:['parents','children'],databaseParts,backupBlobs:{[storageEntry.backup_blob_path]:blobBytes},liveSchema:structuredClone(tables.map(({row_count,bytes,part_count,parts,checksum,...meta})=>meta)),targetRows:{parents:[parent],children:[]},targetStorage:[]};
}

test('FK ordering is deterministic and rejects cycles or unknown targets',()=>{
 const tables=[{table_name:'children',foreign_keys:[{referenced_table:'parents'}]},{table_name:'parents',foreign_keys:[]}];
 assert.deepEqual(topologicalTableOrder(tables),['parents','children']);
 assert.throws(()=>topologicalTableOrder([{table_name:'a',foreign_keys:[{referenced_table:'b'}]},{table_name:'b',foreign_keys:[{referenced_table:'a'}]}]),/foreign_key_cycle/);
 assert.throws(()=>topologicalTableOrder([{table_name:'a',foreign_keys:[{referenced_table:'a'}]}]),/foreign_key_cycle/);
 assert.throws(()=>topologicalTableOrder([{table_name:'a',foreign_keys:[{referenced_table:'missing'}]}]),/unknown_foreign_key_table/);
});

test('row classification supports composite keys, identical rows and conflicts',()=>{
 const meta={table_name:'pairs',columns:[{name:'a'},{name:'b'},{name:'value'}],numeric_columns:[],primary_key:['a','b'],foreign_keys:[]};
 const result=classifyRows([{a:'1',b:'2',value:'new'},{a:'2',b:'3',value:'same'}],[{a:'1',b:'2',value:'old'},{a:'2',b:'3',value:'same'}],meta);
 assert.deepEqual(result,{insert:0,existing_identical:1,conflict:1,total:2});
 assert.throws(()=>classifyRows([{a:'1',b:'2',value:'x'},{a:'1',b:'2',value:'y'}],[],meta),/duplicate_snapshot_key/);
});

test('dry run counts inserts, identical rows and preserves decimal strings',async()=>{
 const input=await fixture();
 const result=await buildRestoreDryRun(input);
 assert.equal(result.mode,'dry-run');
 assert.equal(result.database.insert,1);
 assert.equal(result.database.existing_identical,1);
 assert.equal(result.database.conflict,0);
 assert.equal(result.database.missing_dependency,0);
 assert.deepEqual(result.table_order,['parents','children']);
});

test('dry run detects row conflicts and missing dependencies',async()=>{
 const conflict=await fixture();
 conflict.targetRows.parents=[{id:'p1',name:'Changed'}];
 assert.equal((await buildRestoreDryRun(conflict)).database.conflict,1);
 const missing=await fixture({parentId:'not-present'});
 assert.equal((await buildRestoreDryRun(missing)).database.missing_dependency,1);
});

test('dry run propagates missing dependencies through the FK graph',async()=>{
 const input=await fixture();
 const parentTable=input.manifest.database.tables.find(table=>table.table_name==='parents');
 parentTable.columns.push({name:'root_id',type:'text',nullable:false,ordinal:3});
 parentTable.foreign_keys=[{name:'parents_root_fk',columns:['root_id'],referenced_schema:'public',referenced_table:'roots',referenced_columns:['id']}];
 const parentPath=parentTable.parts[0].path;
 const parentBody=stableStringify({id:'p1',name:'Parent',root_id:'missing-root'});
 parentTable.parts[0].bytes=new TextEncoder().encode(parentBody).byteLength;
 parentTable.parts[0].checksum=await sha256Hex(parentBody);
 parentTable.bytes=parentTable.parts[0].bytes;
 parentTable.checksum=await sha256Hex(parentTable.parts[0].checksum);
 input.databaseParts[parentPath]=parentBody;
 const emptyHash=await sha256Hex('');
 const rootTable={table_name:'roots',columns:[{name:'id',type:'text',nullable:false,ordinal:1}],numeric_columns:[],primary_key:['id'],foreign_keys:[],row_count:0,bytes:0,part_count:1,checksum:await sha256Hex(emptyHash),parts:[{path:`database/${backupId}/tables/roots/part-000001.ndjson`,row_count:0,bytes:0,checksum:emptyHash}]};
 input.databaseParts[rootTable.parts[0].path]='';
 input.manifest.database.tables.push(rootTable);
 input.manifest.database.table_count=3;
 input.manifest.database.bytes=input.manifest.database.tables.reduce((total,table)=>total+table.bytes,0);
 input.manifest.totals.bytes=input.manifest.database.bytes+input.manifest.storage.bytes;
 input.liveSchema=input.manifest.database.tables.map(({row_count,bytes,part_count,parts,checksum,...meta})=>structuredClone(meta));
 input.targetRows.parents=[];
 input.targetRows.roots=[];
 input.expectedTables=['parents','children','roots'];
 delete input.manifest.integrity_checksum;
 input.manifest=await sealManifest(input.manifest);

 const result=await buildRestoreDryRun(input);
 assert.equal(result.database.tables.parents.missing_dependency,1);
 assert.equal(result.database.tables.children.missing_dependency,1);
 assert.equal(result.database.insert,0);
});

test('dry run rejects missing or corrupt database parts',async()=>{
 const missing=await fixture();
 delete missing.databaseParts[Object.keys(missing.databaseParts)[0]];
 await assert.rejects(()=>buildRestoreDryRun(missing),/missing_database_part/);
 const corrupt=await fixture();
 corrupt.databaseParts[Object.keys(corrupt.databaseParts)[0]]+='tamper';
 await assert.rejects(()=>buildRestoreDryRun(corrupt),/database_part_(bytes|checksum)_mismatch/);
 const aggregate=await fixture();
 aggregate.manifest.database.tables[0].checksum='b'.repeat(64);
 delete aggregate.manifest.integrity_checksum;
 aggregate.manifest=await sealManifest(aggregate.manifest);
 await assert.rejects(()=>buildRestoreDryRun(aggregate),/table_checksum_mismatch/);
});

test('dry run rejects missing or corrupt backup blobs',async()=>{
 const missing=await fixture();
 delete missing.backupBlobs[Object.keys(missing.backupBlobs)[0]];
 await assert.rejects(()=>buildRestoreDryRun(missing),/missing_backup_blob/);
 const corrupt=await fixture();
 corrupt.backupBlobs[Object.keys(corrupt.backupBlobs)[0]]=new TextEncoder().encode('bad');
 await assert.rejects(()=>buildRestoreDryRun(corrupt),/backup_blob_(size|checksum)_mismatch/);
});

test('dry run validates one deduplicated blob referenced by multiple source objects',async()=>{
 const input=await fixture();
 const shared={...input.manifest.storage.objects[0],source_path:'r/copy.txt'};
 input.manifest.storage.objects.push(shared);
 input.manifest.storage.file_count=2;
 input.manifest.storage.bytes+=shared.source_size;
 input.manifest.totals.bytes+=shared.source_size;
 delete input.manifest.integrity_checksum;
 input.manifest=await sealManifest(input.manifest);
 const result=await buildRestoreDryRun(input);
 assert.equal(result.validated_blobs,2);
 assert.equal(result.storage.insert,2);
});

test('storage classification distinguishes insert, identical and conflict',async()=>{
 const input=await fixture();
 const entry=input.manifest.storage.objects[0];
 assert.deepEqual(classifyStorage([entry],[]),{insert:1,existing_identical:0,conflict:0,total:1});
 assert.equal(classifyStorage([entry],[{bucket:'receipts',path:'r/file.txt',size:4,checksum:entry.source_checksum}]).existing_identical,1);
 assert.equal(classifyStorage([entry],[{bucket:'receipts',path:'r/file.txt',size:4,checksum:'b'.repeat(64)}]).conflict,1);
});

test('dry run rejects schema drift and unknown columns',async()=>{
 const drift=await fixture();
 drift.liveSchema[0].columns[1].type='varchar';
 await assert.rejects(()=>buildRestoreDryRun(drift),/schema_drift/);
 const unknown=await fixture();
 const path=Object.keys(unknown.databaseParts).find(value=>value.includes('/parents/'));
 const body=stableStringify({id:'p1',name:'Parent',secret:'x'});
 unknown.databaseParts[path]=body;
 const table=unknown.manifest.database.tables.find(value=>value.table_name==='parents');
 table.parts[0].bytes=new TextEncoder().encode(body).byteLength;
 table.parts[0].checksum=await sha256Hex(body);
 table.bytes=table.parts[0].bytes;
 table.checksum=await sha256Hex(table.parts[0].checksum);
 unknown.manifest.database.bytes=unknown.manifest.database.tables.reduce((total,value)=>total+value.bytes,0);
 unknown.manifest.totals.bytes=unknown.manifest.database.bytes+unknown.manifest.storage.bytes;
 delete unknown.manifest.integrity_checksum;
 unknown.manifest=await sealManifest(unknown.manifest);
 await assert.rejects(()=>buildRestoreDryRun(unknown),/unknown_snapshot_column/);
});

test('backup v1 never creates a destructive restore plan',async()=>{
 const input=await fixture();
 assert.throws(()=>buildRestoreDryRun({...input,mode:'apply'}),/dry_run_only/);
});

test('restore CLI defaults to dry-run and exposes aggregate output only',()=>{
 const id=backupId;
 assert.deepEqual(parseArgs(['--backup-id',id]),{backupId:id});
 const request=buildRequest({backupId:id,url:'https://blaacuwwvyatfiyjnsrw.supabase.co',secret:'do-not-print'});
 assert.equal(JSON.parse(request.init.body).action,'restore_dry_run');
 assert.equal(JSON.parse(request.init.body).backup_id,id);
 const output=selectAggregateOutput({mode:'dry-run',backup_id:id,table_order:['projects'],database:{insert:1,existing_identical:2,conflict:0,missing_dependency:0,total:3,tables:{projects:{insert:1}}},storage:{insert:1,existing_identical:0,conflict:0,total:1},validated_parts:2,validated_blobs:1,manifest:{private:'row'},rows:[{secret:'x'}]});
 assert.deepEqual(Object.keys(output).sort(),['backup_id','database','mode','storage','table_order','validated_blobs','validated_parts']);
 assert.equal(JSON.stringify(output).includes('private'),false);
 assert.equal(JSON.stringify(output).includes('secret'),false);
});

test('restore CLI never sends its maintenance secret outside the production project',()=>{
 for(const url of ['https://attacker.invalid','https://blaacuwwvyatfiyjnsrw.supabase.co.attacker.invalid','https://example.supabase.co']){
  assert.throws(()=>buildRequest({backupId,url,secret:'do-not-print'}),/invalid_backup_url/);
 }
});

test('restore CLI rejects every destructive flag before environment or network access',()=>{
 for(const flag of ['--apply','--restore','--target-production','--allow-destructive']){
  const result=spawnSync(process.execPath,[new URL('../scripts/backup-restore.mjs',import.meta.url).pathname,flag,'--backup-id',backupId],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.notEqual(result.status,0,flag);
  assert.match(result.stderr,/dry_run_only/,flag);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`,/SUPABASE_URL|ADMA_BACKUP_SECRET/,flag);
 }
});
