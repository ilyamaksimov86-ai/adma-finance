import {assertBackupId,generateBackupId,safeBackupError,sealManifest,sha256Hex,stableStringify,validateManifest} from './core.mjs';
import {backupStorage as copyStorage,validateStorageEntries as verifyStorage} from './storage.mjs';
import {planRetention} from './retention.mjs';
import {buildRestoreDryRun} from './restore.mjs';

const BACKUP_BUCKET='adma-backups';
const DEFAULT_DEADLINE_MS=135000;
const RPC_PAGE_SIZE=100;

function fail(code){throw new Error(code);}
function byteLength(value){return new TextEncoder().encode(value).byteLength;}
function codeFor(error){const value=error instanceof Error?error.message:String(error??'');return /^[a-z][a-z0-9_]{0,79}$/.test(value)?value:'backup_failed';}
function unwrap(value){if(value&&typeof value==='object'&&'error' in value){if(value.error)throw value.error;return value.data;}return value;}
async function toBytes(value){const data=unwrap(value);if(data instanceof Uint8Array)return data;if(data instanceof ArrayBuffer)return new Uint8Array(data);if(ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset,data.byteLength);if(data&&typeof data.arrayBuffer==='function')return new Uint8Array(await data.arrayBuffer());fail('invalid_storage_bytes');}
function isMissing(error){return Number(error?.status??error?.statusCode)===404||error?.code==='not_found'||/not found|does not exist/i.test(String(error?.message??''));}

function checkDeadline(clock,started,deadlineMs){if(clock()-started>=deadlineMs)fail('backup_deadline_exceeded');}

async function uploadAndVerifyDatabase(deps,runId,backupId,clock,started,deadlineMs){
 const summary=await deps.db.prepare(runId);
 checkDeadline(clock,started,deadlineMs);
 const tables=await deps.db.readTables(runId);
 if(!Array.isArray(tables)||!tables.length)fail('invalid_snapshot_tables');
 const chunks=[];
 for(let offset=0;;offset+=RPC_PAGE_SIZE){
  const page=await deps.db.readChunks(runId,offset,RPC_PAGE_SIZE);
  if(!Array.isArray(page))fail('invalid_snapshot_chunks');
  chunks.push(...page);
  if(page.length<RPC_PAGE_SIZE)break;
  checkDeadline(clock,started,deadlineMs);
 }
 const chunksByTable=new Map(tables.map(table=>[table.table_name,[]]));
 for(const chunk of chunks){
  checkDeadline(clock,started,deadlineMs);
  if(!chunksByTable.has(chunk.table_name)||!Number.isInteger(chunk.chunk_index)||chunk.chunk_index<0||typeof chunk.body!=='string')fail('invalid_snapshot_chunk');
  const bytes=byteLength(chunk.body);
  if(bytes!==Number(chunk.bytes)||await sha256Hex(chunk.body)!==chunk.checksum)fail('snapshot_chunk_checksum_mismatch');
  const path=`database/${backupId}/tables/${chunk.table_name}/part-${String(chunk.chunk_index+1).padStart(6,'0')}.ndjson`;
  const encoded=new TextEncoder().encode(chunk.body);
  unwrap(await deps.storage.upload(BACKUP_BUCKET,path,encoded,{upsert:false,contentType:'application/x-ndjson'}));
  const downloaded=await toBytes(await deps.storage.download(BACKUP_BUCKET,path));
  if(downloaded.byteLength!==bytes||await sha256Hex(downloaded)!==chunk.checksum)fail('uploaded_database_chunk_mismatch');
  chunksByTable.get(chunk.table_name).push({path,row_count:Number(chunk.row_count),bytes,checksum:chunk.checksum,chunk_index:chunk.chunk_index});
 }
 const manifestTables=[];
 for(const table of [...tables].sort((a,b)=>a.table_name.localeCompare(b.table_name))){
  const parts=(chunksByTable.get(table.table_name)??[]).sort((a,b)=>a.chunk_index-b.chunk_index);
  if(!parts.length||parts.some((part,index)=>part.chunk_index!==index))fail('snapshot_part_sequence_mismatch');
  const cleanParts=parts.map(({chunk_index,...part})=>part);
  const rowCount=cleanParts.reduce((sum,part)=>sum+part.row_count,0);
  const bytes=cleanParts.reduce((sum,part)=>sum+part.bytes,0);
  if(rowCount!==Number(table.row_count)||bytes!==Number(table.bytes)||cleanParts.length!==Number(table.part_count))fail('snapshot_table_totals_mismatch');
  if(await sha256Hex(cleanParts.map(part=>part.checksum).join(''))!==table.checksum)fail('snapshot_table_checksum_mismatch');
  manifestTables.push({...table,row_count:rowCount,bytes,part_count:cleanParts.length,parts:cleanParts});
 }
 const database={table_count:manifestTables.length,row_count:manifestTables.reduce((sum,table)=>sum+table.row_count,0),bytes:manifestTables.reduce((sum,table)=>sum+table.bytes,0),tables:manifestTables};
 if(Number(summary?.table_count)!==database.table_count||Number(summary?.row_count)!==database.row_count||Number(summary?.database_bytes)!==database.bytes)fail('snapshot_summary_mismatch');
 return database;
}

export async function runBackup(deps,options={}){
 const clock=deps.clock??Date.now;
 const started=clock();
 const deadlineMs=options.deadlineMs??DEFAULT_DEADLINE_MS;
 const now=deps.now?deps.now():new Date();
 const backupId=generateBackupId(now,deps.uuid?deps.uuid():crypto.randomUUID());
 let runId=null;
 try{
  const claim=await deps.db.claim(backupId,options.force===true);
  runId=claim?.run_id??null;
  if(claim?.result==='skipped_recent'||claim?.result==='already_running')return {status:claim.result,code:claim.result,run_id:runId,backup_id:claim.backup_id??backupId};
  if(claim?.result!=='started'||!runId)fail('backup_claim_failed');
  checkDeadline(clock,started,deadlineMs);

  const database=await uploadAndVerifyDatabase(deps,runId,backupId,clock,started,deadlineMs);
  checkDeadline(clock,started,deadlineMs);
  const storageEntries=await (deps.backupStorage??copyStorage)(deps.storage,now);
  checkDeadline(clock,started,deadlineMs);
  await (deps.validateStorageEntries??verifyStorage)(deps.storage,storageEntries);
  checkDeadline(clock,started,deadlineMs);
  const storage={file_count:storageEntries.length,bytes:storageEntries.reduce((sum,entry)=>sum+entry.source_size,0),objects:storageEntries};
  const durationBeforeFinalize=Math.max(0,clock()-started);
  const draft={
   format_version:1,implementation_version:'backup-v1',status:'complete',
   project_ref:deps.projectRef??'blaacuwwvyatfiyjnsrw',environment:'production',
   backup_id:backupId,run_id:runId,created_at:(deps.now?deps.now():new Date()).toISOString(),
   source_git_checkpoint:deps.sourceGitCheckpoint,spec_checkpoint:deps.specCheckpoint,
   database,storage,totals:{bytes:database.bytes+storage.bytes},duration_ms:durationBeforeFinalize,warnings:[],errors:[],
  };
  const manifest=await sealManifest(draft);
  await validateManifest(manifest);
  const manifestPath=`database/${backupId}/manifest.json`;
  const manifestText=stableStringify(manifest);
  unwrap(await deps.storage.upload(BACKUP_BUCKET,manifestPath,new TextEncoder().encode(manifestText),{upsert:false,contentType:'application/json'}));
  const verifiedText=new TextDecoder('utf-8',{fatal:true}).decode(await toBytes(await deps.storage.download(BACKUP_BUCKET,manifestPath)));
  const verified=JSON.parse(verifiedText);
  await validateManifest(verified);
  if(verified.integrity_checksum!==manifest.integrity_checksum)fail('uploaded_manifest_mismatch');
  checkDeadline(clock,started,deadlineMs);
  const durationMs=Math.max(0,clock()-started);
  const finished=await deps.db.finish(runId,{table_count:database.table_count,row_count:database.row_count,file_count:storage.file_count,database_bytes:database.bytes,storage_bytes:storage.bytes,checksum:manifest.integrity_checksum,duration_ms:durationMs,warnings:[],metadata:{manifest_path:manifestPath,source_git_checkpoint:deps.sourceGitCheckpoint,spec_checkpoint:deps.specCheckpoint}});
  if(finished!==true)fail('backup_finish_rejected');
  try{await deps.db.clear(runId);}catch{deps.logger?.error?.({event:'backup_staging_cleanup_failed',run_id:runId,backup_id:backupId});}
  try{await deps.retention?.();}catch{deps.logger?.error?.({event:'backup_retention_failed',run_id:runId,backup_id:backupId});}
  deps.logger?.info?.({event:'backup_success',run_id:runId,backup_id:backupId,table_count:database.table_count,row_count:database.row_count,file_count:storage.file_count,total_bytes:database.bytes+storage.bytes,duration_ms:durationMs});
  return {status:'success',code:'backup_complete',run_id:runId,backup_id:backupId,table_count:database.table_count,row_count:database.row_count,file_count:storage.file_count,database_bytes:database.bytes,storage_bytes:storage.bytes,total_bytes:database.bytes+storage.bytes,duration_ms:durationMs,checksum:manifest.integrity_checksum};
 }catch(error){
  const code=codeFor(error);
  if(runId){
   try{await deps.db.fail(runId,code);}catch{}
   try{await deps.db.clear(runId);}catch{}
  }
  deps.logger?.error?.({event:'backup_failed',code,run_id:runId,backup_id:backupId});
  return {status:'failed',code,run_id:runId,backup_id:backupId,message:safeBackupError(code)};
 }
}

export async function runRestoreDryRun(deps,backupId){
 assertBackupId(backupId);
 const run=await deps.db.findSuccessfulRun(backupId);
 if(!run)fail('backup_not_found');
 const manifestPath=`database/${backupId}/manifest.json`;
 const manifestBytes=await toBytes(await deps.storage.download(BACKUP_BUCKET,manifestPath));
 if(manifestBytes.byteLength>10*1024*1024)fail('manifest_too_large');
 const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes));
 await validateManifest(manifest);
 const databaseParts={};
 for(const table of manifest.database.tables)for(const part of table.parts)databaseParts[part.path]=await toBytes(await deps.storage.download(BACKUP_BUCKET,part.path));
 const backupBlobs={};
 for(const entry of manifest.storage.objects)backupBlobs[entry.backup_blob_path]=await toBytes(await deps.storage.download(BACKUP_BUCKET,entry.backup_blob_path));
 const liveSchema=await deps.db.readLiveSchema();
 const targetRows={};
 for(const table of manifest.database.tables){
  const rows=[];let after=null;
  for(;;){
   const page=await deps.db.readTablePage(table.table_name,after,500);
   if(!Array.isArray(page))fail('invalid_restore_page');
   for(const item of page)rows.push(JSON.parse(item.row_data));
   if(page.length<500)break;
   after=page.at(-1).primary_key;
  }
  targetRows[table.table_name]=rows;
 }
 const targetStorage=[];
 for(const entry of manifest.storage.objects){
  try{
   const bytes=await toBytes(await deps.storage.download(entry.source_bucket,entry.source_path));
   targetStorage.push({bucket:entry.source_bucket,path:entry.source_path,size:bytes.byteLength,checksum:await sha256Hex(bytes)});
  }catch(error){if(!isMissing(error))throw error;}
 }
 const result=await buildRestoreDryRun({mode:'dry-run',manifest,databaseParts,backupBlobs,liveSchema,targetRows,targetStorage});
 await deps.db.recordRestoreDryRun?.(run.id,{backup_id:backupId,validated_at:new Date().toISOString(),database:{insert:result.database.insert,existing_identical:result.database.existing_identical,conflict:result.database.conflict,missing_dependency:result.database.missing_dependency,total:result.database.total},storage:result.storage,validated_parts:result.validated_parts,validated_blobs:result.validated_blobs});
 return result;
}

async function listBackupObjects(storage){
 const result=[];const pending=[''];
 while(pending.length){
  const prefix=pending.shift();
  for(let offset=0;;offset+=1000){
   const rows=unwrap(await storage.list(BACKUP_BUCKET,{prefix,limit:1000,offset,sortBy:{column:'name',order:'asc'}}));
   if(!Array.isArray(rows))fail('invalid_backup_listing');
   for(const item of rows){
    const path=prefix?`${prefix}/${item.name}`:item.name;
    if(item?.isFolder===true||(item?.id==null&&item?.metadata==null))pending.push(path);
    else result.push({path,created_at:item.created_at??item.updated_at});
   }
   if(rows.length<1000)break;
  }
 }
 return result.sort((a,b)=>a.path.localeCompare(b.path));
}

export function createSupabaseBackupDeps(client,config={}){
 const rpc=async(name,args)=>unwrap(await client.rpc(name,args));
 const storage={
  list:(bucket,options)=>client.storage.from(bucket).list(options.prefix||'',{limit:options.limit,offset:options.offset,sortBy:options.sortBy}),
  download:(bucket,path)=>client.storage.from(bucket).download(path),
  upload:(bucket,path,bytes,options)=>client.storage.from(bucket).upload(path,bytes,options),
  remove:(bucket,paths)=>client.storage.from(bucket).remove(paths),
 };
 const db={
  async claim(id,force){const data=await rpc('claim_backup_run',{p_backup_id:id,p_force:force});return Array.isArray(data)?data[0]:data;},
  prepare:runId=>rpc('prepare_backup_snapshot',{p_run_id:runId}),
  readChunks:(runId,offset,limit)=>rpc('read_backup_snapshot_chunks',{p_run_id:runId,p_offset:offset,p_limit:limit}),
  readTables:runId=>rpc('read_backup_snapshot_tables',{p_run_id:runId}),
  finish:(runId,value)=>rpc('finish_backup_run',{p_run_id:runId,p_table_count:value.table_count,p_row_count:value.row_count,p_file_count:value.file_count,p_database_bytes:value.database_bytes,p_storage_bytes:value.storage_bytes,p_checksum:value.checksum,p_duration_ms:value.duration_ms,p_warnings:value.warnings,p_metadata:value.metadata}),
  fail:(runId,error)=>rpc('fail_backup_run',{p_run_id:runId,p_error:error}),
  clear:runId=>rpc('clear_backup_snapshot',{p_run_id:runId}),
  readLiveSchema:()=>rpc('read_backup_live_schema',{}),
  async readConfig(){const data=await rpc('read_backup_config',{});return Array.isArray(data)?data[0]:data;},
  readTablePage:(table,after,limit)=>rpc('read_backup_table_page',{p_table_name:table,p_after:after,p_limit:limit}),
  async listRuns(){const response=await client.from('backup_runs').select('id,backup_id,status,completed_at,metadata').order('completed_at',{ascending:false});return unwrap(response);},
  async findSuccessfulRun(backupId){const response=await client.from('backup_runs').select('id,backup_id,status,metadata').eq('backup_id',backupId).eq('status','success').maybeSingle();return unwrap(response);},
  recordRestoreDryRun:(runId,result)=>rpc('record_backup_restore_dry_run',{p_run_id:runId,p_result:result}),
 };
 const deps={db,storage,sourceGitCheckpoint:config.sourceGitCheckpoint,specCheckpoint:config.specCheckpoint,projectRef:config.projectRef??'blaacuwwvyatfiyjnsrw',logger:config.logger??console};
 deps.retention=async()=>{
  const runs=await db.listRuns();
  const objects=await listBackupObjects(storage);
  const manifests={};
  for(const run of runs.filter(item=>item.status==='success').slice(0,10)){
   try{manifests[run.backup_id]=JSON.parse(new TextDecoder().decode(await toBytes(await storage.download(BACKUP_BUCKET,`database/${run.backup_id}/manifest.json`))));}catch{manifests[run.backup_id]=null;}
  }
  const plan=await planRetention(runs,manifests,objects,new Date(),10);
  for(const paths of [plan.snapshot_paths_to_delete,plan.blob_paths_to_delete])for(let index=0;index<paths.length;index+=100)unwrap(await storage.remove(BACKUP_BUCKET,paths.slice(index,index+100)));
  return plan;
 };
 return deps;
}
