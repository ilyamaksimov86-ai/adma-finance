-- Stage 4: additive finance model. Existing projects, expenses and files are untouched.
create table if not exists public.finance_acts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  stage_id uuid references public.project_stages(id) on delete set null,
  number text not null check (length(btrim(number)) between 1 and 100),
  act_date date not null default current_date,
  title text not null check (length(btrim(title)) between 1 and 300),
  amount numeric(14,2) not null check (amount >= 0),
  status text not null default 'draft' check (status in ('draft','issued','signed','partially_paid','paid')),
  file_path text,
  comment text check (comment is null or length(comment) <= 4000),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.finance_act_costs (
  id uuid primary key default gen_random_uuid(),
  act_id uuid not null references public.finance_acts(id) on delete cascade,
  cost_date date not null default current_date,
  amount numeric(14,2) not null check (amount > 0),
  description text check (description is null or length(description) <= 1000),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.finance_act_payments (
  id uuid primary key default gen_random_uuid(),
  act_id uuid not null references public.finance_acts(id) on delete cascade,
  payment_date date not null default current_date,
  amount numeric(14,2) not null check (amount > 0),
  comment text check (comment is null or length(comment) <= 1000),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.finance_waybills (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  number text not null check (length(btrim(number)) between 1 and 100),
  waybill_date date not null default current_date,
  supplier text not null check (length(btrim(supplier)) between 1 and 200),
  description text check (description is null or length(description) <= 2000),
  amount numeric(14,2) not null check (amount >= 0),
  status text not null default 'created' check (status in ('created','sent','partially_paid','paid','closed')),
  file_path text,
  comment text check (comment is null or length(comment) <= 4000),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.finance_waybill_payments (
  id uuid primary key default gen_random_uuid(),
  waybill_id uuid not null references public.finance_waybills(id) on delete cascade,
  payment_date date not null default current_date,
  amount numeric(14,2) not null check (amount > 0),
  comment text check (comment is null or length(comment) <= 1000),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.company_expenses (
  id uuid primary key default gen_random_uuid(),
  expense_date date not null default current_date,
  amount numeric(14,2) not null check (amount > 0),
  category text not null check (category in ('advertising','services','office','transport','administrative','salaries','taxes','banking','other')),
  description text not null check (length(btrim(description)) between 1 and 1000),
  comment text check (comment is null or length(comment) <= 4000),
  file_path text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_acts_project_date_idx on public.finance_acts(project_id, act_date desc);
create index if not exists finance_acts_stage_idx on public.finance_acts(stage_id) where stage_id is not null;
create index if not exists finance_act_costs_act_idx on public.finance_act_costs(act_id);
create index if not exists finance_act_payments_act_idx on public.finance_act_payments(act_id);
create index if not exists finance_waybills_project_date_idx on public.finance_waybills(project_id, waybill_date desc);
create index if not exists finance_waybill_payments_waybill_idx on public.finance_waybill_payments(waybill_id);
create index if not exists company_expenses_date_category_idx on public.company_expenses(expense_date desc, category);

alter table public.finance_acts enable row level security;
alter table public.finance_act_costs enable row level security;
alter table public.finance_act_payments enable row level security;
alter table public.finance_waybills enable row level security;
alter table public.finance_waybill_payments enable row level security;
alter table public.company_expenses enable row level security;

revoke all on public.finance_acts, public.finance_act_costs, public.finance_act_payments,
  public.finance_waybills, public.finance_waybill_payments, public.company_expenses from anon, authenticated;
grant all on public.finance_acts, public.finance_act_costs, public.finance_act_payments,
  public.finance_waybills, public.finance_waybill_payments, public.company_expenses to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('finance-documents', 'finance-documents', false, 10485760,
  array['application/pdf','image/jpeg','image/png','image/webp']::text[])
on conflict (id) do update set public=false, file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;
