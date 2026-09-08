-- Stage 8: canonical leads CRM, contact history and atomic project conversion.
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  client_name text not null,
  phone text,
  telegram text,
  email text,
  project_name text not null,
  address text,
  area_sqm numeric(10,2),
  estimated_budget numeric(14,2),
  has_design_project boolean,
  design_project_url text,
  desired_start_date date,
  source text not null default 'other',
  designer_id uuid references public.designers(id) on delete set null,
  responsible_user_id uuid references public.app_users(id) on delete set null,
  status text not null default 'new',
  priority text not null default 'normal',
  comment text,
  last_contact_at timestamptz,
  next_contact_at timestamptz,
  next_action text,
  loss_reason text,
  loss_comment text,
  closed_at timestamptz,
  project_id uuid unique references public.projects(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_client_name_check check (length(btrim(client_name)) between 1 and 200),
  constraint leads_project_name_check check (length(btrim(project_name)) between 1 and 240),
  constraint leads_area_check check (area_sqm is null or area_sqm > 0),
  constraint leads_budget_check check (estimated_budget is null or estimated_budget >= 0),
  constraint leads_status_check check (status = any(array['new','contacted','measurement','estimate','negotiation','contract','lost']::text[])),
  constraint leads_source_check check (source = any(array['designer','referral','website','instagram','telegram','flatica','other']::text[])),
  constraint leads_priority_check check (priority = any(array['low','normal','high']::text[])),
  constraint leads_designer_source_check check ((source='designer' and designer_id is not null) or (source<>'designer' and designer_id is null)),
  constraint leads_loss_check check (status<>'lost' or loss_reason is not null),
  constraint leads_comment_check check (comment is null or length(comment)<=5000)
);

create table if not exists public.lead_interactions (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete restrict,
  occurred_at timestamptz not null default now(),
  interaction_type text not null,
  comment text not null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint lead_interactions_type_check check (interaction_type = any(array['message','call','meeting','measurement','estimate_sent','note','other']::text[])),
  constraint lead_interactions_comment_check check (length(btrim(comment)) between 1 and 4000)
);

create or replace function public.sync_lead_contact_and_designer()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.source='designer' and new.designer_id is not null then
    update public.designers
       set status='referred_lead',updated_at=now()
     where id=new.designer_id and is_archived=false and status<>'inactive'
       and array_position(array['found','first_contact','replied','meeting','partner','referred_lead','has_project']::text[],status)
           < array_position(array['found','first_contact','replied','meeting','partner','referred_lead','has_project']::text[],'referred_lead');
  end if;
  return new;
end;
$$;
revoke all on function public.sync_lead_contact_and_designer() from public,anon,authenticated;
drop trigger if exists trg_lead_designer_progress on public.leads;
create trigger trg_lead_designer_progress after insert or update of source,designer_id on public.leads for each row execute function public.sync_lead_contact_and_designer();

create or replace function public.sync_lead_last_contact()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.interaction_type = any(array['message','call','meeting','measurement','estimate_sent']::text[]) then
    update public.leads set last_contact_at=greatest(coalesce(last_contact_at,new.occurred_at),new.occurred_at),updated_at=now() where id=new.lead_id;
  end if;
  return new;
end;
$$;
revoke all on function public.sync_lead_last_contact() from public,anon,authenticated;
drop trigger if exists trg_lead_last_contact on public.lead_interactions;
create trigger trg_lead_last_contact after insert on public.lead_interactions for each row execute function public.sync_lead_last_contact();

create or replace function public.convert_lead_to_project(p_lead_id uuid,p_project jsonb,p_actor_id uuid)
returns jsonb language plpgsql set search_path='' as $$
declare
  target public.leads%rowtype;
  new_project public.projects%rowtype;
begin
  select * into target from public.leads where id=p_lead_id for update;
  if not found then raise exception 'lead_not_found'; end if;
  if target.project_id is not null then raise exception 'lead_already_converted'; end if;
  if target.status<>'contract' then raise exception 'lead_not_contract'; end if;

  insert into public.projects(name,address,area_sqm,client_name,client_phone,status,start_date,designer_id,comment,created_by)
  values (
    nullif(btrim(p_project->>'name'),''),nullif(btrim(p_project->>'address'),''),nullif(p_project->>'area_sqm','')::numeric,
    nullif(btrim(p_project->>'client_name'),''),nullif(btrim(p_project->>'client_phone'),''),coalesce(nullif(p_project->>'status',''),'preparation'),
    nullif(p_project->>'start_date','')::date,target.designer_id,nullif(btrim(p_project->>'comment'),''),p_actor_id
  ) returning * into new_project;

  update public.leads set project_id=new_project.id,closed_at=coalesce(closed_at,now()),updated_at=now() where id=p_lead_id;
  if target.designer_id is not null then
    update public.designers set status='has_project',updated_at=now()
     where id=target.designer_id and is_archived=false and status<>'inactive'
       and array_position(array['found','first_contact','replied','meeting','partner','referred_lead','has_project']::text[],status)
           < array_position(array['found','first_contact','replied','meeting','partner','referred_lead','has_project']::text[],'has_project');
  end if;
  return to_jsonb(new_project);
end;
$$;
revoke all on function public.convert_lead_to_project(uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.convert_lead_to_project(uuid,jsonb,uuid) to service_role;

create index if not exists idx_leads_status_created on public.leads(status,created_at desc);
create index if not exists idx_leads_source_designer on public.leads(source,designer_id);
create index if not exists idx_leads_responsible on public.leads(responsible_user_id);
create index if not exists idx_leads_next_contact on public.leads(next_contact_at) where project_id is null and status<>'lost';
create index if not exists idx_leads_created_by on public.leads(created_by);
create index if not exists idx_lead_interactions_lead_date on public.lead_interactions(lead_id,occurred_at desc);
create index if not exists idx_lead_interactions_created_by on public.lead_interactions(created_by);

alter table public.leads enable row level security;
alter table public.lead_interactions enable row level security;
revoke all on table public.leads,public.lead_interactions from public,anon,authenticated;
grant select,insert,update,delete on table public.leads,public.lead_interactions to service_role;

comment on table public.leads is 'Canonical ADMA sales lead; retained after conversion as sales history.';
comment on table public.lead_interactions is 'Append-only lead contact history; real contacts advance leads.last_contact_at.';
comment on function public.convert_lead_to_project(uuid,jsonb,uuid) is 'Atomically creates one project for a contract lead and stores the canonical FK.';
