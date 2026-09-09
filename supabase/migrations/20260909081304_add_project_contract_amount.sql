-- Informational only; existing objects retain NULL. No financial formulas change.
alter table public.projects
  add column contract_amount numeric(14,2)
  constraint projects_contract_amount_valid
  check (contract_amount >= 0.01 and contract_amount <= 999999999999.99);
