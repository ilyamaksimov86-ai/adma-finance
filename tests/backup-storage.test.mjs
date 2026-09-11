import test from 'node:test';
import assert from 'node:assert/strict';
import {
 listAllSourceObjects,ensureBackupBlob,backupStorage,validateStorageEntries,
} from '../supabase/functions/_shared/backup/storage.mjs';

function storageFixture(seed={}){
 const files=new Map();
 for(const [key,value] of Object.entries(seed))files.set(key,new TextEncoder().encode(value));
 const calls={list:[],download:[],upload:[],remove:[]};
 return {
  files,calls,uploadConflict:false,
  async list(bucket,{prefix='',limit,offset}){
   calls.list.push({bucket,prefix,limit,offset});
   const direct=[];
   const folders=new Set();
   for(const [key,bytes] of files){
    const marker=`${bucket}/`;
    if(!key.startsWith(marker))continue;
    const path=key.slice(marker.length);
    if(prefix&&!path.startsWith(`${prefix}/`))continue;
    const rest=prefix?path.slice(prefix.length+1):path;
    if(rest.includes('/'))folders.add(rest.split('/')[0]);
    else if(rest)direct.push({name:rest,size:bytes.byteLength,updated_at:'2026-09-11T00:00:00.000Z',metadata:{mimetype:'application/octet-stream',eTag:'etag'}});
   }
   const rows=[...folders].map(name=>({name,id:null,metadata:null,isFolder:true})).concat(direct).sort((a,b)=>a.name.localeCompare(b.name));
   return rows.slice(offset,offset+limit);
  },
  async download(bucket,path){
   calls.download.push({bucket,path});
   const bytes=files.get(`${bucket}/${path}`);
   if(!bytes){const error=new Error('not found');error.status=404;throw error;}
   return bytes.slice();
  },
  async upload(bucket,path,bytes,options){
   calls.upload.push({bucket,path,options});
   const key=`${bucket}/${path}`;
   if(this.uploadConflict){this.uploadConflict=false;files.set(key,new Uint8Array(bytes));const error=new Error('already exists');error.status=409;throw error;}
   if(files.has(key)&&options?.upsert===false){const error=new Error('already exists');error.status=409;throw error;}
   files.set(key,new Uint8Array(bytes));
  },
  async remove(bucket,paths){calls.remove.push({bucket,paths});for(const path of paths)files.delete(`${bucket}/${path}`);},
 };
}

function fakePagedStorage(objects){
 return {list:async(_bucket,{offset,limit})=>objects.slice(offset,offset+limit)};
}

test('pagination continues beyond one thousand objects',async()=>{
 const objects=Array.from({length:1205},(_,i)=>({name:`file-${String(i).padStart(4,'0')}`,size:1,updated_at:'2026-09-11T00:00:00Z'}));
 const listed=await listAllSourceObjects(fakePagedStorage(objects),'receipts');
 assert.equal(listed.length,1205);
 assert.equal(listed.at(-1).path,'file-1204');
});

test('empty buckets and recursive folders produce stable relative paths',async()=>{
 assert.deepEqual(await listAllSourceObjects(storageFixture(),'receipts'),[]);
 const adapter=storageFixture({
  'receipts/z.txt':'z','receipts/a/second.txt':'2','receipts/a/deep/first.txt':'1',
 });
 const listed=await listAllSourceObjects(adapter,'receipts');
 assert.deepEqual(listed.map(item=>item.path),['a/deep/first.txt','a/second.txt','z.txt']);
});

test('unchanged content reuses a verified content-addressed blob',async()=>{
 const adapter=storageFixture({'receipts/a.txt':'same'});
 const object=(await listAllSourceObjects(adapter,'receipts'))[0];
 const first=await ensureBackupBlob(adapter,object,new Date('2026-09-11T12:00:00Z'));
 const uploads=adapter.calls.upload.length;
 const second=await ensureBackupBlob(adapter,object,new Date('2026-09-11T13:00:00Z'));
 assert.equal(second.backup_blob_path,first.backup_blob_path);
 assert.equal(adapter.calls.upload.length,uploads);
 assert.equal(first.backup_checksum,first.source_checksum);
});

test('changed source content creates a different hash path',async()=>{
 const adapter=storageFixture({'receipts/a.txt':'first'});
 const before=await ensureBackupBlob(adapter,(await listAllSourceObjects(adapter,'receipts'))[0],new Date());
 adapter.files.set('receipts/a.txt',new TextEncoder().encode('second'));
 const after=await ensureBackupBlob(adapter,(await listAllSourceObjects(adapter,'receipts'))[0],new Date());
 assert.notEqual(after.backup_blob_path,before.backup_blob_path);
 assert.equal(adapter.files.has(`adma-backups/${before.backup_blob_path}`),true);
});

test('an upload race is accepted only after checksum verification',async()=>{
 const adapter=storageFixture({'receipts/a.txt':'race'});
 const object=(await listAllSourceObjects(adapter,'receipts'))[0];
 const expected='blobs/sha256/12/129ce50dd90bf244858763d3f10932a9f6d8a521ad4f2c946574e9a566e04054';
 adapter.uploadConflict=true;
 const entry=await ensureBackupBlob(adapter,object,new Date());
 assert.equal(entry.backup_blob_path,expected);
 assert.equal(adapter.calls.upload.at(-1).options.upsert,false);
});

test('a prior blob survives source deletion and remains independently valid',async()=>{
 const adapter=storageFixture({'project-files/p/photo.jpg':'photo'});
 const entry=await ensureBackupBlob(adapter,(await listAllSourceObjects(adapter,'project-files'))[0],new Date());
 adapter.files.delete('project-files/p/photo.jpg');
 assert.equal(await validateStorageEntries(adapter,[entry]),true);
 assert.equal(adapter.files.has(`adma-backups/${entry.backup_blob_path}`),true);
});

test('validation rejects missing and corrupted backup blobs',async()=>{
 const adapter=storageFixture({'knowledge-files/card/file.pdf':'content'});
 const entry=await ensureBackupBlob(adapter,(await listAllSourceObjects(adapter,'knowledge-files'))[0],new Date());
 adapter.files.set(`adma-backups/${entry.backup_blob_path}`,new TextEncoder().encode('corrupt'));
 await assert.rejects(()=>validateStorageEntries(adapter,[entry]),/backup_blob_checksum_mismatch/);
 adapter.files.delete(`adma-backups/${entry.backup_blob_path}`);
 await assert.rejects(()=>validateStorageEntries(adapter,[entry]),/backup_blob_missing/);
});

test('backup maps metadata and excludes exports and backup recursion',async()=>{
 const adapter=storageFixture({
  'receipts/r.txt':'r','finance-documents/f.txt':'ff','project-files/p.txt':'ppp',
  'knowledge-files/k.txt':'kkkk','exports/report.pdf':'ignored','adma-backups/source.txt':'ignored',
 });
 const entries=await backupStorage(adapter,new Date('2026-09-11T12:00:00.000Z'));
 assert.deepEqual(entries.map(item=>item.source_bucket),['receipts','finance-documents','project-files','knowledge-files']);
 assert.deepEqual(entries.map(item=>item.source_size),[1,2,3,4]);
 assert.ok(entries.every(item=>item.source_mime_type==='application/octet-stream'&&item.source_etag==='etag'));
 assert.equal(adapter.calls.list.some(call=>call.bucket==='exports'||call.bucket==='adma-backups'),false);
 await assert.rejects(()=>listAllSourceObjects(adapter,'exports'),/invalid_source_bucket/);
 await assert.rejects(()=>listAllSourceObjects(adapter,'adma-backups'),/invalid_source_bucket/);
});
