-- Stage 6: project documents, operational tasks and project photos.
-- Existing projects, finance records, receipts and files are untouched.
create table if not exists public.project_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  title text not null,
  category text not null default 'other',
  storage_path text not null unique,
  original_name text,
  mime_type text,
  size_bytes bigint,
  document_date date,
  description text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_documents_title_check check (length(btrim(title)) between 1 and 240),
  constraint project_documents_category_check check (category = any (array['contract'::text,'estimate'::text,'addendum'::text,'design'::text,'technical'::text,'other'::text])),
  constraint project_documents_path_check check (length(storage_path) between 1 and 600),
  constraint project_documents_name_check check (original_name is null or length(original_name) <= 300),
  constraint project_documents_mime_check check (mime_type is null or length(mime_type) <= 160),
  constraint project_documents_size_check check (size_bytes is null or size_bytes between 0 and 10485760),
  constraint project_documents_description_check check (description is null or length(description) <= 4000)
);

create table if not exists public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  title text not null,
  description text,
  assignee_user_id uuid references public.app_users(id) on delete set null,
  assignee_master_id uuid references public.masters(id) on delete set null,
  deadline date,
  priority text not null default 'normal',
  status text not null default 'new',
  stage_id uuid references public.project_stages(id) on delete set null,
  act_id uuid references public.finance_acts(id) on delete set null,
  waybill_id uuid references public.finance_waybills(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_tasks_title_check check (length(btrim(title)) between 1 and 240),
  constraint project_tasks_description_check check (description is null or length(description) <= 4000),
  constraint project_tasks_priority_check check (priority = any (array['low'::text,'normal'::text,'high'::text,'urgent'::text])),
  constraint project_tasks_status_check check (status = any (array['new'::text,'in_progress'::text,'completed'::text,'cancelled'::text])),
  constraint project_tasks_one_assignee_check check (assignee_user_id is null or assignee_master_id is null)
);

create table if not exists public.project_photos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  stage_id uuid references public.project_stages(id) on delete set null,
  storage_path text not null unique,
  original_name text,
  mime_type text,
  size_bytes bigint,
  caption text,
  shot_date date,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_photos_path_check check (length(storage_path) between 1 and 600),
  constraint project_photos_name_check check (original_name is null or length(original_name) <= 300),
  constraint project_photos_mime_check check (mime_type is null or length(mime_type) <= 160),
  constraint project_photos_size_check check (size_bytes is null or size_bytes between 0 and 10485760),
  constraint project_photos_caption_check check (caption is null or length(caption) <= 2000)
);

create index if not exists idx_project_documents_project_category_date on public.project_documents(project_id, category, created_at desc);
create index if not exists idx_project_documents_created_by on public.project_documents(created_by);
create index if not exists idx_project_tasks_project_status_deadline on public.project_tasks(project_id, status, deadline);
create index if not exists idx_project_tasks_assignee_user on public.project_tasks(assignee_user_id);
create index if not exists idx_project_tasks_assignee_master on public.project_tasks(assignee_master_id);
create index if not exists idx_project_tasks_stage on public.project_tasks(stage_id);
create index if not exists idx_project_tasks_act on public.project_tasks(act_id);
create index if not exists idx_project_tasks_waybill on public.project_tasks(waybill_id);
create index if not exists idx_project_tasks_created_by on public.project_tasks(created_by);
create index if not exists idx_project_photos_project_stage_date on public.project_photos(project_id, stage_id, created_at desc);
create index if not exists idx_project_photos_created_by on public.project_photos(created_by);

alter table public.project_documents enable row level security;
alter table public.project_tasks enable row level security;
alter table public.project_photos enable row level security;
revoke all on table public.project_documents, public.project_tasks, public.project_photos from public, anon, authenticated;
grant select, insert, update, delete on table public.project_documents, public.project_tasks, public.project_photos to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-files','project-files',false,10485760,array[
  'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg','image/png','image/webp','image/heic','image/heif'
]::text[])
on conflict (id) do nothing;

comment on table public.project_documents is 'Canonical non-financial documents owned by one project; file bytes live in private Storage.';
comment on table public.project_tasks is 'Operational project tasks with optional links to a stage, act, waybill or existing assignee.';
comment on table public.project_photos is 'Project photos optionally linked to a stage; stage deletion preserves the photo.';
