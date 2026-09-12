import {BACKUP_SOURCE_BUCKETS,sha256Hex} from './core.mjs';

const BACKUP_BUCKET='adma-backups';
const PAGE_SIZE=1000;
const MAX_OBJECT_BYTES=8*1024*1024;
const SOURCE_BUCKETS=new Set(BACKUP_SOURCE_BUCKETS);

function fail(code){throw new Error(code);}

function assertSourceBucket(bucket){
 if(!SOURCE_BUCKETS.has(bucket))fail('invalid_source_bucket');
 return bucket;
}

function assertRelativePath(path){
 if(typeof path!=='string'||path.length<1||path.length>1000||path.startsWith('/')||path.includes('\\')||/[\u0000-\u001f\u007f]/.test(path)||path.split('/').some(part=>part===''||part==='.'||part==='..'))fail('invalid_storage_path');
 return path;
}

function isFolder(item){
 return item?.isFolder===true||item?.type==='folder'||(item?.id==null&&item?.metadata==null&&item?.size==null);
}

function unwrap(value){
 if(value&&typeof value==='object'&&'error' in value){
  if(value.error)throw value.error;
  return value.data;
 }
 return value;
}

async function toBytes(value){
 const data=unwrap(value);
 if(data instanceof Uint8Array)return data;
 if(data instanceof ArrayBuffer)return new Uint8Array(data);
 if(ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
 if(data&&typeof data.arrayBuffer==='function')return new Uint8Array(await data.arrayBuffer());
 fail('invalid_storage_bytes');
}

function isStatus(error,status){
 return Number(error?.status??error?.statusCode)===status||String(error?.code??'')===String(status);
}

async function downloadBytes(adapter,bucket,path,maxBytes=MAX_OBJECT_BYTES){
 const value=typeof adapter.downloadBounded==='function'
  ?await adapter.downloadBounded(bucket,path,maxBytes)
  :await adapter.download(bucket,path);
 const bytes=await toBytes(value);
 if(bytes.byteLength>maxBytes)fail('storage_object_too_large');
 return bytes;
}

async function downloadOptional(adapter,bucket,path,maxBytes=MAX_OBJECT_BYTES){
 try{return await downloadBytes(adapter,bucket,path,maxBytes);}
 catch(error){if(isStatus(error,404)||error?.code==='not_found')return null;throw error;}
}

function listedSize(item){
 const value=item?.size??item?.metadata?.size;
 return Number.isSafeInteger(value)&&value>=0?value:null;
}

function normalizedObject(bucket,prefix,item){
 const path=assertRelativePath(prefix?`${prefix}/${item.name}`:item.name);
 return {
  bucket,path,
  size:listedSize(item),
  mimeType:item?.mime_type??item?.mimeType??item?.metadata?.mimetype??item?.metadata?.contentType??null,
  updatedAt:item?.updated_at??item?.updatedAt??null,
  etag:item?.etag??item?.eTag??item?.metadata?.eTag??item?.metadata?.etag??null,
 };
}

export async function listAllSourceObjects(adapter,bucket,{maxPages=10000}={}){
 assertSourceBucket(bucket);
 if(!adapter||typeof adapter.list!=='function')fail('invalid_storage_adapter');
 if(!Number.isSafeInteger(maxPages)||maxPages<1)fail('invalid_storage_page_limit');
 const objects=[];
 const pending=[''];
 const visited=new Set();
 while(pending.length){
  const prefix=pending.shift();
  if(visited.has(prefix))fail('storage_folder_cycle');
  visited.add(prefix);
  let offset=0;
  let previousFingerprint=null;
  for(let page=0;page<maxPages;page++){
   const rows=unwrap(await adapter.list(bucket,{prefix,limit:PAGE_SIZE,offset,sortBy:{column:'name',order:'asc'}}));
   if(!Array.isArray(rows))fail('invalid_storage_listing');
   const fingerprint=rows.map(item=>`${item?.name}:${isFolder(item)?'d':'f'}`).join('|');
   if(rows.length===PAGE_SIZE&&offset>0&&fingerprint===previousFingerprint)fail('storage_pagination_stalled');
   previousFingerprint=fingerprint;
   for(const item of rows){
    if(!item||typeof item.name!=='string'||!item.name||item.name.includes('/'))fail('invalid_storage_listing');
    const path=assertRelativePath(prefix?`${prefix}/${item.name}`:item.name);
    if(isFolder(item))pending.push(path);
    else objects.push(normalizedObject(bucket,prefix,item));
   }
   if(rows.length<PAGE_SIZE)break;
   if(page===maxPages-1)fail('storage_pagination_limit');
   offset+=rows.length;
  }
 }
 return objects.sort((a,b)=>a.path.localeCompare(b.path));
}

async function verifyBlob(adapter,path,expectedHash,missingCode='backup_blob_missing'){
 const bytes=await downloadOptional(adapter,BACKUP_BUCKET,path);
 if(bytes===null)fail(missingCode);
 if(await sha256Hex(bytes)!==expectedHash)fail('backup_blob_checksum_mismatch');
 return bytes;
}

export async function ensureBackupBlob(adapter,object,now=new Date()){
 assertSourceBucket(object?.bucket);
 assertRelativePath(object?.path);
 if(!Number.isSafeInteger(object?.size)||object.size<0)fail('source_size_unavailable');
 if(object.size>MAX_OBJECT_BYTES)fail('source_object_too_large');
 const sourceBytes=await downloadBytes(adapter,object.bucket,object.path,MAX_OBJECT_BYTES);
 if(object.size!==null&&object.size!==undefined&&object.size!==sourceBytes.byteLength)fail('source_size_mismatch');
 const checksum=await sha256Hex(sourceBytes);
 const blobPath=`blobs/sha256/${checksum.slice(0,2)}/${checksum}`;
 const existing=await downloadOptional(adapter,BACKUP_BUCKET,blobPath);
 if(existing!==null){
  if(await sha256Hex(existing)!==checksum)fail('backup_blob_checksum_mismatch');
 }else{
  try{
   unwrap(await adapter.upload(BACKUP_BUCKET,blobPath,sourceBytes,{upsert:false,contentType:'application/octet-stream'}));
  }catch(error){
   if(!isStatus(error,409)&&error?.code!=='already_exists')throw error;
  }
 }
 await verifyBlob(adapter,blobPath,checksum);
 const backedUpAt=(now instanceof Date?now:new Date(now)).toISOString();
 return {
  source_bucket:object.bucket,
  source_path:object.path,
  source_size:sourceBytes.byteLength,
  source_mime_type:object.mimeType??null,
  source_updated_at:object.updatedAt??null,
  source_etag:object.etag??null,
  source_checksum:checksum,
  backup_blob_path:blobPath,
  backup_checksum:checksum,
  backed_up_at:backedUpAt,
 };
}

export async function backupStorage(adapter,now=new Date()){
 const entries=[];
 for(const bucket of BACKUP_SOURCE_BUCKETS){
  const before=await listAllSourceObjects(adapter,bucket);
  for(const object of before)entries.push(await ensureBackupBlob(adapter,object,now));
  const after=await listAllSourceObjects(adapter,bucket);
  const inventory=objects=>JSON.stringify(objects.map(({path,size,mimeType,updatedAt,etag})=>({path,size,mimeType,updatedAt,etag})));
  if(inventory(before)!==inventory(after))fail('storage_inventory_changed');
 }
 return entries;
}

export async function validateStorageEntries(adapter,entries){
 if(!Array.isArray(entries))fail('invalid_storage_entries');
 for(const entry of entries){
  assertSourceBucket(entry?.source_bucket);
  assertRelativePath(entry?.source_path);
  if(typeof entry.backup_checksum!=='string'||!/^[0-9a-f]{64}$/.test(entry.backup_checksum))fail('invalid_backup_checksum');
  const expected=`blobs/sha256/${entry.backup_checksum.slice(0,2)}/${entry.backup_checksum}`;
  if(entry.backup_blob_path!==expected)fail('invalid_backup_blob_path');
  const bytes=await verifyBlob(adapter,entry.backup_blob_path,entry.backup_checksum);
  if(!Number.isSafeInteger(entry.source_size)||entry.source_size<0||entry.source_size!==bytes.byteLength)fail('backup_blob_size_mismatch');
 }
 return true;
}

export const BACKUP_STORAGE_BUCKET=BACKUP_BUCKET;
