-- Cover finance audit foreign keys used by author joins and future staff history filters.
create index if not exists finance_acts_created_by_idx on public.finance_acts(created_by) where created_by is not null;
create index if not exists finance_act_costs_created_by_idx on public.finance_act_costs(created_by) where created_by is not null;
create index if not exists finance_act_payments_created_by_idx on public.finance_act_payments(created_by) where created_by is not null;
create index if not exists finance_waybills_created_by_idx on public.finance_waybills(created_by) where created_by is not null;
create index if not exists finance_waybill_payments_created_by_idx on public.finance_waybill_payments(created_by) where created_by is not null;
create index if not exists company_expenses_created_by_idx on public.company_expenses(created_by) where created_by is not null;
