import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});
const safeError = (error: unknown) => String(error instanceof Error ? error.message : error || 'storage_remove_failed').slice(0, 1000);

Deno.serve(async request => {
  if (request.method !== 'POST') return json({error:'method_not_allowed'},405);
  const suppliedSecret = request.headers.get('x-cleanup-secret') || '';
  if (!suppliedSecret) return json({error:'unauthorized'},401);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {auth:{persistSession:false}});
  const {data:authorized,error:authError} = await db.rpc('verify_storage_cleanup_secret',{candidate:suppliedSecret});
  if (authError || authorized !== true) return json({error:'unauthorized'},401);

  const now = new Date().toISOString();
  const {data:jobs,error:listError} = await db.from('storage_cleanup_queue')
    .select('id,bucket,object_path,attempts')
    .is('completed_at',null)
    .lte('next_attempt_at',now)
    .order('created_at',{ascending:true})
    .limit(50);
  if (listError) return json({error:'queue_unavailable'},500);

  let completed = 0;
  let failed = 0;
  for (const job of jobs || []) {
    const {error:removeError} = await db.storage.from(job.bucket).remove([job.object_path]);
    if (!removeError) {
      const {error:updateError} = await db.from('storage_cleanup_queue').update({completed_at:new Date().toISOString(),last_error:null}).eq('id',job.id).is('completed_at',null);
      if (updateError) failed += 1;
      else completed += 1;
      continue;
    }
    const attempts = Number(job.attempts || 0) + 1;
    const delayMinutes = Math.min(24 * 60, 5 * (2 ** Math.min(attempts, 8)));
    const {error:updateError} = await db.from('storage_cleanup_queue').update({
      attempts,
      last_error:safeError(removeError),
      next_attempt_at:new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
    }).eq('id',job.id).is('completed_at',null);
    failed += 1;
    if (updateError) console.error('storage_cleanup_queue_update_failed');
  }
  console.log(JSON.stringify({event:'storage_cleanup_completed',selected:(jobs||[]).length,completed,failed}));
  return json({ok:true,selected:(jobs||[]).length,completed,failed});
});
