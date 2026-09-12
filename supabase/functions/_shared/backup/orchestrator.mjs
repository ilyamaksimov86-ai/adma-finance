import {assertBackupId,assertManifestRunBinding,generateBackupId,safeBackupError,sealManifest,sha256Hex,stableStringify,validateManifest} from './core.mjs';
import {backupStorage as copyStorage,validateStorageEntries as verifyStorage} from './storage.mjs';
import {planRetention} from './retention.mjs';
import {buildRestoreDryRun} from './restore.mjs';

const BACKUP_BUCKET='adma-backups';
const DEFAULT_DEADLINE_MS=135000;
const RPC_PAGE_SIZE=100;
const RESTORE_PAGE_SIZE=25;
const RESTORE_LIMITS=Object.freeze({manifestBytes:2*1024*1024,totalBytes:16*1024*1024,targetBytes:8*1024*1024,partBytes:1024*1024,objectBytes:8*1024*1024,rows:50000,parts:4096,objects:2000});

function fail(code){throw new Error(code);}
function byteLength(value){return new TextEncoder().encode(value).byteLength;}
function codeFor(error){const value=error instanceof Error?error.message:String(error??'');return /^[a-z][a-z0-9_]{0,79}$/.test(value)?value:'backup_failed';}
function unwrap(value){if(value&&typeof value==='object'&&'error' in value){if(value.error)throw value.error;return value.data;}return value;}
async function toBytes(value){const data=unwrap(value);if(data instanceof Uint8Array)return data;if(data instanceof ArrayBuffer)return new Uint8Array(data);if(ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset,data.byteLength);if(data&&typeof data.arrayBuffer==='function')return new Uint8Array(await data.arrayBuffer());fail('invalid_storage_bytes');}
function isMissing(error){return Number(error?.status??error?.statusCode)===404||error?.code==='not_found'||/not found|does not exist/i.test(String(error?.message??''));}

export {assertManifestRunBinding};

export function assertRestoreBounds(manifest,limits=RESTORE_LIMITS){
 const partCount=manifest?.database?.tables?.reduce((total,table)=>total+(Array.isArray(table?.parts)?table.parts.length:0),0);
 if(!Number.isSafeInteger(manifest?.database?.row_count)||manifest.database.row_count>limits.rows)fail('restore_row_limit');
 if(!Number.isSafeInteger(partCount)||partCount>limits.parts)fail('restore_part_limit');
 if(!Number.isSafeInteger(manifest?.storage?.file_count)||manifest.storage.file_count>limits.objects)fail('restore_object_limit');
 if(manifest?.database?.tables?.some(table=>table?.parts?.some(part=>!Number.isSafeInteger(part?.bytes)||part.bytes>limits.partBytes)))fail('restore_part_byte_limit');
 if(manifest?.storage?.objects?.some(object=>!Number.isSafeInteger(object?.source_size)||object.source_size>limits.objectBytes))fail('restore_object_byte_limit');
 if(!Number.isSafeInteger(manifest?.totals?.bytes)||manifest.totals.bytes>limits.totalBytes)fail('restore_byte_limit');
 return true;
}

function checkDeadline(clock,started,deadlineMs){if(clock()-started>=deadlineMs)fail('backup_deadline_exceeded');}

async function withinDeadline(operation,clock,started,deadlineMs){
 const remaining=deadlineMs-(clock()-started);
 if(remaining<=0)fail('backup_deadline_exceeded');
 let timer;
 try{
  return await Promise.race([
   Promise.resolve().then(operation),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('backup_deadline_exceeded')),remaining);}),
  ]);
 }finally{clearTimeout(timer);}
}

export async function readResponseBounded(response,maxBytes){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0)fail('invalid_download_limit');
 if(!response||typeof response!=='object'||response.ok!==true){
  const error=new Error(Number(response?.status)===404?'not_found':'storage_download_failed');
  error.status=Number(response?.status)||500;
  throw error;
 }
 const advertised=response.headers?.get?.('content-length');
 if(advertised!==null&&advertised!==undefined&&advertised!==''){
  const length=Number(advertised);
  if(!Number.isSafeInteger(length)||length<0)fail('invalid_content_length');
  if(length>maxBytes){try{await response.body?.cancel?.();}catch{}fail('restore_download_limit');}
 }
 if(!response.body||typeof response.body.getReader!=='function')fail('invalid_storage_response');
 const reader=response.body.getReader();
 const chunks=[];let total=0;
 try{
  for(;;){
   const {done,value}=await reader.read();
   if(done)break;
   if(!(value instanceof Uint8Array))fail('invalid_storage_response');
   total+=value.byteLength;
   if(total>maxBytes){try{await reader.cancel();}catch{}fail('restore_download_limit');}
   chunks.push(value);
  }
 }finally{try{reader.releaseLock();}catch{}}
 const result=new Uint8Array(total);let offset=0;
 for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}
 return result;
}

async function downloadWithinLimit(storage,bucket,path,maxBytes,clock,started,deadlineMs){
 if(!storage||typeof storage.downloadBounded!=='function')fail('bounded_storage_download_required');
 const remaining=deadlineMs-(clock()-started);
 if(remaining<=0)fail('backup_deadline_exceeded');
 return toBytes(await withinDeadline(()=>storage.downloadBounded(bucket,path,maxBytes,remaining),clock,started,deadlineMs));
}

function boundedAdapter(adapter,clock,started,deadlineMs,invalidCode){
 if(!adapter)fail(invalidCode);
 return new Proxy(adapter,{get(target,property,receiver){
  const value=Reflect.get(target,property,receiver);
  if(typeof value!=='function')return value;
  return (...args)=>withinDeadline(()=>value.apply(target,args),clock,started,deadlineMs);
 }});
}

async function withinDestructiveDeadline(operation,clock,started,deadlineMs){
 checkDeadline(clock,started,deadlineMs);
 const result=await operation();
 checkDeadline(clock,started,deadlineMs);
 return result;
}

export function createRetentionStorageAdapter(storage,clock,started,deadlineMs){
 const bounded=boundedAdapter(storage,clock,started,deadlineMs,'invalid_storage_adapter');
 return new Proxy(bounded,{get(target,property,receiver){
  if(property==='remove')return (...args)=>withinDestructiveDeadline(()=>storage.remove(...args),clock,started,deadlineMs);
  return Reflect.get(target,property,receiver);
 }});
}

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
  const downloaded=await toBytes(typeof deps.storage.downloadBounded==='function'
   ?await deps.storage.downloadBounded(BACKUP_BUCKET,path,RESTORE_LIMITS.partBytes)
   :await deps.storage.download(BACKUP_BUCKET,path));
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
 const startedAt=now.toISOString();
 const backupId=generateBackupId(now,deps.uuid?deps.uuid():crypto.randomUUID());
 let runId=null;
 try{
  const claim=await deps.db.claim(backupId,options.force===true);
  runId=claim?.run_id??null;
  if(['skipped_recent','already_running','maintenance_busy'].includes(claim?.result))return {status:claim.result,code:claim.result,run_id:runId,backup_id:claim.backup_id??backupId};
  if(claim?.result!=='started'||!runId)fail('backup_claim_failed');
  checkDeadline(clock,started,deadlineMs);
  const storageAdapter=boundedAdapter(deps.storage,clock,started,deadlineMs,'invalid_storage_adapter');

  const database=await uploadAndVerifyDatabase({...deps,storage:storageAdapter},runId,backupId,clock,started,deadlineMs);
  checkDeadline(clock,started,deadlineMs);
  const storageEntries=await (deps.backupStorage??copyStorage)(storageAdapter,now);
  checkDeadline(clock,started,deadlineMs);
  await (deps.validateStorageEntries??verifyStorage)(storageAdapter,storageEntries);
  checkDeadline(clock,started,deadlineMs);
  const storage={file_count:storageEntries.length,bytes:storageEntries.reduce((sum,entry)=>sum+entry.source_size,0),objects:storageEntries};
  const durationBeforeFinalize=Math.max(0,clock()-started);
  const completedAt=(deps.now?deps.now():new Date()).toISOString();
  const draft={
   format_version:1,implementation_version:'backup-v1',status:'complete',
   project_ref:deps.projectRef??'blaacuwwvyatfiyjnsrw',environment:'production',
   backup_id:backupId,run_id:runId,created_at:startedAt,started_at:startedAt,completed_at:completedAt,
   source_git_checkpoint:deps.sourceGitCheckpoint,spec_checkpoint:deps.specCheckpoint,
   database,storage,totals:{bytes:database.bytes+storage.bytes},duration_ms:durationBeforeFinalize,warnings:[],errors:[],
  };
  assertRestoreBounds(draft,RESTORE_LIMITS);
  const manifest=await sealManifest(draft);
  await validateManifest(manifest,deps.expectedTables);
  const manifestPath=`database/${backupId}/manifest.json`;
  const manifestText=stableStringify(manifest);
  if(byteLength(manifestText)>RESTORE_LIMITS.manifestBytes)fail('manifest_too_large');
  unwrap(await storageAdapter.upload(BACKUP_BUCKET,manifestPath,new TextEncoder().encode(manifestText),{upsert:false,contentType:'application/json'}));
  const verifiedText=new TextDecoder('utf-8',{fatal:true}).decode(await toBytes(typeof storageAdapter.downloadBounded==='function'
   ?await storageAdapter.downloadBounded(BACKUP_BUCKET,manifestPath,RESTORE_LIMITS.manifestBytes)
   :await storageAdapter.download(BACKUP_BUCKET,manifestPath)));
  const verified=JSON.parse(verifiedText);
  await validateManifest(verified,deps.expectedTables);
  if(verified.integrity_checksum!==manifest.integrity_checksum)fail('uploaded_manifest_mismatch');
  checkDeadline(clock,started,deadlineMs);
  const durationMs=Math.max(0,clock()-started);
  const finished=await deps.db.finish(runId,{table_count:database.table_count,row_count:database.row_count,file_count:storage.file_count,database_bytes:database.bytes,storage_bytes:storage.bytes,checksum:manifest.integrity_checksum,duration_ms:durationMs,warnings:[],metadata:{manifest_path:manifestPath,source_git_checkpoint:deps.sourceGitCheckpoint,spec_checkpoint:deps.specCheckpoint}});
  if(finished!==true)fail('backup_finish_rejected');
  try{await deps.db.clear(runId);}catch{deps.logger?.error?.({event:'backup_staging_cleanup_failed',run_id:runId,backup_id:backupId});}
  try{
   checkDeadline(clock,started,deadlineMs);
   const retention=await deps.retention?.({db:deps.db,storage:createRetentionStorageAdapter(deps.storage,clock,started,deadlineMs)});
   if(retention?.warnings?.length)deps.logger?.error?.({event:'backup_retention_warning',run_id:runId,backup_id:backupId,warnings:retention.warnings});
  }catch{deps.logger?.error?.({event:'backup_retention_failed',run_id:runId,backup_id:backupId});}
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

export async function runRestoreDryRun(deps,backupId,options={}){
 assertBackupId(backupId);
 const clock=deps.clock??Date.now;
 const started=clock();
 const deadlineMs=options.deadlineMs??DEFAULT_DEADLINE_MS;
 const limits=options.limits??RESTORE_LIMITS;
 const db=boundedAdapter(deps.db,clock,started,deadlineMs,'invalid_database_adapter');
 const storage=deps.storage;
 if(!storage)fail('invalid_storage_adapter');
 const run=await db.findSuccessfulRun(backupId);
 if(!run)fail('backup_not_found');
 const manifestPath=`database/${backupId}/manifest.json`;
 const manifestBytes=await downloadWithinLimit(storage,BACKUP_BUCKET,manifestPath,limits.manifestBytes,clock,started,deadlineMs);
 if(manifestBytes.byteLength>limits.manifestBytes)fail('manifest_too_large');
 const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes));
 await validateManifest(manifest,options.expectedTables);
 assertManifestRunBinding(manifest,run,manifestPath);
 assertRestoreBounds(manifest,limits);
 const databaseParts={};
 let backupBytesRead=0;
 for(const table of manifest.database.tables)for(const part of table.parts){
  const bytes=await downloadWithinLimit(storage,BACKUP_BUCKET,part.path,limits.partBytes,clock,started,deadlineMs);
  backupBytesRead+=bytes.byteLength;if(backupBytesRead>limits.totalBytes)fail('restore_actual_byte_limit');
  databaseParts[part.path]=bytes;
 }
 const backupBlobs={};
 for(const entry of manifest.storage.objects){
  if(Object.hasOwn(backupBlobs,entry.backup_blob_path))continue;
  const bytes=await downloadWithinLimit(storage,BACKUP_BUCKET,entry.backup_blob_path,limits.objectBytes,clock,started,deadlineMs);
  backupBytesRead+=bytes.byteLength;if(backupBytesRead>limits.totalBytes)fail('restore_actual_byte_limit');
  backupBlobs[entry.backup_blob_path]=bytes;
 }
 const liveSchema=await db.readLiveSchema();
 const targetRows={};
 let targetRowCount=0;let targetBytes=0;
 for(const table of manifest.database.tables){
  const rows=[];let after=null;let previousAfter=null;
  for(;;){
   const page=await db.readTablePage(table.table_name,after,RESTORE_PAGE_SIZE);
   if(!Array.isArray(page))fail('invalid_restore_page');
   for(const item of page){
    if(typeof item?.row_data!=='string')fail('invalid_restore_page');
    targetBytes+=byteLength(item.row_data);targetRowCount++;
    if(targetRowCount>limits.rows)fail('restore_target_row_limit');
    if(targetBytes>limits.targetBytes)fail('restore_target_byte_limit');
    rows.push(JSON.parse(item.row_data));
   }
   if(page.length<RESTORE_PAGE_SIZE)break;
   after=page.at(-1).primary_key;
   const fingerprint=stableStringify(after);
   if(fingerprint===previousAfter)fail('restore_pagination_stalled');
   previousAfter=fingerprint;
  }
  targetRows[table.table_name]=rows;
 }
 const targetStorage=[];
 for(const entry of manifest.storage.objects){
  try{
   const bytes=await downloadWithinLimit(storage,entry.source_bucket,entry.source_path,limits.objectBytes,clock,started,deadlineMs);
   targetBytes+=bytes.byteLength;if(targetBytes>limits.targetBytes)fail('restore_target_byte_limit');
   targetStorage.push({bucket:entry.source_bucket,path:entry.source_path,size:bytes.byteLength,checksum:await sha256Hex(bytes)});
  }catch(error){if(!isMissing(error))throw error;}
 }
 const result=await buildRestoreDryRun({mode:'dry-run',manifest,expectedTables:options.expectedTables,databaseParts,backupBlobs,liveSchema,targetRows,targetStorage});
 await db.recordRestoreDryRun?.(run.id,{backup_id:backupId,validated_at:new Date().toISOString(),database:{insert:result.database.insert,existing_identical:result.database.existing_identical,conflict:result.database.conflict,missing_dependency:result.database.missing_dependency,total:result.database.total},storage:result.storage,validated_parts:result.validated_parts,validated_blobs:result.validated_blobs});
 return result;
}

async function listBackupObjects(storage){
 const result=[];const pending=[''];const visited=new Set();
 while(pending.length){
  const prefix=pending.shift();
  if(visited.has(prefix))fail('storage_folder_cycle');
  visited.add(prefix);
  let previousFingerprint=null;
  for(let page=0,offset=0;page<10000;page++,offset+=1000){
   const rows=unwrap(await storage.list(BACKUP_BUCKET,{prefix,limit:1000,offset,sortBy:{column:'name',order:'asc'}}));
   if(!Array.isArray(rows))fail('invalid_backup_listing');
   const fingerprint=rows.map(item=>`${item?.name}:${item?.isFolder===true||(item?.id==null&&item?.metadata==null)?'d':'f'}`).join('|');
   if(rows.length===1000&&offset>0&&fingerprint===previousFingerprint)fail('storage_pagination_stalled');
   previousFingerprint=fingerprint;
   for(const item of rows){
    if(!item||typeof item.name!=='string'||!item.name||item.name.includes('/'))fail('invalid_backup_listing');
    const path=prefix?`${prefix}/${item.name}`:item.name;
    if(item?.isFolder===true||(item?.id==null&&item?.metadata==null))pending.push(path);
    else result.push({path,created_at:item.created_at??item.updated_at});
   }
   if(rows.length<1000)break;
   if(page===9999)fail('storage_pagination_limit');
  }
 }
 return result.sort((a,b)=>a.path.localeCompare(b.path));
}

export async function runRetention(db,storage,now=new Date(),expectedTables){
 const owner=await db.beginRetention();
 if(owner===null||owner===undefined||owner===false)return {skipped:true,reason:'maintenance_busy'};
 if(typeof owner!=='string'||!owner)fail('invalid_retention_lease');
 try{
  const runs=await db.listRuns();
  const objects=await listBackupObjects(storage);
  const manifests={};
  for(const run of runs.filter(item=>item.status==='success').slice(0,10)){
   try{
    if(typeof storage.downloadBounded!=='function')fail('bounded_storage_download_required');
    const raw=await storage.downloadBounded(BACKUP_BUCKET,`database/${run.backup_id}/manifest.json`,RESTORE_LIMITS.manifestBytes);
    const bytes=await toBytes(raw);if(bytes.byteLength>RESTORE_LIMITS.manifestBytes)fail('manifest_too_large');
    manifests[run.backup_id]=JSON.parse(new TextDecoder().decode(bytes));
   }catch{manifests[run.backup_id]=null;}
  }
  const plan=await planRetention(runs,manifests,objects,now,10,expectedTables);
  for(const paths of [plan.snapshot_paths_to_delete,plan.blob_paths_to_delete])for(let index=0;index<paths.length;index+=100)unwrap(await storage.remove(BACKUP_BUCKET,paths.slice(index,index+100)));
  return plan;
 }finally{
  if(await db.endRetention(owner)!==true)fail('retention_lease_release_failed');
 }
}

export async function listAllBackupRuns(client,{pageSize=1000,maxPages=20}={}){
 if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>1000||!Number.isSafeInteger(maxPages)||maxPages<1)fail('invalid_run_page_limit');
 const result=[];let expectedCount=null;
 for(let page=0;page<maxPages;page++){
  const from=result.length;
  const response=await client.from('backup_runs')
   .select('id,backup_id,backup_path,status,completed_at,checksum,metadata',{count:'exact'})
   .order('completed_at',{ascending:false,nullsFirst:false})
   .order('id',{ascending:false})
   .range(from,from+pageSize-1);
  const rows=unwrap(response);
  if(!Array.isArray(rows))fail('invalid_backup_run_page');
  const count=response?.count;
  if(!Number.isSafeInteger(count)||count<0)fail('backup_run_count_required');
  if(expectedCount===null)expectedCount=count;
  else if(count!==expectedCount)fail('backup_run_count_changed');
  if(result.length+rows.length>expectedCount)fail('invalid_backup_run_page');
  result.push(...rows);
  if(result.length===expectedCount)return result;
  if(!rows.length)fail('incomplete_backup_run_history');
 }
 fail('backup_run_pagination_limit');
}

export function createSupabaseBackupDeps(client,config={}){
 const rpc=async(name,args)=>unwrap(await client.rpc(name,args));
 const storage={
  list:(bucket,options)=>client.storage.from(bucket).list(options.prefix||'',{limit:options.limit,offset:options.offset,sortBy:options.sortBy}),
  download:(bucket,path)=>client.storage.from(bucket).download(path),
  upload:(bucket,path,bytes,options)=>client.storage.from(bucket).upload(path,bytes,options),
  remove:(bucket,paths)=>client.storage.from(bucket).remove(paths),
  async downloadBounded(bucket,path,maxBytes,timeoutMs=120000){
   const signed=unwrap(await client.storage.from(bucket).createSignedUrl(path,60));
   const signedUrl=signed?.signedUrl??signed?.signedURL;
   let endpoint;try{endpoint=new URL(signedUrl);}catch{fail('invalid_signed_storage_url');}
   const expectedOrigin=`https://${config.projectRef??'blaacuwwvyatfiyjnsrw'}.supabase.co`;
   if(endpoint.origin!==expectedOrigin)fail('invalid_signed_storage_url');
   const controller=new AbortController();
   const timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(timeoutMs,120000)));
   try{return await readResponseBounded(await fetch(endpoint,{signal:controller.signal}),maxBytes);}
   finally{clearTimeout(timer);}
  },
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
  listRuns:()=>listAllBackupRuns(client),
  async findSuccessfulRun(backupId){const response=await client.from('backup_runs').select('id,backup_id,backup_path,status,checksum,metadata').eq('backup_id',backupId).eq('status','success').maybeSingle();return unwrap(response);},
  recordRestoreDryRun:(runId,result)=>rpc('record_backup_restore_dry_run',{p_run_id:runId,p_result:result}),
  beginRetention:()=>rpc('begin_backup_retention',{}),
  endRetention:owner=>rpc('end_backup_retention',{p_owner:owner}),
 };
 const deps={db,storage,sourceGitCheckpoint:config.sourceGitCheckpoint,specCheckpoint:config.specCheckpoint,projectRef:config.projectRef??'blaacuwwvyatfiyjnsrw',logger:config.logger??console};
 deps.retention=({db:runtimeDb=db,storage:runtimeStorage=storage}={})=>runRetention(runtimeDb,runtimeStorage,new Date());
 return deps;
}
