create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create table if not exists public.storage_cleanup_queue (
  id uuid primary key default gen_random_uuid(),
  bucket text not null check (bucket in ('receipts','finance-documents','project-files')),
  object_path text not null check (length(object_path) between 1 and 1000),
  created_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  next_attempt_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists storage_cleanup_queue_pending_path_uidx
  on public.storage_cleanup_queue (bucket, object_path)
  where completed_at is null;
create index if not exists storage_cleanup_queue_due_idx
  on public.storage_cleanup_queue (next_attempt_at, created_at)
  where completed_at is null;

alter table public.storage_cleanup_queue enable row level security;
revoke all on table public.storage_cleanup_queue from anon, authenticated;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'storage_cleanup_cron_secret') then
    perform vault.create_secret(replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''),'storage_cleanup_cron_secret','ADMA hourly storage cleanup authorization');
  end if;
end
$$;

create or replace function public.verify_storage_cleanup_secret(candidate text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from vault.decrypted_secrets
    where name = 'storage_cleanup_cron_secret'
      and decrypted_secret = candidate
  );
$$;
revoke all on function public.verify_storage_cleanup_secret(text) from public, anon, authenticated;
grant execute on function public.verify_storage_cleanup_secret(text) to service_role;

select cron.schedule(
  'storage-cleanup-hourly',
  '17 * * * *',
  $job$
    select net.http_post(
      url := 'https://blaacuwwvyatfiyjnsrw.supabase.co/functions/v1/storage-cleanup',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'X-Cleanup-Secret',(select decrypted_secret from vault.decrypted_secrets where name = 'storage_cleanup_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $job$
);
