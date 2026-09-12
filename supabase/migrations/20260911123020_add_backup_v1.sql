create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table public.backup_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running' check (status in ('running','success','failed')),
  backup_id text not null unique check (length(backup_id) between 30 and 80),
  backup_path text not null check (length(backup_path) between 1 and 500),
  table_count integer not null default 0 check (table_count >= 0),
  row_count bigint not null default 0 check (row_count >= 0),
  file_count bigint not null default 0 check (file_count >= 0),
  database_bytes bigint not null default 0 check (database_bytes >= 0),
  storage_bytes bigint not null default 0 check (storage_bytes >= 0),
  total_bytes bigint not null default 0 check (total_bytes >= 0),
  checksum text check (checksum is null or checksum ~ '^[0-9a-f]{64}$'),
  error text check (error is null or length(error) <= 1000),
  format_version integer not null default 1 check (format_version = 1),
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  check (
    (status = 'running' and completed_at is null)
    or (status in ('success','failed') and completed_at is not null)
  ),
  check (status <> 'success' or (table_count = 24 and checksum is not null and duration_ms is not null))
);

create unique index backup_runs_one_running_uidx
  on public.backup_runs ((1)) where status = 'running';
create index backup_runs_success_started_idx
  on public.backup_runs (started_at desc) where status = 'success';

alter table public.backup_runs enable row level security;
revoke all on table public.backup_runs from public, anon, authenticated;
grant select, insert, update, delete on table public.backup_runs to service_role;

create table private.backup_table_registry (
  table_name text primary key,
  included boolean not null,
  excluded_columns text[] not null default '{}',
  exclusion_reason text,
  check (included or exclusion_reason is not null)
);

insert into private.backup_table_registry (table_name,included,excluded_columns,exclusion_reason) values
  ('app_users',true,'{}',null),
  ('company_expenses',true,'{}',null),
  ('designer_interactions',true,'{}',null),
  ('designers',true,'{}',null),
  ('expenses',true,'{}',null),
  ('finance_act_costs',true,'{}',null),
  ('finance_act_payments',true,'{}',null),
  ('finance_acts',true,'{}',null),
  ('finance_waybill_payments',true,'{}',null),
  ('finance_waybills',true,'{}',null),
  ('knowledge_attachments',true,'{}',null),
  ('knowledge_issues',true,'{}',null),
  ('knowledge_tech_cards',true,'{}',null),
  ('knowledge_tech_checklist_items',true,'{}',null),
  ('lead_interactions',true,'{}',null),
  ('leads',true,'{}',null),
  ('master_assignments',true,'{}',null),
  ('masters',true,'{}',null),
  ('project_documents',true,'{}',null),
  ('project_members',true,'{}',null),
  ('project_photos',true,'{}',null),
  ('project_stages',true,'{}',null),
  ('project_tasks',true,'{}',null),
  ('projects',true,'{}',null),
  ('backup_runs',false,'{}','internal backup metadata'),
  ('storage_cleanup_queue',false,'{}','internal cleanup queue');

create table private.backup_snapshot_chunks (
  run_id uuid not null references public.backup_runs(id) on delete cascade,
  table_name text not null references private.backup_table_registry(table_name),
  columns jsonb not null check (jsonb_typeof(columns) = 'array'),
  numeric_columns text[] not null default '{}',
  primary_key text[] not null check (cardinality(primary_key) > 0),
  foreign_keys jsonb not null default '[]'::jsonb check (jsonb_typeof(foreign_keys) = 'array'),
  chunk_index integer not null check (chunk_index >= 0),
  row_count integer not null check (row_count between 0 and 500),
  body text not null,
  bytes bigint not null check (bytes >= 0),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  primary key (run_id,table_name,chunk_index)
);

create table private.backup_snapshot_tables (
  run_id uuid not null references public.backup_runs(id) on delete cascade,
  table_name text not null references private.backup_table_registry(table_name),
  columns jsonb not null check (jsonb_typeof(columns) = 'array'),
  numeric_columns text[] not null default '{}',
  primary_key text[] not null check (cardinality(primary_key) > 0),
  foreign_keys jsonb not null default '[]'::jsonb check (jsonb_typeof(foreign_keys) = 'array'),
  row_count bigint not null check (row_count >= 0),
  bytes bigint not null check (bytes >= 0),
  part_count integer not null check (part_count > 0),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  primary key (run_id,table_name)
);

create table private.backup_config (
  singleton boolean primary key default true check (singleton),
  format_version integer not null default 1 check (format_version = 1),
  implementation_version text not null default 'backup-v1',
  source_git_checkpoint text,
  spec_checkpoint text,
  updated_at timestamptz not null default now()
);
insert into private.backup_config (singleton) values (true);

create table private.backup_maintenance_state (
  singleton boolean primary key default true check (singleton),
  retention_started_at timestamptz,
  retention_owner uuid,
  check ((retention_started_at is null) = (retention_owner is null))
);
insert into private.backup_maintenance_state (singleton) values (true);

revoke all on all tables in schema private from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema private to service_role;

create or replace function public.claim_backup_run(
  p_backup_id text,
  p_force boolean default false
)
returns table(result text,run_id uuid,backup_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
begin
  if p_backup_id !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'invalid_backup_id' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('adma-backup-v1-claim'));

  update public.backup_runs
     set status = 'failed',
         completed_at = pg_catalog.now(),
         duration_ms = greatest(0,(extract(epoch from (pg_catalog.now()-started_at))*1000)::bigint),
         error = 'stale_running_backup'
   where status = 'running'
     and started_at < pg_catalog.now() - interval '15 minutes';

  update private.backup_maintenance_state
     set retention_started_at = null,
         retention_owner = null
   where singleton
     and retention_started_at < pg_catalog.now() - interval '15 minutes';

  if exists (
    select 1 from private.backup_maintenance_state
     where singleton and retention_started_at is not null
  ) then
    return query select 'maintenance_busy'::text,null::uuid,p_backup_id;
    return;
  end if;

  if exists (select 1 from public.backup_runs where status = 'running') then
    return query
      select 'already_running'::text,r.id,r.backup_id
        from public.backup_runs r
       where r.status = 'running'
       order by r.started_at desc
       limit 1;
    return;
  end if;

  if not p_force and exists (
    select 1 from public.backup_runs
     where status = 'success'
       and completed_at > pg_catalog.now() - interval '72 hours'
  ) then
    return query
      select 'skipped_recent'::text,r.id,r.backup_id
        from public.backup_runs r
       where r.status = 'success'
       order by r.completed_at desc
       limit 1;
    return;
  end if;

  insert into public.backup_runs (backup_id,backup_path)
  values (p_backup_id,'database/' || p_backup_id)
  returning id into v_run_id;

  return query select 'started'::text,v_run_id,p_backup_id;
end;
$$;

create or replace function public.begin_backup_retention()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := gen_random_uuid();
  v_acquired uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('adma-backup-v1-claim'));

  update public.backup_runs
     set status = 'failed',
         completed_at = pg_catalog.now(),
         duration_ms = greatest(0,(extract(epoch from (pg_catalog.now()-started_at))*1000)::bigint),
         error = 'stale_running_backup'
   where status = 'running'
     and started_at < pg_catalog.now() - interval '15 minutes';

  update private.backup_maintenance_state
     set retention_started_at = null,
         retention_owner = null
   where singleton
     and retention_started_at < pg_catalog.now() - interval '15 minutes';

  if exists (select 1 from public.backup_runs where status = 'running') then
    return null;
  end if;

  update private.backup_maintenance_state
     set retention_started_at = pg_catalog.now(),
         retention_owner = v_owner
   where singleton and retention_started_at is null
   returning retention_owner into v_acquired;
  return v_acquired;
end;
$$;

create or replace function public.end_backup_retention(p_owner uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_changed integer;
begin
  update private.backup_maintenance_state
     set retention_started_at = null,
         retention_owner = null
   where singleton and retention_owner = p_owner;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end;
$$;

create or replace function public.fail_backup_run(p_run_id uuid,p_error text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_changed integer;
begin
  update public.backup_runs
     set status = 'failed',
         completed_at = pg_catalog.now(),
         duration_ms = greatest(0,(extract(epoch from (pg_catalog.now()-started_at))*1000)::bigint),
         error = left(regexp_replace(coalesce(p_error,'backup_failed'),'[[:cntrl:]]',' ','g'),1000)
   where id = p_run_id
     and status = 'running';
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end;
$$;

create or replace function public.finish_backup_run(
  p_run_id uuid,
  p_table_count integer,
  p_row_count bigint,
  p_file_count bigint,
  p_database_bytes bigint,
  p_storage_bytes bigint,
  p_checksum text,
  p_duration_ms bigint,
  p_warnings jsonb default '[]'::jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_changed integer;
begin
  if p_checksum is null or p_duration_ms is null
     or p_table_count <> 24 or p_row_count < 0 or p_file_count < 0
     or p_database_bytes < 0 or p_storage_bytes < 0 or p_duration_ms < 0
     or p_checksum !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_warnings) <> 'array' or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'invalid_backup_metrics' using errcode = '22023';
  end if;

  update public.backup_runs
     set status = 'success',
         completed_at = pg_catalog.now(),
         table_count = p_table_count,
         row_count = p_row_count,
         file_count = p_file_count,
         database_bytes = p_database_bytes,
         storage_bytes = p_storage_bytes,
         total_bytes = p_database_bytes + p_storage_bytes,
         checksum = p_checksum,
         duration_ms = p_duration_ms,
         warnings = p_warnings,
         metadata = p_metadata,
         error = null
   where id = p_run_id
     and status = 'running';
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end;
$$;

create or replace function private.assert_backup_snapshot_contract()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_approved_tables constant text[] := array[
    'app_users','company_expenses','designer_interactions','designers','expenses',
    'finance_act_costs','finance_act_payments','finance_acts',
    'finance_waybill_payments','finance_waybills','knowledge_attachments',
    'knowledge_issues','knowledge_tech_cards','knowledge_tech_checklist_items',
    'lead_interactions','leads','master_assignments','masters','project_documents',
    'project_members','project_photos','project_stages','project_tasks','projects'
  ]::text[];
begin
  if exists (
    (select unnest(v_approved_tables)
     except select b.table_name from private.backup_table_registry b where b.included)
    union all
    (select b.table_name from private.backup_table_registry b where b.included
     except select unnest(v_approved_tables))
  ) then
    raise exception 'approved backup table set mismatch';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      left join private.backup_table_registry b on b.table_name = c.relname
     where n.nspname = 'public' and c.relkind in ('r','p') and b.table_name is null
  ) then
    raise exception 'unclassified public tables';
  end if;

  if exists (
    select 1 from private.backup_table_registry b
     where not exists (
       select 1 from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = b.table_name and c.relkind in ('r','p')
     )
  ) then
    raise exception 'classified public table missing';
  end if;

  if exists (
    select 1
      from private.backup_table_registry b
      join pg_catalog.pg_class c on c.relname = b.table_name
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where b.included
       and not (a.attname = any(b.excluded_columns))
       and a.attname ~* '(^|_)(password(_hash)?|token|secret|api_key|service_key|credential|encryption_key|private_key|signing_key|jwt(_secret|_key)?|session(_id|_key|_token)?|refresh_token|access_token)($|_)'
  ) then
    raise exception 'secret-like unclassified columns';
  end if;
  return true;
end;
$$;

create or replace function private.read_backup_table_snapshot(
  p_table_name text,
  p_excluded_columns text[]
)
returns table(
  table_name text,
  columns jsonb,
  numeric_columns text[],
  primary_key text[],
  foreign_keys jsonb,
  chunk_index integer,
  row_count integer,
  body text,
  bytes bigint,
  checksum text
)
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_columns jsonb;
  v_numeric_columns text[];
  v_primary_key text[];
  v_foreign_keys jsonb;
  v_json_args text;
  v_primary_order text;
  v_sql text;
begin
  if not exists (
    select 1 from private.backup_table_registry b
     where b.table_name = p_table_name and b.included
       and b.excluded_columns = p_excluded_columns
  ) then
    raise exception 'table_not_registered_for_backup' using errcode = '22023';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = p_table_name
       and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
       and not (a.attname = any(p_excluded_columns))
       and a.attname ~* '(^|_)(password(_hash)?|token|secret|api_key|service_key|credential|encryption_key|private_key|signing_key|jwt(_secret|_key)?|session(_id|_key|_token)?|refresh_token|access_token)($|_)'
  ) then
    raise exception 'secret-like unclassified columns';
  end if;

  select jsonb_agg(jsonb_build_object(
           'name',a.attname,
           'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
           'nullable',not a.attnotnull,
           'ordinal',a.attnum
         ) order by a.attnum),
         coalesce(array_agg(a.attname order by a.attnum)
           filter (where t.typname = 'numeric'),'{}'::text[]),
         string_agg(
           format('%L,%s',a.attname,
             case when t.typname = 'numeric'
               then format('case when %I is null then null else %I::text end',a.attname,a.attname)
               else format('%I',a.attname)
             end
           ),',' order by a.attnum)
    into v_columns,v_numeric_columns,v_json_args
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_type t on t.oid = a.atttypid
   where n.nspname = 'public' and c.relname = p_table_name
     and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
     and not (a.attname = any(p_excluded_columns));

  select array_agg(a.attname order by k.ordinality),
         string_agg(format('%I',a.attname),',' order by k.ordinality)
    into v_primary_key,v_primary_order
    from pg_catalog.pg_constraint con
    join lateral unnest(con.conkey) with ordinality k(attnum,ordinality) on true
    join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
    join pg_catalog.pg_class c on c.oid = con.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where con.contype = 'p' and n.nspname = 'public' and c.relname = p_table_name;

  if v_columns is null or v_primary_key is null or cardinality(v_primary_key) = 0 then
    raise exception 'included table missing or has no primary key: %',p_table_name;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'name',con.conname,
           'definition',pg_catalog.pg_get_constraintdef(con.oid,true),
           'columns',(
             select array_agg(local_attribute.attname order by local_key.ordinality)
               from unnest(con.conkey) with ordinality local_key(attnum,ordinality)
               join pg_catalog.pg_attribute local_attribute
                 on local_attribute.attrelid = con.conrelid
                and local_attribute.attnum = local_key.attnum
           ),
           'referenced_schema',rn.nspname,
           'referenced_table',rc.relname,
           'referenced_columns',(
             select array_agg(referenced_attribute.attname order by referenced_key.ordinality)
               from unnest(con.confkey) with ordinality referenced_key(attnum,ordinality)
               join pg_catalog.pg_attribute referenced_attribute
                 on referenced_attribute.attrelid = con.confrelid
                and referenced_attribute.attnum = referenced_key.attnum
           )
         ) order by con.conname),'[]'::jsonb)
    into v_foreign_keys
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class c on c.oid = con.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_class rc on rc.oid = con.confrelid
    join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
   where con.contype = 'f' and n.nspname = 'public' and c.relname = p_table_name;

  v_sql := format($query$
    with serialized as (
      select row_number() over (order by %s) as rn,
             json_build_object(%s)::text as line
        from public.%I
    ), chunks as (
      select ((rn-1)/500)::integer as chunk_index,
             count(*)::integer as row_count,
             string_agg(line,E'\n' order by rn) as body
        from serialized
       group by ((rn-1)/500)::integer
    ), complete_chunks as (
      select chunk_index,row_count,body from chunks
      union all
      select 0,0,'' where not exists (select 1 from chunks)
    )
    select $1::text,$2::jsonb,$3::text[],$4::text[],$5::jsonb,
           c.chunk_index,c.row_count,c.body,
           pg_catalog.octet_length(c.body)::bigint,
           pg_catalog.encode(extensions.digest(c.body,'sha256'),'hex')
      from complete_chunks c
     order by c.chunk_index
  $query$,v_primary_order,v_json_args,p_table_name);

  return query execute v_sql
    using p_table_name,v_columns,v_numeric_columns,v_primary_key,v_foreign_keys;
end;
$$;

create or replace function public.prepare_backup_snapshot(p_run_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_approved_tables constant text[] := array[
    'app_users','company_expenses','designer_interactions','designers','expenses',
    'finance_act_costs','finance_act_payments','finance_acts',
    'finance_waybill_payments','finance_waybills','knowledge_attachments',
    'knowledge_issues','knowledge_tech_cards','knowledge_tech_checklist_items',
    'lead_interactions','leads','master_assignments','masters','project_documents',
    'project_members','project_photos','project_stages','project_tasks','projects'
  ]::text[];
begin
  if not exists (select 1 from public.backup_runs where id = p_run_id and status = 'running') then
    raise exception 'backup_run_not_running' using errcode = '55000';
  end if;

  if exists (
    (select unnest(v_approved_tables)
     except select b.table_name from private.backup_table_registry b where b.included)
    union all
    (select b.table_name from private.backup_table_registry b where b.included
     except select unnest(v_approved_tables))
  ) then
    raise exception 'approved backup table set mismatch';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      left join private.backup_table_registry b on b.table_name = c.relname
     where n.nspname = 'public' and c.relkind in ('r','p') and b.table_name is null
  ) then
    raise exception 'unclassified public tables';
  end if;

  if exists (
    select 1 from private.backup_table_registry b
     where not exists (
       select 1 from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = b.table_name and c.relkind in ('r','p')
     )
  ) then
    raise exception 'classified public table missing';
  end if;

  if exists (
    select 1
      from private.backup_table_registry b
      join pg_catalog.pg_class c on c.relname = b.table_name
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where b.included
       and not (a.attname = any(b.excluded_columns))
       and a.attname ~* '(^|_)(password(_hash)?|token|secret|api_key|service_key|credential|encryption_key|private_key|signing_key|jwt(_secret|_key)?|session(_id|_key|_token)?|refresh_token|access_token)($|_)'
  ) then
    raise exception 'secret-like unclassified columns';
  end if;

  delete from private.backup_snapshot_chunks where run_id = p_run_id;
  delete from private.backup_snapshot_tables where run_id = p_run_id;

  -- This is the only statement that reads application rows. The STABLE lateral
  -- reader therefore uses this statement's single MVCC snapshot for all 24 tables.
  insert into private.backup_snapshot_chunks
    (run_id,table_name,columns,numeric_columns,primary_key,foreign_keys,
     chunk_index,row_count,body,bytes,checksum)
  select p_run_id,s.table_name,s.columns,s.numeric_columns,s.primary_key,s.foreign_keys,
         s.chunk_index,s.row_count,s.body,s.bytes,s.checksum
    from (select private.assert_backup_snapshot_contract() as valid) contract
    cross join private.backup_table_registry b
    cross join lateral private.read_backup_table_snapshot(b.table_name,b.excluded_columns) s
   where contract.valid and b.included
   order by s.table_name,s.chunk_index;

  if exists (
    select 1 from private.backup_snapshot_chunks
     where run_id = p_run_id and bytes > 1048576
  ) then
    raise exception 'snapshot_chunk_too_large';
  end if;

  if (select coalesce(sum(bytes),0) from private.backup_snapshot_chunks where run_id = p_run_id) > 16777216 then
    raise exception 'snapshot_too_large';
  end if;

  insert into private.backup_snapshot_tables
    (run_id,table_name,columns,numeric_columns,primary_key,foreign_keys,
     row_count,bytes,part_count,checksum)
  select p_run_id,c.table_name,c.columns,c.numeric_columns,c.primary_key,c.foreign_keys,
         sum(c.row_count),sum(c.bytes),count(*)::integer,
         pg_catalog.encode(extensions.digest(string_agg(c.checksum,'' order by c.chunk_index),'sha256'),'hex')
    from private.backup_snapshot_chunks c
   where c.run_id = p_run_id
   group by c.table_name,c.columns,c.numeric_columns,c.primary_key,c.foreign_keys;

  if exists (
    (select unnest(v_approved_tables)
     except select table_name from private.backup_snapshot_tables where run_id = p_run_id)
    union all
    (select table_name from private.backup_snapshot_tables where run_id = p_run_id
     except select unnest(v_approved_tables))
  ) then
    raise exception 'snapshot table set mismatch';
  end if;

  return (
    select jsonb_build_object(
      'table_count',count(*),
      'row_count',coalesce(sum(row_count),0),
      'database_bytes',coalesce(sum(bytes),0)
    )
    from private.backup_snapshot_tables where run_id = p_run_id
  );
end;
$$;

create or replace function public.read_backup_snapshot_chunks(p_run_id uuid,p_offset integer default 0,p_limit integer default 100)
returns table(table_name text,chunk_index integer,row_count integer,body text,bytes bigint,checksum text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_offset < 0 or p_limit not between 1 and 100 then
    raise exception 'invalid_chunk_page' using errcode = '22023';
  end if;
  return query
    select c.table_name,c.chunk_index,c.row_count,c.body,c.bytes,c.checksum
      from private.backup_snapshot_chunks c
     where c.run_id = p_run_id
     order by c.table_name,c.chunk_index
     offset p_offset limit p_limit;
end;
$$;

create or replace function public.read_backup_snapshot_tables(p_run_id uuid)
returns table(table_name text,columns jsonb,numeric_columns text[],primary_key text[],foreign_keys jsonb,row_count bigint,bytes bigint,part_count integer,checksum text)
language sql
stable
security definer
set search_path = ''
as $$
  select t.table_name,t.columns,t.numeric_columns,t.primary_key,t.foreign_keys,
         t.row_count,t.bytes,t.part_count,t.checksum
    from private.backup_snapshot_tables t
   where t.run_id = p_run_id
   order by t.table_name;
$$;

create or replace function public.read_backup_live_schema()
returns table(table_name text,columns jsonb,numeric_columns text[],primary_key text[],foreign_keys jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      left join private.backup_table_registry b on b.table_name = c.relname
     where n.nspname = 'public' and c.relkind in ('r','p') and b.table_name is null
  ) then
    raise exception 'unclassified public tables';
  end if;
  if exists (
    select 1
      from private.backup_table_registry b
      join pg_catalog.pg_class c on c.relname = b.table_name
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where b.included
       and not (a.attname = any(b.excluded_columns))
       and a.attname ~* '(^|_)(password(_hash)?|token|secret|api_key|service_key|credential|encryption_key|private_key|signing_key|jwt(_secret|_key)?|session(_id|_key|_token)?|refresh_token|access_token)($|_)'
  ) then
    raise exception 'secret-like unclassified columns';
  end if;
  return query
  select b.table_name,
         (
           select jsonb_agg(jsonb_build_object(
                    'name',a.attname,
                    'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
                    'nullable',not a.attnotnull,
                    'ordinal',a.attnum
                  ) order by a.attnum)
             from pg_catalog.pg_attribute a
             join pg_catalog.pg_class c on c.oid = a.attrelid
             join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = b.table_name
              and a.attnum > 0 and not a.attisdropped
              and not (a.attname = any(b.excluded_columns))
         ) as columns,
         coalesce((
           select array_agg(a.attname order by a.attnum)
             from pg_catalog.pg_attribute a
             join pg_catalog.pg_class c on c.oid = a.attrelid
             join pg_catalog.pg_namespace n on n.oid = c.relnamespace
             join pg_catalog.pg_type t on t.oid = a.atttypid
            where n.nspname = 'public' and c.relname = b.table_name
              and a.attnum > 0 and not a.attisdropped
              and not (a.attname = any(b.excluded_columns))
              and t.typname = 'numeric'
         ),'{}'::text[]) as numeric_columns,
         (
           select array_agg(a.attname order by k.ordinality)
             from pg_catalog.pg_constraint con
             join lateral unnest(con.conkey) with ordinality k(attnum,ordinality) on true
             join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
             join pg_catalog.pg_class c on c.oid = con.conrelid
             join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            where con.contype = 'p' and n.nspname = 'public' and c.relname = b.table_name
         ) as primary_key,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'name',con.conname,
                    'definition',pg_catalog.pg_get_constraintdef(con.oid,true),
                    'columns',(
                      select array_agg(local_attribute.attname order by local_key.ordinality)
                        from unnest(con.conkey) with ordinality local_key(attnum,ordinality)
                        join pg_catalog.pg_attribute local_attribute
                          on local_attribute.attrelid = con.conrelid
                         and local_attribute.attnum = local_key.attnum
                    ),
                    'referenced_schema',rn.nspname,
                    'referenced_table',rc.relname,
                    'referenced_columns',(
                      select array_agg(referenced_attribute.attname order by referenced_key.ordinality)
                        from unnest(con.confkey) with ordinality referenced_key(attnum,ordinality)
                        join pg_catalog.pg_attribute referenced_attribute
                          on referenced_attribute.attrelid = con.confrelid
                         and referenced_attribute.attnum = referenced_key.attnum
                    )
                  ) order by con.conname)
             from pg_catalog.pg_constraint con
             join pg_catalog.pg_class c on c.oid = con.conrelid
             join pg_catalog.pg_namespace n on n.oid = c.relnamespace
             join pg_catalog.pg_class rc on rc.oid = con.confrelid
             join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
            where con.contype = 'f' and n.nspname = 'public' and c.relname = b.table_name
         ),'[]'::jsonb) as foreign_keys
   from private.backup_table_registry b
   where b.included
   order by b.table_name;
end;
$$;

create or replace function public.clear_backup_snapshot(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.backup_runs
     where id = p_run_id and status in ('success','failed')
  ) then
    raise exception 'backup_run_not_terminal' using errcode = '55000';
  end if;
  delete from private.backup_snapshot_chunks where run_id = p_run_id;
  delete from private.backup_snapshot_tables where run_id = p_run_id;
  return true;
end;
$$;

create or replace function public.read_backup_config()
returns table(format_version integer,implementation_version text,source_git_checkpoint text,spec_checkpoint text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.format_version,c.implementation_version,c.source_git_checkpoint,c.spec_checkpoint
    from private.backup_config c
   where c.singleton;
$$;

create or replace function public.record_backup_restore_dry_run(p_run_id uuid,p_result jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_changed integer;
begin
  if jsonb_typeof(p_result) <> 'object' then
    raise exception 'invalid_restore_result' using errcode = '22023';
  end if;
  update public.backup_runs
     set metadata = metadata || jsonb_build_object('restore_dry_run',p_result)
   where id = p_run_id and status = 'success';
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end;
$$;

create or replace function private.assert_backup_restore_row_size(p_row text)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if pg_catalog.octet_length(p_row) > 262144 then
    raise exception 'restore_target_row_too_large' using errcode = '54000';
  end if;
  return p_row;
end;
$$;

create or replace function public.read_backup_table_page(
  p_table_name text,
  p_after jsonb default null,
  p_limit integer default 25
)
returns table(row_data text,primary_key jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r private.backup_table_registry%rowtype;
  v_json_args text;
  v_pk_args text;
  v_primary_order text;
  v_after_left text;
  v_after_right text;
  v_where text := '';
  v_sql text;
begin
  if p_limit not between 1 and 25 then
    raise exception 'invalid_page_limit' using errcode = '22023';
  end if;

  select * into r from private.backup_table_registry b
   where b.table_name = p_table_name and b.included;
  if not found then
    raise exception 'table_not_registered_for_backup' using errcode = '22023';
  end if;

  select string_agg(
           format('%L,%s',a.attname,
             case when t.typname = 'numeric'
               then format('case when %I is null then null else %I::text end',a.attname,a.attname)
               else format('%I',a.attname)
             end
           ),',' order by a.attnum)
    into v_json_args
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_type t on t.oid = a.atttypid
   where n.nspname = 'public' and c.relname = r.table_name
     and a.attnum > 0 and not a.attisdropped
     and not (a.attname = any(r.excluded_columns));

  select string_agg(format('%L,%s',a.attname,
           case when t.typname = 'numeric'
             then format('case when %I is null then null else %I::text end',a.attname,a.attname)
             else format('%I',a.attname)
           end
         ),',' order by k.ordinality),
         string_agg(format('%I',a.attname),',' order by k.ordinality),
         string_agg(format('%I',a.attname),',' order by k.ordinality),
         string_agg(format('($1->>%L)::%s',a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod)),',' order by k.ordinality)
    into v_pk_args,v_primary_order,v_after_left,v_after_right
    from pg_catalog.pg_constraint con
    join lateral unnest(con.conkey) with ordinality k(attnum,ordinality) on true
    join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
    join pg_catalog.pg_type t on t.oid = a.atttypid
    join pg_catalog.pg_class c on c.oid = con.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where con.contype = 'p' and n.nspname = 'public' and c.relname = r.table_name;

  if v_primary_order is null then
    raise exception 'included table has no primary key: %',r.table_name;
  end if;
  if p_after is not null then
    v_where := format('where (%s) > (%s)',v_after_left,v_after_right);
  end if;

  v_sql := format(
    'select private.assert_backup_restore_row_size(json_build_object(%s)::text),jsonb_build_object(%s) from public.%I %s order by %s limit $2',
    v_json_args,v_pk_args,r.table_name,v_where,v_primary_order
  );
  return query execute v_sql using p_after,least(p_limit,25);
end;
$$;

create or replace function public.verify_backup_secret(candidate text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
     where name = 'backup_cron_secret' and decrypted_secret = candidate
  );
$$;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'backup_cron_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''),
      'backup_cron_secret',
      'ADMA automatic Backup V1 authorization'
    );
  end if;
end
$$;

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('adma-backups','adma-backups',false,null,null)
on conflict (id) do update set public = false;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'backup-adma-daily-check') then
    perform cron.schedule(
      'backup-adma-daily-check',
      '43 2 * * *',
      $job$
        select net.http_post(
          url := 'https://blaacuwwvyatfiyjnsrw.supabase.co/functions/v1/backup-adma',
          headers := jsonb_build_object(
            'Content-Type','application/json',
            'X-Backup-Secret',(select decrypted_secret from vault.decrypted_secrets where name = 'backup_cron_secret')
          ),
          body := '{"action":"backup"}'::jsonb,
          timeout_milliseconds := 30000
        );
      $job$
    );
  end if;
end
$$;

revoke all on function private.assert_backup_snapshot_contract() from public, anon, authenticated;
grant execute on function private.assert_backup_snapshot_contract() to service_role;
revoke all on function private.read_backup_table_snapshot(text,text[]) from public, anon, authenticated;
grant execute on function private.read_backup_table_snapshot(text,text[]) to service_role;
revoke all on function private.assert_backup_restore_row_size(text) from public, anon, authenticated;
grant execute on function private.assert_backup_restore_row_size(text) to service_role;
revoke all on function public.claim_backup_run(text,boolean) from public, anon, authenticated;
grant execute on function public.claim_backup_run(text,boolean) to service_role;
revoke all on function public.begin_backup_retention() from public, anon, authenticated;
grant execute on function public.begin_backup_retention() to service_role;
revoke all on function public.end_backup_retention(uuid) from public, anon, authenticated;
grant execute on function public.end_backup_retention(uuid) to service_role;
revoke all on function public.fail_backup_run(uuid,text) from public, anon, authenticated;
grant execute on function public.fail_backup_run(uuid,text) to service_role;
revoke all on function public.finish_backup_run(uuid,integer,bigint,bigint,bigint,bigint,text,bigint,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.finish_backup_run(uuid,integer,bigint,bigint,bigint,bigint,text,bigint,jsonb,jsonb) to service_role;
revoke all on function public.prepare_backup_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.prepare_backup_snapshot(uuid) to service_role;
revoke all on function public.read_backup_snapshot_chunks(uuid,integer,integer) from public, anon, authenticated;
grant execute on function public.read_backup_snapshot_chunks(uuid,integer,integer) to service_role;
revoke all on function public.read_backup_snapshot_tables(uuid) from public, anon, authenticated;
grant execute on function public.read_backup_snapshot_tables(uuid) to service_role;
revoke all on function public.read_backup_live_schema() from public, anon, authenticated;
grant execute on function public.read_backup_live_schema() to service_role;
revoke all on function public.clear_backup_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.clear_backup_snapshot(uuid) to service_role;
revoke all on function public.read_backup_config() from public, anon, authenticated;
grant execute on function public.read_backup_config() to service_role;
revoke all on function public.record_backup_restore_dry_run(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.record_backup_restore_dry_run(uuid,jsonb) to service_role;
revoke all on function public.read_backup_table_page(text,jsonb,integer) from public, anon, authenticated;
grant execute on function public.read_backup_table_page(text,jsonb,integer) to service_role;
revoke all on function public.verify_backup_secret(text) from public, anon, authenticated;
grant execute on function public.verify_backup_secret(text) to service_role;
