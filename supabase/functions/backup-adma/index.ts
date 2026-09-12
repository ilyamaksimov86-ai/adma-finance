import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { assertBackupId } from "../_shared/backup/core.mjs";
import { createSupabaseBackupDeps, runBackup, runRestoreDryRun } from "../_shared/backup/orchestrator.mjs";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

Deno.serve(async request => {
  if (request.method !== 'POST') return json({error:'method_not_allowed'},405);
  const suppliedSecret=request.headers.get('x-backup-secret')||'';
  if(!suppliedSecret)return json({error:'unauthorized'},401);

  const db=createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    {auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}},
  );
  const {data:authorized,error:authError}=await db.rpc('verify_backup_secret',{candidate:suppliedSecret});
  if(authError||authorized!==true)return json({error:'unauthorized'},401);

  let body: {action?: unknown;force?: unknown;backup_id?: unknown};
  try{
    const parsed=await request.json();
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return json({error:'invalid_json'},400);
    body=parsed;
  }catch{return json({error:'invalid_json'},400);}
  const action=body.action??'backup';
  const deps=createSupabaseBackupDeps(db);
  const config=await deps.db.readConfig();
  if(!config||typeof config.source_git_checkpoint!=='string'||!(/^[0-9a-f]{40}$/).test(config.source_git_checkpoint)||typeof config.spec_checkpoint!=='string'||!config.spec_checkpoint){
    return json({error:'backup_config_incomplete'},503);
  }
  deps.sourceGitCheckpoint=config.source_git_checkpoint;
  deps.specCheckpoint=config.spec_checkpoint;

  if(action==='backup'){
    if(body.force!==undefined&&typeof body.force!=='boolean')return json({error:'invalid_force'},400);
    EdgeRuntime.waitUntil(runBackup(deps,{force:body.force===true}));
    return json({status:'accepted'},202);
  }
  if(action==='restore_dry_run'){
    try{
      const backupId=assertBackupId(body.backup_id);
      return json(await runRestoreDryRun(deps,backupId));
    }catch(error){
      const code=error instanceof Error&&/^[a-z][a-z0-9_]{0,79}$/.test(error.message)?error.message:'restore_dry_run_failed';
      return json({error:code},400);
    }
  }
  return json({error:'unsupported_action'},400);
});
