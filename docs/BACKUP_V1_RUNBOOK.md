# ADMA Automatic Backup V1 Runbook

## Purpose and safety boundary

Backup V1 creates repeatable-read logical snapshots of the 24 classified ADMA application tables and incremental physical copies from `receipts`, `finance-documents`, `project-files`, and `knowledge-files`. It excludes `auth.users`, every system schema, `storage_cleanup_queue`, `backup_runs`, `exports`, secrets, credentials, and session data.

Backups live in the private `adma-backups` bucket in the same Supabase project. This protects against accidental row/file deletion, bad application writes, and bad migrations. It does **not** protect against deletion or loss of the entire Supabase project/account, or simultaneous loss of production and that bucket. Off-site copies are a Backup V2 concern.

Restore V1 is validation and planning only. The shipped Edge action and local wrapper contain no apply, insert, update, delete, truncate, upload, move, or remove path for business data.

## Deployment gate

Before rollout, require a clean Git branch, green `npm run check`, green `npm run test:backup`, green `npm test`, approved Security Review, approved independent code review, and green GitHub Actions. Record the exact deploy commit before changing production.

Apply only `supabase/migrations/20260911123020_add_backup_v1.sql` through the reviewed Supabase migration workflow. Then set the non-secret configuration row to the exact deploy values:

```sql
update private.backup_config
set source_git_checkpoint = '<40-character reviewed deploy commit>',
    spec_checkpoint = 'backup-v1-design-2026-09-11',
    updated_at = now()
where singleton;
```

Deploy only these reviewed functions:

```text
supabase functions deploy backup-adma --project-ref blaacuwwvyatfiyjnsrw --no-verify-jwt
supabase functions deploy storage-cleanup --project-ref blaacuwwvyatfiyjnsrw --no-verify-jwt
```

`verify_jwt=false` is intentional only because both functions enforce their own Vault-backed secret before any action. Never place the Vault value in a command, Git, logs, screenshots, or this document.

## Post-migration verification

Verify the new table is private to `service_role`, the bucket is private, and no Storage policy exposes it:

```sql
select relrowsecurity
from pg_class
where oid = 'public.backup_runs'::regclass;

select grantee,privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'backup_runs'
order by grantee,privilege_type;

select id,public
from storage.buckets
where id = 'adma-backups';

select policyname,roles,cmd
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
  and (qual ilike '%adma-backups%' or with_check ilike '%adma-backups%');

select jobname,schedule,active
from cron.job
where jobname in ('backup-adma-daily-check','storage-cleanup-hourly')
order by jobname;
```

Expected: RLS enabled; no `anon`/`authenticated` grants; `adma-backups.public=false`; no matching Storage policy; backup Cron active at `43 2 * * *`; existing cleanup Cron unchanged at `17 * * * *`.

## Secret-safe manual backup

Trigger through PostgreSQL so the secret never leaves Vault or appears in output. Run exactly once without `force` for the initial backup:

```sql
select net.http_post(
  url := 'https://blaacuwwvyatfiyjnsrw.supabase.co/functions/v1/backup-adma',
  headers := jsonb_build_object(
    'Content-Type','application/json',
    'X-Backup-Secret',(
      select decrypted_secret from vault.decrypted_secrets
      where name = 'backup_cron_secret'
    )
  ),
  body := '{"action":"backup"}'::jsonb,
  timeout_milliseconds := 30000
);
```

The HTTP request returns `202`; completion is asynchronous. Poll only technical fields:

```sql
select backup_id,status,started_at,completed_at,
       now()-completed_at as age,row_count,file_count,
       database_bytes,storage_bytes,total_bytes,duration_ms,warnings,error
from public.backup_runs
order by started_at desc
limit 20;
```

Require one terminal `success`, 24 tables, expected aggregate row/file counts, non-null 64-character checksum, and no stale `running` record. Do not query or print staging bodies, source paths, manifest contents, Vault values, or business rows during routine monitoring.

## First-backup integrity validation

Using technical aggregate queries only, confirm:

1. the manifest exists at `database/<backup_id>/manifest.json` and is the final completion marker;
2. its integrity checksum equals `backup_runs.checksum`;
3. every database part exists and matches its byte count and SHA-256;
4. all 24 table row totals match a fresh read-only count query;
5. every manifest Storage reference points to an existing verified content-addressed blob;
6. source application row counts are unchanged before/after, except documented natural concurrent writes;
7. `backup_runs` remains inaccessible to frontend roles and `adma-backups` remains private.

The approved source-table count query must use `count(*)` only for each classified application table. Never select row contents into rollout logs.

## Restore dry-run

Invoke through Vault-backed `pg_net` by changing only the request body to:

```json
{"action":"restore_dry_run","backup_id":"<validated backup id>"}
```

Or run the local aggregate-only wrapper with environment variables supplied by the operator's shell/secret manager:

```text
node scripts/backup-restore.mjs --backup-id <validated backup id>
```

The wrapper requires `SUPABASE_URL` and `ADMA_BACKUP_SECRET` but never prints their names or values on error. It prints only table order, aggregate row/storage classifications, and validated part/blob counts. Any destructive flag exits with `dry_run_only` before environment access or a network request.

Require manifest, part, blob, schema, and FK validation to pass. Review aggregate `insert`, `existing_identical`, `conflict`, and `missing_dependency` counts. Backup V1 cannot apply the plan.

## Retention and capacity

The ten newest successful snapshots are retained. Failed runs do not consume a retention slot. Database snapshot objects beyond ten are removable; content-addressed blobs are removed only when older than seven days and unreferenced by every validated retained manifest. Missing or invalid retained manifests disable blob deletion. Failed/incomplete snapshot objects wait seven days.

After the first backup, record only aggregate database bytes, manifest bytes, source object count/bytes, unique blob count, total backup bucket bytes, deduplication result, and conservative 30/90-day growth. Stop rollout if ten snapshots could approach the Free-plan 1 GB Storage quota.

## Disable/rollback procedure

If validation fails, do not delete business data or backup artifacts. Disable future backup execution by unscheduling only `backup-adma-daily-check` (leave the existing cleanup Cron untouched), and pause further function deployment. Preserve `backup_runs`, manifests, blobs, and staging evidence for diagnosis. Re-enable scheduling only by reapplying the reviewed Cron definition after a reviewed fix and green validation.

Do not roll back by dropping the bucket, tables, schema, Vault secret, or functions. Those actions can destroy evidence or recoverable data and require a separate destructive-operation plan.
