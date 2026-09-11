import {assertBackupId,assertManifestRunBinding,validateManifest} from './core.mjs';

const SEVEN_DAYS_MS=7*24*60*60*1000;
const BLOB_RE=/^blobs\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

function manifestFor(manifests,id){return manifests instanceof Map?manifests.get(id):manifests?.[id];}
function oldEnough(value,nowMs){const time=new Date(value).getTime();return Number.isFinite(time)&&nowMs-time>=SEVEN_DAYS_MS;}

export async function planRetention(successes,manifests,blobs,now=new Date(),target=10,expectedTables){
 if(!Array.isArray(successes)||!Array.isArray(blobs))throw new Error('invalid_retention_input');
 if(!Number.isSafeInteger(target)||target<1)throw new Error('invalid_retention_target');
 const nowMs=(now instanceof Date?now:new Date(now)).getTime();
 if(!Number.isFinite(nowMs))throw new Error('invalid_retention_time');

 const successful=successes
  .filter(run=>run?.status==='success')
  .map(run=>({...run,backup_id:assertBackupId(run.backup_id),completed_ms:new Date(run.completed_at).getTime()}));
 if(successful.some(run=>!Number.isFinite(run.completed_ms)))throw new Error('invalid_success_time');
 successful.sort((a,b)=>b.completed_ms-a.completed_ms||b.backup_id.localeCompare(a.backup_id));
 const retained=successful.slice(0,target);
 const expired=successful.slice(target);
 const retainedIds=new Set(retained.map(run=>run.backup_id));
 const expiredIds=new Set(expired.map(run=>run.backup_id));
 const allSuccessIds=new Set(successful.map(run=>run.backup_id));
 const warnings=[];
 const snapshotDeletes=new Set();

 for(const object of blobs){
  if(typeof object?.path!=='string')continue;
  const match=object.path.match(/^database\/([^/]+)\//);
  if(!match)continue;
  let id;
  try{id=assertBackupId(match[1]);}catch{warnings.push('invalid_snapshot_object_path');continue;}
  if(expiredIds.has(id)||(!allSuccessIds.has(id)&&oldEnough(object.created_at,nowMs)))snapshotDeletes.add(object.path);
 }

 let canDeleteBlobs=retained.length>=target;
 const referenced=new Set();
 if(canDeleteBlobs){
  for(const run of retained){
   const manifest=manifestFor(manifests,run.backup_id);
   try{
    if(!manifest||manifest.backup_id!==run.backup_id)throw new Error('missing_manifest');
    await validateManifest(manifest,expectedTables);
    assertManifestRunBinding(manifest,run,`database/${run.backup_id}/manifest.json`);
    for(const entry of manifest.storage.objects)referenced.add(entry.backup_blob_path);
   }catch{
    canDeleteBlobs=false;
    break;
   }
  }
 }
 if(!canDeleteBlobs)warnings.push('blob_cleanup_disabled_invalid_retained_manifest');

 const blobDeletes=[];
 if(canDeleteBlobs){
  for(const object of blobs){
   if(typeof object?.path!=='string')continue;
   const match=object.path.match(BLOB_RE);
   if(!match)continue;
   if(match[1]!==match[2].slice(0,2)){warnings.push('invalid_blob_path');continue;}
   if(!referenced.has(object.path)&&oldEnough(object.created_at,nowMs))blobDeletes.push(object.path);
  }
 }

 return {
  retained_backup_ids:[...retainedIds],
  expired_backup_ids:[...expiredIds],
  snapshot_paths_to_delete:[...snapshotDeletes].sort(),
  blob_paths_to_delete:blobDeletes.sort(),
  warnings:[...new Set(warnings)].sort(),
 };
}
