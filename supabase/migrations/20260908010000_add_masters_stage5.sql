-- Stage 5: one global master directory and project/stage assignments.
-- Existing projects, stages, users, finance data and files are untouched.
create table if not exists public.masters (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  telegram text,
  primary_specialty text not null default 'other',
  additional_skills text[] not null default '{}'::text[],
  rating numeric(2,1),
  price_level text,
  notes text,
  is_active boolean not null default true,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint masters_name_check check (length(btrim(name)) between 1 and 160),
  constraint masters_phone_check check (phone is null or length(phone) <= 80),
  constraint masters_telegram_check check (telegram is null or length(telegram) <= 100),
  constraint masters_specialty_check check (primary_specialty = any (array[
    'demolition'::text, 'rough'::text, 'plaster'::text, 'painting'::text,
    'tile'::text, 'plumbing'::text, 'electrical'::text, 'drywall'::text,
    'flooring'::text, 'carpentry'::text, 'universal'::text, 'other'::text
  ])),
  constraint masters_skills_check check (cardinality(additional_skills) <= 20),
  constraint masters_rating_check check (rating is null or rating between 1 and 5),
  constraint masters_price_level_check check (
    price_level is null or price_level = any (array['low'::text, 'medium'::text, 'high'::text, 'premium'::text])
  ),
  constraint masters_notes_check check (notes is null or length(notes) <= 4000)
);

create table if not exists public.master_assignments (
  id uuid primary key default gen_random_uuid(),
  master_id uuid not null references public.masters(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete restrict,
  stage_id uuid references public.project_stages(id) on delete set null,
  start_date date not null,
  planned_end_date date,
  actual_end_date date,
  status text not null default 'planned',
  comment text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint master_assignments_status_check check (status = any (array[
    'planned'::text, 'active'::text, 'completed'::text, 'cancelled'::text
  ])),
  constraint master_assignments_planned_dates_check check (
    planned_end_date is null or planned_end_date >= start_date
  ),
  constraint master_assignments_actual_dates_check check (
    actual_end_date is null or actual_end_date >= start_date
  ),
  constraint master_assignments_comment_check check (comment is null or length(comment) <= 2000)
);

create index if not exists idx_masters_active_specialty
  on public.masters(is_active, primary_specialty, name);
create index if not exists idx_masters_created_by
  on public.masters(created_by);
create index if not exists idx_master_assignments_master_status_dates
  on public.master_assignments(master_id, status, start_date, planned_end_date);
create index if not exists idx_master_assignments_project_status
  on public.master_assignments(project_id, status, start_date);
create index if not exists idx_master_assignments_stage
  on public.master_assignments(stage_id);
create index if not exists idx_master_assignments_created_by
  on public.master_assignments(created_by);

alter table public.masters enable row level security;
alter table public.master_assignments enable row level security;
revoke all on table public.masters, public.master_assignments from public, anon, authenticated;
grant select, insert, update, delete on table public.masters, public.master_assignments to service_role;

comment on table public.masters is
  'Canonical global master directory. A master is archived with is_active instead of duplicated per project.';
comment on table public.master_assignments is
  'Links one master to a project and optionally a project stage; availability and history derive from these rows.';
