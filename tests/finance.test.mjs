import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const migration=readFileSync(new URL('../supabase/migrations/20260907230000_add_finance_stage4.sql',import.meta.url),'utf8');
const cloud=readFileSync(new URL('../cloud.js',import.meta.url),'utf8');

test('stage 4 migration is additive and protects every finance table',()=>{
  for(const table of ['finance_acts','finance_act_costs','finance_act_payments','finance_waybills','finance_waybill_payments','company_expenses']){
    assert.match(migration,new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration,new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.doesNotMatch(migration,/drop\s+(table|column)|truncate|delete\s+from\s+public\.(projects|expenses)/i);
  assert.match(migration,/finance-documents[^]*public=false/);
});

test('profit formulas exclude checks and subtract company expenses once',()=>{
  assert.match(cloud,/profit:actsProfit\+waybillsProfit/);
  assert.match(cloud,/profit:objectProfit-general/);
  assert.match(cloud,/Чеки \/ Разное не вычитаются/);
});
