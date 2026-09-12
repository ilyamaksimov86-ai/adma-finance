create or replace function public.hard_delete_project(
  p_project_id uuid,
  p_actor_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project_name text;
  v_cleanup_queued bigint := 0;
begin
  if not exists (
    select 1
    from public.app_users
    where id = p_actor_id
      and role = 'owner'
      and is_active is true
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select name
  into v_project_name
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;
  if p_confirmation is distinct from v_project_name then
    raise exception 'confirmation_mismatch' using errcode = '22023';
  end if;

  insert into public.storage_cleanup_queue (bucket, object_path)
  select distinct files.bucket, files.object_path
  from (
    select e.receipt_path as object_path, 'receipts'::text as bucket
    from public.expenses e
    where e.project_id = p_project_id
    union all
    select a.file_path as object_path, 'finance-documents'::text as bucket
    from public.finance_acts a
    where a.project_id = p_project_id
    union all
    select w.file_path as object_path, 'finance-documents'::text as bucket
    from public.finance_waybills w
    where w.project_id = p_project_id
    union all
    select d.storage_path as object_path, 'project-files'::text as bucket
    from public.project_documents d
    where d.project_id = p_project_id
    union all
    select p.storage_path as object_path, 'project-files'::text as bucket
    from public.project_photos p
    where p.project_id = p_project_id
  ) as files
  where files.object_path is not null
    and length(files.object_path) > 0
  on conflict (bucket, object_path) where completed_at is null do nothing;
  get diagnostics v_cleanup_queued = row_count;

  delete from public.project_tasks where project_id = p_project_id;
  delete from public.project_documents where project_id = p_project_id;
  delete from public.project_photos where project_id = p_project_id;
  delete from public.master_assignments where project_id = p_project_id;
  delete from public.projects where id = p_project_id;

  return jsonb_build_object(
    'project_id', p_project_id,
    'cleanup_queued', v_cleanup_queued
  );
end;
$$;

revoke execute on function public.hard_delete_project(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.hard_delete_project(uuid, uuid, text) to service_role;
