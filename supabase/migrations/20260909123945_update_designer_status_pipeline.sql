-- Align the canonical designer CRM pipeline with ADMA's current workflow.
-- IDs, contacts, interactions and Designer -> Lead -> Project relations are preserved.
alter table public.designers drop constraint designers_status_check;

update public.designers
set status = case status
  when 'first_contact' then 'contacted'
  when 'partner' then 'agreed'
  when 'inactive' then 'ignored'
  else status
end
where status in ('first_contact', 'partner', 'inactive');

alter table public.designers
  add constraint designers_status_check check (
    status = any(array[
      'found','to_review','contacted','replied','meeting','agreed',
      'referred_lead','has_project','ignored','rejected'
    ]::text[])
  );

create or replace function public.sync_lead_contact_and_designer()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.source='designer' and new.designer_id is not null then
    update public.designers
       set status='referred_lead',updated_at=now()
     where id=new.designer_id and is_archived=false and status<>'has_project'
       and (
         status = any(array['ignored','rejected']::text[])
         or array_position(array['found','to_review','contacted','replied','meeting','agreed','referred_lead','has_project']::text[],status)
            < array_position(array['found','to_review','contacted','replied','meeting','agreed','referred_lead','has_project']::text[],'referred_lead')
       );
  end if;
  return new;
end;
$$;
revoke all on function public.sync_lead_contact_and_designer() from public,anon,authenticated;

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
     where id=target.designer_id and is_archived=false and status<>'has_project';
  end if;
  return to_jsonb(new_project);
end;
$$;
revoke all on function public.convert_lead_to_project(uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.convert_lead_to_project(uuid,jsonb,uuid) to service_role;

comment on column public.designers.status is 'ADMA designer funnel: found, to_review, contacted, replied, meeting, agreed, referred_lead, has_project, ignored, rejected.';
