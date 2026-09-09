-- Knowledge Base V1: global tech cards, checklist templates, issues and private attachments.
-- Additive only; no existing production records or storage objects are changed.
create table if not exists public.knowledge_tech_cards (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null,
  description text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_tech_cards_title_check check (length(btrim(title)) between 1 and 240),
  constraint knowledge_tech_cards_category_check check (length(btrim(category)) between 1 and 160),
  constraint knowledge_tech_cards_description_check check (description is null or length(description) <= 20000)
);

create table if not exists public.knowledge_tech_checklist_items (
  id uuid primary key default gen_random_uuid(),
  tech_card_id uuid not null references public.knowledge_tech_cards(id) on delete cascade,
  item_text text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  constraint knowledge_checklist_text_check check (length(btrim(item_text)) between 1 and 1000),
  constraint knowledge_checklist_position_check check (position between 0 and 999)
);

create table if not exists public.knowledge_issues (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null,
  problem text,
  cause text,
  solution text,
  prevention text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_issues_title_check check (length(btrim(title)) between 1 and 240),
  constraint knowledge_issues_category_check check (length(btrim(category)) between 1 and 160),
  constraint knowledge_issues_problem_check check (problem is null or length(problem) <= 12000),
  constraint knowledge_issues_cause_check check (cause is null or length(cause) <= 12000),
  constraint knowledge_issues_solution_check check (solution is null or length(solution) <= 12000),
  constraint knowledge_issues_prevention_check check (prevention is null or length(prevention) <= 12000)
);

create table if not exists public.knowledge_attachments (
  id uuid primary key default gen_random_uuid(),
  tech_card_id uuid references public.knowledge_tech_cards(id) on delete cascade,
  issue_id uuid references public.knowledge_issues(id) on delete cascade,
  storage_path text not null unique,
  original_name text,
  mime_type text,
  size_bytes bigint,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint knowledge_attachments_owner_check check ((tech_card_id is not null)::integer + (issue_id is not null)::integer = 1),
  constraint knowledge_attachments_path_check check (length(storage_path) between 1 and 600),
  constraint knowledge_attachments_name_check check (original_name is null or length(original_name) <= 300),
  constraint knowledge_attachments_mime_check check (mime_type is null or length(mime_type) <= 160),
  constraint knowledge_attachments_size_check check (size_bytes is null or size_bytes between 0 and 10485760)
);

create index if not exists idx_knowledge_tech_cards_category_updated on public.knowledge_tech_cards(category, updated_at desc);
create index if not exists idx_knowledge_tech_cards_created_by on public.knowledge_tech_cards(created_by);
create index if not exists idx_knowledge_checklist_card_position on public.knowledge_tech_checklist_items(tech_card_id, position);
create index if not exists idx_knowledge_issues_category_updated on public.knowledge_issues(category, updated_at desc);
create index if not exists idx_knowledge_issues_created_by on public.knowledge_issues(created_by);
create index if not exists idx_knowledge_attachments_card on public.knowledge_attachments(tech_card_id);
create index if not exists idx_knowledge_attachments_issue on public.knowledge_attachments(issue_id);
create index if not exists idx_knowledge_attachments_created_by on public.knowledge_attachments(created_by);

alter table public.knowledge_tech_cards enable row level security;
alter table public.knowledge_tech_checklist_items enable row level security;
alter table public.knowledge_issues enable row level security;
alter table public.knowledge_attachments enable row level security;
revoke all on table public.knowledge_tech_cards, public.knowledge_tech_checklist_items, public.knowledge_issues, public.knowledge_attachments from public, anon, authenticated;
grant select, insert, update, delete on table public.knowledge_tech_cards, public.knowledge_tech_checklist_items, public.knowledge_issues, public.knowledge_attachments to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('knowledge-files','knowledge-files',false,10485760,array[
  'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg','image/png','image/webp','image/heic','image/heif'
]::text[])
on conflict (id) do nothing;

comment on table public.knowledge_tech_cards is 'Global ADMA technical instructions; V1 has no project or master relation.';
comment on table public.knowledge_tech_checklist_items is 'Ordered instruction template items; no execution/completion state.';
comment on table public.knowledge_issues is 'Global ADMA problem, cause, solution and prevention knowledge records.';
comment on table public.knowledge_attachments is 'Metadata for files stored in the private knowledge-files bucket.';
