# ADMA Automatic Backup V1 Design

## Status and scope

This design implements the approved Automatic Backup V1 subsystem for the ADMA production project `blaacuwwvyatfiyjnsrw`. The base Git checkpoint is `9ddebffea4ced78aa3002f7c1fe5b2d1255fa3e0`.

Backup V1 creates automatic logical snapshots of ADMA application tables and physical, incremental copies of user files. It adds no frontend, changes no finance or application behavior, does not back up `auth.users`, and never performs an automatic production restore.

Backup V1 is intentionally stored in the same Supabase project. It protects against accidental row or file deletion, bad updates, application defects, and bad migrations. It does not protect against loss or deletion of the entire Supabase project, loss of the Supabase account, or simultaneous loss of production and the backup bucket. Off-site storage is Backup V2 and is outside this scope.

## Production audit baseline

The read-only audit on 2026-09-11 found:

- PostgreSQL 17.6 on an active healthy Supabase Free-plan project.
- 25 `public` tables, all with RLS enabled and no frontend policies.
- 24 ADMA application tables and one existing internal table, `storage_cleanup_queue`.
- 111 application rows and approximately 76 KB of current logical JSON payload.
- Five private Storage buckets: `receipts`, `finance-documents`, `project-files`, `knowledge-files`, and `exports`.
- Two source objects in `receipts`, totalling 242,782 bytes. The other current object is a regeneratable PDF in `exports` and is not a Backup V1 source.
- One active Cron job, `storage-cleanup-hourly`, scheduled at `17 * * * *`, authenticated through Vault.
- The deployed `storage-cleanup` function matches the repository. Its queue constraint excludes `adma-backups`, but the worker has no explicit runtime guard. The queue constraint also predates `knowledge-files`, although Knowledge Base deletion already uses the cleanup helper; this pre-existing mismatch is recorded but is not broadened in this additive-only backup migration.
- No existing `adma-backups` bucket, backup function, backup tables, or backup Cron job.

No production contradiction blocks the design. The Free-plan Edge Function limits of 150 seconds wall-clock and 256 MB memory are material. The current dataset is small enough for V1, but the implementation must use bounded chunks, a deadline, and recover stale runs rather than assuming unlimited execution time.

## Application data classification

The snapshot includes these 24 tables:

- `app_users`
- `company_expenses`
- `designer_interactions`
- `designers`
- `expenses`
- `finance_act_costs`
- `finance_act_payments`
- `finance_acts`
- `finance_waybill_payments`
- `finance_waybills`
- `knowledge_attachments`
- `knowledge_issues`
- `knowledge_tech_cards`
- `knowledge_tech_checklist_items`
- `lead_interactions`
- `leads`
- `master_assignments`
- `masters`
- `project_documents`
- `project_members`
- `project_photos`
- `project_stages`
- `project_tasks`
- `projects`

`app_users` contains identifiers and profile data, including `web_login`, but contains no password, password hash, access token, refresh token, session secret, API key, or service key. All current columns are included because the identifiers are required to restore application relations and account mapping. `auth.users` and all system schemas remain excluded.

The migration creates a private table registry that explicitly classifies every current `public` table as included or excluded. `backup_runs` and `storage_cleanup_queue` are excluded. Snapshot preparation fails on an unclassified future `public` table or a newly introduced secret-like column name. This prevents both silent omission of new business data and accidental capture of new credentials.

Excluded data includes:

- `auth`, `storage`, `realtime`, Vault, Cron, catalog, extension, and other system schemas;
- `backup_runs` and all private backup staging tables;
- `storage_cleanup_queue`;
- passwords, password hashes, tokens, secrets, keys, credentials, sessions, and environment values;
- `auth.users` and Supabase Auth internals.

## Database schema additions

The additive migration creates `public.backup_runs` with:

- `id uuid primary key default gen_random_uuid()`;
- `started_at timestamptz not null default now()`;
- `completed_at timestamptz null`;
- `status text not null`, constrained to `running`, `success`, or `failed`;
- `backup_id text not null unique`;
- `backup_path text not null`;
- `table_count integer not null default 0`;
- `row_count bigint not null default 0`;
- `file_count bigint not null default 0`;
- `database_bytes bigint not null default 0`;
- `storage_bytes bigint not null default 0`;
- `total_bytes bigint not null default 0`;
- `checksum text null`;
- `error text null`;
- `format_version integer not null default 1`;
- `duration_ms bigint null`;
- `warnings jsonb not null default '[]'::jsonb`;
- `metadata jsonb not null default '{}'::jsonb`;
- `created_at timestamptz not null default now()`.

Checks enforce non-negative counts and sizes, valid SHA-256 strings, bounded identifier/path/error lengths, and coherent terminal timestamps. A partial unique index permits only one `running` row. A second index supports lookup of the newest successful run.

RLS is enabled. All privileges are revoked from `PUBLIC`, `anon`, and `authenticated`; only `service_role` receives the minimum required access. No frontend policy is created and `backup_runs` is not added to normal application APIs or state.

A non-exposed `private` schema holds:

- `backup_table_registry`, which classifies source tables and excluded columns;
- `backup_snapshot_chunks`, which holds deterministic NDJSON chunks until upload completes;
- `backup_snapshot_tables`, which holds per-table schema, count, byte, part, and checksum metadata.

Only the service role can use the schema. The Edge Function accesses it through narrowly scoped RPC functions in `public`. Every RPC revokes default `PUBLIC`, `anon`, and `authenticated` execution.

## Consistent database snapshot

The Edge Function calls one volatile snapshot-preparation RPC. PostgREST executes the RPC in one transaction, and the function sets `default_transaction_isolation` to `repeatable read`. All application tables therefore observe one consistent PostgreSQL snapshot while chunks are generated.

The RPC:

1. validates the registry against the live `public` schema;
2. validates every table has a primary key;
3. captures columns, types, primary keys, and foreign keys;
4. orders rows by the complete primary key;
5. renders columns in schema ordinal order;
6. casts every PostgreSQL `numeric`/`decimal` value to a JSON string before serialization;
7. preserves UUIDs, nulls, booleans, timestamps, dates, arrays, JSON, and JSONB;
8. writes deterministic NDJSON chunks of at most 500 rows;
9. creates one zero-byte chunk for an empty table;
10. calculates SHA-256 for each chunk and a deterministic aggregate checksum for each table.

The raw serialized body crosses PostgREST as text and is never parsed and re-serialized by JavaScript. This avoids JavaScript floating-point conversion and preserves financial numeric precision.

Output paths are:

```text
database/<backup_id>/tables/<table>/part-000001.ndjson
database/<backup_id>/tables/<table>/part-000002.ndjson
database/<backup_id>/manifest.json
```

Each manifest table entry records its ordered parts, part row counts, part byte counts, part checksums, total row count, total bytes, table checksum, columns, numeric columns, primary key, and foreign keys.

## Storage snapshot and deduplication

The source bucket allowlist is fixed to:

- `receipts`;
- `finance-documents`;
- `project-files`;
- `knowledge-files`.

`exports`, `adma-backups`, temporary buckets, and system buckets are never iterated. The allowlist is checked both by orchestration code and automated recursive-backup tests.

Objects are listed recursively with bounded pagination and deterministic ordering. Each source file is downloaded, hashed with SHA-256, and stored at:

```text
blobs/sha256/<first-two-hex>/<full-sha256>
```

Before reuse, an existing blob is downloaded and its checksum is verified. A changed source file creates a different content-addressed blob; an unchanged file reuses the verified blob. Upload races use `upsert: false`; a conflict is accepted only after the existing blob passes checksum validation.

Every storage manifest entry contains `source_bucket`, `source_path`, `source_size`, `source_mime_type`, `source_updated_at`, source ETag when available, `source_checksum`, `backup_blob_path`, `backup_checksum`, and `backed_up_at`. The backup survives deletion of the source object because the manifest references a physical backup blob, not only the original path.

Storage cannot provide one transactionally frozen view across objects. The worker therefore captures a deterministic inventory before copying each source bucket and repeats it after the copy. The run fails on any observable path, size, MIME type, update timestamp, or ETag difference. Pagination fails closed on a stalled page or the explicit page ceiling; it never treats a ceiling as end-of-list.

## Atomic completion and failure handling

A backup identifier is an UTC timestamp plus a random UUID suffix, for example `2026-09-11T120000Z_<uuid>`. Only a strict generated format is accepted in paths.

The lifecycle is:

1. atomically claim a run;
2. insert `backup_runs.status = 'running'`;
3. prepare the repeatable-read database snapshot;
4. upload and verify every database chunk;
5. copy and verify every source Storage object;
6. build the canonical manifest;
7. validate counts, sizes, parts, blobs, and checksums;
8. upload `manifest.json` last with `status = 'complete'`;
9. download and validate the manifest marker;
10. mark `backup_runs.status = 'success'`;
11. clear database staging rows;
12. apply retention.

A snapshot is valid only when both the final manifest passes integrity validation and the matching `backup_runs` row is `success`. Any exception before that point marks the run `failed` with a bounded, sanitized error. User rows, file contents, paths, and secrets are never logged.

The handler returns `202 Accepted` after calling `EdgeRuntime.waitUntil`, so the 30-second `pg_net` request timeout does not terminate work. The background task enforces an internal deadline below the 150-second Free-plan wall-clock limit. If the platform terminates the worker unexpectedly, a later invocation marks a sufficiently old `running` row failed before claiming a new run.

## Authentication, Cron, and idempotency

The migration creates a random `backup_cron_secret` in Vault only when it does not already exist. A service-only `verify_backup_secret(candidate text)` RPC follows the existing storage-cleanup pattern.

`backup-adma` accepts only `POST` with `X-Backup-Secret`. Gateway JWT verification remains disabled because the Cron caller uses the private custom-secret mechanism; the function body rejects missing or invalid secrets before any backup work. The endpoint returns only technical identifiers, status, counts, sizes, duration, and sanitized error codes.

The Cron job `backup-adma-daily-check` runs at `43 2 * * *` UTC. This avoids the existing hourly cleanup at minute 17. The claim RPC atomically:

- returns `skipped_recent` without creating a row when the newest successful backup is less than 72 hours old;
- returns `already_running` when a non-stale run exists;
- marks a stale running row failed before starting a replacement;
- creates exactly one running row under concurrent calls.

An authenticated maintenance request may set `force: true`. It bypasses only the 72-hour age check; it does not bypass concurrency, validation, privacy, or integrity checks.

Backup claims and retention use the same advisory-lock-protected database maintenance lease. Retention refuses to start while a run is active, and claims return `maintenance_busy` while retention is active, including forced claims. Both stale running backups and stale retention leases are recovered after 15 minutes.

## Retention and incomplete cleanup

The target is the ten newest successful snapshots. Retention never deletes the newest successful snapshot.

For snapshots beyond ten, the worker deletes their database part objects and manifest only after confirming the retained set. Before deleting a content-addressed blob, it loads and validates every retained manifest and constructs the complete referenced-blob set. If any retained manifest is missing or invalid, blob deletion stops safely and records a warning.

Failed/incomplete snapshot objects older than seven days may be removed, while their `backup_runs` metadata remains for diagnosis. Orphan blobs must be older than seven days and unreferenced by every validated retained manifest before deletion. This safety window also protects against an upload race.

The maintenance lease removes the remaining content-addressed-blob race: a concurrent backup cannot begin between retention reference discovery and deletion. Every retained manifest must also match its `backup_runs` id, backup id, checksum, and recorded manifest path; any mismatch disables blob deletion.

At the audited size, ten database snapshots are expected to consume under 1 MB plus manifests. Existing source file blobs add about 0.24 MB. Even the conservative case where all current source bytes change on every retained snapshot remains only a few megabytes, far below the Free-plan 1 GB Storage quota. Actual measurements after the first backup replace these estimates in the rollout report.

## Restore dry-run

No automatic or destructive production restore endpoint is implemented.

The same maintenance function exposes `restore_dry_run` for an existing successful `backup_id`. A local `scripts/backup-restore.mjs` wrapper defaults to this action and reads URL and maintenance secret only from environment variables. It never prints credentials.

Dry-run:

1. resolves the backup only through `backup_runs`;
2. downloads and schema-validates the manifest with strict size and path limits;
3. validates format and implementation versions;
4. validates manifest integrity;
5. downloads every database part and checks bytes, row counts, and SHA-256;
6. verifies all referenced Storage blobs and checksums;
7. compares the recorded schema and FK graph with the live schema;
8. builds a topological restore order;
9. classifies rows as insert, existing-identical, conflict, or missing-dependency;
10. classifies Storage paths as insert, existing-identical, or conflict;
11. stores and returns only aggregate technical results;
12. performs no insert, update, delete, truncate, drop, upload, move, or remove operation.

Validation is capped at a 10 MiB manifest, 128 MiB total backup bytes, 500,000 snapshot rows, 20,000 database parts, and 10,000 Storage objects. Database and Storage calls share a 135-second operation deadline, including hung requests. Live-table pagination is bounded by the row envelope and rejects a stalled cursor. These limits keep corrupted or unexpectedly large backups from exhausting the Edge worker; exceeding them is a fail-closed signal to design Backup V2 scaling rather than silently truncate V1.

Any `--apply`, `--restore`, `--target-production`, or `--allow-destructive` request is rejected as unsupported in Backup V1. This is stronger than an opt-in destructive mode and ensures the shipped tool cannot modify production business data.

## Cleanup-worker guard

The shared cleanup helper rejects `adma-backups` before removal or enqueue. The deployed worker also marks any legacy or malformed queue job targeting `adma-backups` as failed without calling Storage removal. The existing queue constraint already excludes `adma-backups` and remains unchanged so the Backup V1 migration stays additive. The pre-existing omission of `knowledge-files` from that constraint is documented separately and is not silently folded into Backup V1.

Tests prove that neither direct helper use nor a crafted worker job can delete from the backup bucket.

## Code organization

The Edge entrypoint remains an orchestration layer. Testable modules under `supabase/functions/_shared/backup/` own:

- identifiers and path validation;
- SHA-256 and canonical manifest generation;
- database chunk validation;
- Storage discovery, deduplication, and mapping;
- retention and orphan cleanup decisions;
- manifest validation;
- FK ordering and restore dry-run planning;
- the 72-hour eligibility decision.

Adapters isolate Supabase database and Storage calls from pure logic. Unit tests use fake adapters and never contact production.

## Test strategy

The automated suite covers the thirty required cases:

1. manifest generation;
2. deterministic serialization;
3. deterministic checksums;
4. pagination beyond the default API limit;
5. empty tables;
6. numeric precision;
7. null preservation;
8. array and JSON preservation;
9. failed run status;
10. incomplete backup never becoming successful;
11. final manifest creation occurring last;
12. corrupted database checksum detection;
13. missing database dump detection;
14. incremental Storage reuse;
15. unchanged objects not duplicating blobs;
16. changed objects creating new blobs;
17. deleted source files remaining in previous snapshots;
18. recursive backup exclusion;
19. retention preserving the newest success;
20. retention keeping ten successes;
21. referenced shared blobs remaining;
22. orphan blob cleanup;
23. restore dry-run planning;
24. corrupted Storage checksum detection;
25. missing Storage blob detection;
26. FK restore ordering;
27. production destructive restore rejection;
28. frontend access to `backup_runs` being blocked;
29. less-than-72-hour Cron skip;
30. greater-than-or-equal-to-72-hour backup eligibility.

Additional assertions cover path traversal, unknown tables, unknown buckets, stale-run recovery, sanitized logs/errors, the storage-cleanup runtime guard, migration additivity, and Edge Function parsing. `npm test` remains the CI entrypoint and includes all backup tests plus both stabilized browser smoke modes.

## Rollout and verification

After local tests, security review, and code review pass:

1. create a PR without production data or credentials;
2. wait for green GitHub Actions;
3. apply the additive production migration;
4. confirm migration history, RLS, grants, bucket privacy, Vault secret name, and Cron configuration;
5. deploy only `backup-adma` and the guarded `storage-cleanup` version;
6. capture exact business-table counts;
7. invoke one maintenance backup;
8. poll `backup_runs` until terminal;
9. validate manifest, table counts, database checksums, Storage mappings, blobs, and retention state;
10. run production restore dry-run without writes;
11. repeat the business-table counts and prove they are unchanged;
12. measure database logical bytes, copied Storage bytes, total bucket bytes, object count, unique blob count, and 30/90-day growth bounds;
13. run the monitoring query;
14. update `ADMA_PROJECT_SPEC.md` with only the permanent Backup V1 architecture;
15. rerun local verification and CI if the rollout documentation changed;
16. merge only after all required checks are green, then fast-forward local `main` and verify it is clean.

If any High/Critical security issue, destructive behavior, data-count change, checksum mismatch, public bucket/policy, red test, or failed production validation appears, rollout and merge stop until corrected.

## Monitoring

The runbook includes a read-only query returning the newest successful backup and its age, newest failed backup, current running backup, counts, logical byte totals, duration, and warning/error state. Alerting is not implemented, but the result supports a future alert when the latest successful backup is older than four days.

## Non-goals

Backup V1 does not add UI, notifications, off-site storage, Backup V2, S3/R2/Drive integration, `auth.users` export, automatic restore, new application APIs, finance changes, Performance V1 changes, or unrelated refactoring.
