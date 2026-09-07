-- Stage 2: additive project metadata. Existing projects, expenses and files are preserved.
alter table public.projects
  add column if not exists area_sqm numeric(8,2),
  add column if not exists client_phone text,
  add column if not exists start_date date,
  add column if not exists planned_end_date date,
  add column if not exists actual_end_date date,
  add column if not exists contract_number text,
  add column if not exists warranty_until date;

alter table public.projects drop constraint if exists projects_area_sqm_check;
alter table public.projects add constraint projects_area_sqm_check
  check (area_sqm is null or (area_sqm > 0 and area_sqm <= 10000));

alter table public.projects drop constraint if exists projects_dates_check;
alter table public.projects add constraint projects_dates_check
  check (planned_end_date is null or start_date is null or planned_end_date >= start_date);

alter table public.projects drop constraint if exists projects_status_check;
alter table public.projects add constraint projects_status_check
  check (status = any (array[
    'active'::text,
    'preparation'::text,
    'in_progress'::text,
    'paused'::text,
    'handover'::text,
    'warranty'::text,
    'archived'::text
  ]));

comment on column public.projects.status is
  'Project lifecycle. Legacy active remains valid and is displayed as in_progress.';
