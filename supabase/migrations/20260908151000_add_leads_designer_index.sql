-- Cover the canonical lead → designer foreign key for joins and delete checks.
create index if not exists idx_leads_designer on public.leads(designer_id);
