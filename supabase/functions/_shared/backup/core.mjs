const BACKUP_ID_RE=/^\d{4}-\d{2}-\d{2}T\d{6}Z_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_RE=/^[0-9a-f]{64}$/;
const TABLE_RE=/^[a-z][a-z0-9_]{0,62}$/;
const PROJECT_REF='blaacuwwvyatfiyjnsrw';
const SOURCE_BUCKETS=new Set(['receipts','finance-documents','project-files','knowledge-files']);
const THREE_DAYS_MS=72*60*60*1000;

function fail(code){throw new Error(code);}

function normalizedJson(value){
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(typeof value==='number'){
  if(!Number.isFinite(value))fail('non_finite_number');
  return value;
 }
 if(Array.isArray(value))return value.map(normalizedJson);
 if(typeof value==='object'){
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)fail('unsupported_json_value');
  const result={};
  for(const key of Object.keys(value).sort()){
   if(value[key]===undefined)fail('unsupported_json_value');
   result[key]=normalizedJson(value[key]);
  }
  return result;
 }
 fail('unsupported_json_value');
}

function requireObject(value,code){
 if(!value||typeof value!=='object'||Array.isArray(value))fail(code);
 return value;
}

function requireInteger(value,code){
 if(!Number.isSafeInteger(value)||value<0)fail(code);
 return value;
}

function requireHash(value,code){
 if(typeof value!=='string'||!HASH_RE.test(value))fail(code);
 return value;
}

function requireSafeObjectPath(value,code){
 if(typeof value!=='string'||value.length<1||value.length>1000||value.startsWith('/')||value.includes('\\')||/[\u0000-\u001f\u007f]/.test(value)||value.split('/').some(part=>part===''||part==='.'||part==='..'))fail(code);
 return value;
}

function sum(items,field){return items.reduce((total,item)=>total+item[field],0);}

export function generateBackupId(now,uuid){
 const date=now instanceof Date?now:new Date(now);
 if(!Number.isFinite(date.getTime()))fail('invalid_backup_time');
 if(typeof uuid!=='string')fail('invalid_backup_id');
 const stamp=date.toISOString().slice(0,19).replaceAll(':','')+'Z';
 return assertBackupId(`${stamp}_${uuid.toLowerCase()}`);
}

export function assertBackupId(value){
 if(typeof value!=='string'||!BACKUP_ID_RE.test(value))fail('invalid_backup_id');
 return value;
}

export function stableStringify(value){
 return JSON.stringify(normalizedJson(value));
}

export async function sha256Hex(value){
 let bytes;
 if(typeof value==='string')bytes=new TextEncoder().encode(value);
 else if(value instanceof Uint8Array)bytes=value;
 else if(value instanceof ArrayBuffer)bytes=new Uint8Array(value);
 else if(ArrayBuffer.isView(value))bytes=new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
 else fail('invalid_hash_input');
 const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
 return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

export function backupEligibility(lastSuccess,now=new Date()){
 if(lastSuccess===null||lastSuccess===undefined)return true;
 const lastMs=new Date(lastSuccess).getTime();
 const nowMs=(now instanceof Date?now:new Date(now)).getTime();
 if(!Number.isFinite(lastMs)||!Number.isFinite(nowMs)||lastMs>nowMs)fail('invalid_backup_time');
 return nowMs-lastMs>=THREE_DAYS_MS;
}

export async function sealManifest(draft){
 const copy=structuredClone(requireObject(draft,'invalid_manifest'));
 delete copy.integrity_checksum;
 return {...copy,integrity_checksum:await sha256Hex(stableStringify(copy))};
}

export async function validateManifest(manifest){
 requireObject(manifest,'invalid_manifest');
 requireHash(manifest.integrity_checksum,'invalid_integrity_checksum');
 const unsigned=structuredClone(manifest);
 delete unsigned.integrity_checksum;
 if(await sha256Hex(stableStringify(unsigned))!==manifest.integrity_checksum)fail('manifest_integrity_mismatch');

 if(manifest.format_version!==1)fail('invalid_format_version');
 if(manifest.implementation_version!=='backup-v1')fail('invalid_implementation_version');
 if(manifest.status!=='complete')fail('invalid_manifest_status');
 if(manifest.project_ref!==PROJECT_REF)fail('invalid_project_ref');
 const backupId=assertBackupId(manifest.backup_id);
 if(typeof manifest.created_at!=='string'||!Number.isFinite(Date.parse(manifest.created_at)))fail('invalid_created_at');
 if(typeof manifest.source_git_checkpoint!=='string'||!/^[0-9a-f]{40}$/.test(manifest.source_git_checkpoint))fail('invalid_source_git_checkpoint');

 const database=requireObject(manifest.database,'invalid_database_manifest');
 if(!Array.isArray(database.tables))fail('invalid_database_tables');
 requireInteger(database.table_count,'invalid_database_table_count');
 requireInteger(database.row_count,'invalid_database_row_count');
 requireInteger(database.bytes,'invalid_database_bytes');
 if(database.table_count!==database.tables.length)fail('database_table_count_mismatch');
 const tableNames=new Set();
 for(const table of database.tables){
  requireObject(table,'invalid_table_manifest');
  if(typeof table.table_name!=='string'||!TABLE_RE.test(table.table_name)||tableNames.has(table.table_name))fail('invalid_table_name');
  tableNames.add(table.table_name);
  requireInteger(table.row_count,'invalid_table_row_count');
  requireInteger(table.bytes,'invalid_table_bytes');
  requireInteger(table.part_count,'invalid_part_count');
  requireHash(table.checksum,'invalid_table_checksum');
  if(!Array.isArray(table.columns)||table.columns.length===0)fail('invalid_table_columns');
  if(!Array.isArray(table.numeric_columns)||!Array.isArray(table.primary_key)||table.primary_key.length===0||!Array.isArray(table.foreign_keys))fail('invalid_table_schema');
  if(!Array.isArray(table.parts)||table.parts.length!==table.part_count||table.part_count<1)fail('part_count_mismatch');
  for(let index=0;index<table.parts.length;index++){
   const part=requireObject(table.parts[index],'invalid_database_part');
   requireInteger(part.row_count,'invalid_part_row_count');
   requireInteger(part.bytes,'invalid_part_bytes');
   requireHash(part.checksum,'invalid_part_checksum');
   const expected=`database/${backupId}/tables/${table.table_name}/part-${String(index+1).padStart(6,'0')}.ndjson`;
   if(part.path!==expected)fail('invalid_database_part_path');
  }
  if(sum(table.parts,'row_count')!==table.row_count)fail('table_row_count_mismatch');
  if(sum(table.parts,'bytes')!==table.bytes)fail('table_bytes_mismatch');
  if(await sha256Hex(table.parts.map(part=>part.checksum).join(''))!==table.checksum)fail('table_checksum_mismatch');
 }
 if(sum(database.tables,'row_count')!==database.row_count)fail('database_row_count_mismatch');
 if(sum(database.tables,'bytes')!==database.bytes)fail('database_bytes_mismatch');

 const storage=requireObject(manifest.storage,'invalid_storage_manifest');
 if(!Array.isArray(storage.objects))fail('invalid_storage_objects');
 requireInteger(storage.file_count,'invalid_storage_file_count');
 requireInteger(storage.bytes,'invalid_storage_bytes');
 if(storage.file_count!==storage.objects.length)fail('storage_file_count_mismatch');
 const sources=new Set();
 for(const object of storage.objects){
  requireObject(object,'invalid_storage_object');
  if(!SOURCE_BUCKETS.has(object.source_bucket))fail('invalid_source_bucket');
  requireSafeObjectPath(object.source_path,'invalid_source_path');
  const sourceKey=`${object.source_bucket}/${object.source_path}`;
  if(sources.has(sourceKey))fail('duplicate_source_object');
  sources.add(sourceKey);
  requireInteger(object.source_size,'invalid_source_size');
  requireHash(object.source_checksum,'invalid_source_checksum');
  requireHash(object.backup_checksum,'invalid_backup_checksum');
  if(object.source_checksum!==object.backup_checksum)fail('storage_checksum_mismatch');
  const expected=`blobs/sha256/${object.backup_checksum.slice(0,2)}/${object.backup_checksum}`;
  if(object.backup_blob_path!==expected)fail('invalid_backup_blob_path');
  if(typeof object.backed_up_at!=='string'||!Number.isFinite(Date.parse(object.backed_up_at)))fail('invalid_backed_up_at');
  if(object.source_updated_at!==null&&object.source_updated_at!==undefined&&(typeof object.source_updated_at!=='string'||!Number.isFinite(Date.parse(object.source_updated_at))))fail('invalid_source_updated_at');
 }
 if(sum(storage.objects,'source_size')!==storage.bytes)fail('storage_bytes_mismatch');
 return true;
}

export function safeBackupError(error){
 const raw=error instanceof Error?error.message:String(error??'backup_failed');
 const redacted=raw
  .replace(/bearer\s+[^\s]+/gi,'Bearer [REDACTED]')
  .replace(/((?:password|token|secret|api[_-]?key|service[_-]?key|credential)\s*[:=]\s*)[^\s,;]+/gi,'$1[REDACTED]')
  .replace(/https?:\/\/[^\s]+/gi,'[REDACTED_URL]')
  .replace(/[\u0000-\u001f\u007f]+/g,' ')
  .trim();
 return (redacted||'backup_failed').slice(0,1000);
}

export const BACKUP_SOURCE_BUCKETS=Object.freeze([...SOURCE_BUCKETS]);
