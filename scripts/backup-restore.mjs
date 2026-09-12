import {pathToFileURL} from 'node:url';
import {assertBackupId} from '../supabase/functions/_shared/backup/core.mjs';

const FORBIDDEN_FLAGS=new Set(['--apply','--restore','--target-production','--allow-destructive']);
const PRODUCTION_ORIGIN='https://blaacuwwvyatfiyjnsrw.supabase.co';
const DATABASE_FIELDS=['insert','existing_identical','conflict','missing_dependency','total'];
const STORAGE_FIELDS=['insert','existing_identical','conflict','total'];

function fail(code){throw new Error(code);}
function pick(value,fields){const result={};for(const field of fields)result[field]=value?.[field];return result;}

export function parseArgs(argv){
 if(argv.some(value=>FORBIDDEN_FLAGS.has(value)))fail('dry_run_only');
 if(argv.length!==2||argv[0]!=='--backup-id'||typeof argv[1]!=='string')fail('invalid_arguments');
 return {backupId:assertBackupId(argv[1])};
}

export function buildRequest({backupId,url,secret}){
 assertBackupId(backupId);
 if(typeof url!=='string'||typeof secret!=='string'||!url||!secret)fail('missing_backup_environment');
 let endpoint;
 try{endpoint=new URL('/functions/v1/backup-adma',url);}catch{fail('invalid_backup_url');}
 let supplied;
 try{supplied=new URL(url);}catch{fail('invalid_backup_url');}
 if(supplied.origin!==PRODUCTION_ORIGIN||supplied.username||supplied.password||endpoint.origin!==PRODUCTION_ORIGIN)fail('invalid_backup_url');
 return {
  url:endpoint.href,
  init:{
   method:'POST',
   headers:{'Content-Type':'application/json','X-Backup-Secret':secret},
   body:JSON.stringify({action:'restore_dry_run',backup_id:backupId}),
  },
 };
}

export function selectAggregateOutput(value){
 return {
  mode:value?.mode,
  backup_id:value?.backup_id,
  table_order:Array.isArray(value?.table_order)?value.table_order:[],
  database:pick(value?.database,DATABASE_FIELDS),
  storage:pick(value?.storage,STORAGE_FIELDS),
  validated_parts:value?.validated_parts,
  validated_blobs:value?.validated_blobs,
 };
}

export async function main(argv=process.argv.slice(2),environment=process.env,fetchImpl=fetch){
 const {backupId}=parseArgs(argv);
 const request=buildRequest({backupId,url:environment.SUPABASE_URL,secret:environment.ADMA_BACKUP_SECRET});
 const response=await fetchImpl(request.url,request.init);
 if(!response.ok)fail(`restore_request_${response.status}`);
 const result=selectAggregateOutput(await response.json());
 process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(error=>{
  const code=error instanceof Error&&/^[a-z][a-z0-9_]{0,79}$/.test(error.message)?error.message:'backup_restore_failed';
  process.stderr.write(`${code}\n`);
  process.exitCode=1;
 });
}
