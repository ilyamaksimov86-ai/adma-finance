-- Stage 3: project schedules. Existing projects, expenses and storage objects are untouched.
create table if not exists public.project_stages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  position integer not null default 0,
  planned_start date,
  planned_end date,
  actual_start date,
  actual_end date,
  progress smallint not null default 0,
  status text not null default 'planned',
  responsible_user_id uuid references public.app_users(id) on delete set null,
  work_cost numeric(14,2),
  comment text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_stages_name_check check (length(btrim(name)) between 1 and 160),
  constraint project_stages_position_check check (position between 0 and 10000),
  constraint project_stages_progress_check check (progress between 0 and 100),
  constraint project_stages_status_check check (status = any (array[
    'planned'::text,
    'in_progress'::text,
    'completed'::text,
    'delayed'::text,
    'paused'::text
  ])),
  constraint project_stages_planned_dates_check check (
    planned_end is null or planned_start is null or planned_end >= planned_start
  ),
  constraint project_stages_actual_dates_check check (
    actual_end is null or actual_start is null or actual_end >= actual_start
  ),
  constraint project_stages_work_cost_check check (work_cost is null or work_cost >= 0)
);

create index if not exists idx_project_stages_project_position
  on public.project_stages(project_id, position, planned_start);

alter table public.project_stages enable row level security;
revoke all on table public.project_stages from public, anon, authenticated;
grant select, insert, update, delete on table public.project_stages to service_role;

comment on table public.project_stages is
  'Canonical work stages for project schedules. Future tasks, photos and expenses may reference these rows.';
