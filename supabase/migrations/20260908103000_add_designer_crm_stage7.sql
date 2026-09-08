-- Stage 7: canonical designer CRM and interaction history.
create table if not exists public.designers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  studio text,
  instagram text,
  telegram text,
  phone text,
  email text,
  website text,
  status text not null default 'found',
  responsible_user_id uuid references public.app_users(id) on delete set null,
  last_contact_at timestamptz,
  next_contact_at timestamptz,
  next_action text,
  notes text,
  source text,
  city text,
  portfolio_url text,
  priority text not null default 'normal',
  tags text[] not null default '{}',
  is_archived boolean not null default false,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint designers_name_check check (length(btrim(full_name)) between 1 and 200),
  constraint designers_status_check check (status = any(array['found','first_contact','replied','meeting','partner','referred_lead','has_project','inactive']::text[])),
  constraint designers_priority_check check (priority = any(array['low','normal','high']::text[])),
  constraint designers_notes_check check (notes is null or length(notes) <= 5000)
);

create table if not exists public.designer_interactions (
  id uuid primary key default gen_random_uuid(),
  designer_id uuid not null references public.designers(id) on delete restrict,
  occurred_at timestamptz not null default now(),
  interaction_type text not null,
  direction text,
  comment text not null,
  result text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint designer_interactions_type_check check (interaction_type = any(array['message','call','meeting','note','other']::text[])),
  constraint designer_interactions_direction_check check (direction is null or direction = any(array['incoming','outgoing']::text[])),
  constraint designer_interactions_comment_check check (length(btrim(comment)) between 1 and 4000)
);

alter table public.projects add column if not exists designer_id uuid references public.designers(id) on delete set null;

create or replace function public.sync_designer_last_contact()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.interaction_type = any(array['message','call','meeting']::text[]) then
    update public.designers set last_contact_at = greatest(coalesce(last_contact_at,new.occurred_at),new.occurred_at),updated_at=now() where id=new.designer_id;
  end if;
  return new;
end;
$$;
revoke all on function public.sync_designer_last_contact() from public,anon,authenticated;
drop trigger if exists trg_designer_last_contact on public.designer_interactions;
create trigger trg_designer_last_contact after insert on public.designer_interactions for each row execute function public.sync_designer_last_contact();

create index if not exists idx_designers_status_next_contact on public.designers(status,is_archived,next_contact_at);
create index if not exists idx_designers_responsible on public.designers(responsible_user_id);
create index if not exists idx_designers_created_by on public.designers(created_by);
create index if not exists idx_designer_interactions_designer_date on public.designer_interactions(designer_id,occurred_at desc);
create index if not exists idx_designer_interactions_created_by on public.designer_interactions(created_by);
create index if not exists idx_projects_designer on public.projects(designer_id);

alter table public.designers enable row level security;
alter table public.designer_interactions enable row level security;
revoke all on table public.designers,public.designer_interactions from public,anon,authenticated;
grant select,insert,update,delete on table public.designers,public.designer_interactions to service_role;

comment on table public.designers is 'Canonical ADMA partner-channel CRM entity; future leads reference designers.id.';
comment on table public.designer_interactions is 'Append-only designer contact history; real contacts update designers.last_contact_at through the API.';
comment on column public.projects.designer_id is 'Optional canonical CRM designer; existing project data is preserved.';
