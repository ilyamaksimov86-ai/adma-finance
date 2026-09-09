import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const source=read('supabase/functions/adma-api/index.ts').replace(/^import .*;\s*$/gm,'');
const parse=new Function('Deno',stripTypeScriptTypes(source)+'\nreturn projectInput;')({serve(){}});
test('migration adds only nullable informational money, no defaults or data writes',()=>{
 const sql=read('supabase/migrations/20260909081304_add_project_contract_amount.sql');
 assert.match(sql,/add column contract_amount numeric\(14,2\)/);
 assert.doesNotMatch(sql,/default|not null|update |insert |delete |drop /i);
 assert.match(sql,/contract_amount >= 0.01 and contract_amount <= 999999999999.99/);
});
test('contract amount create, update, omission and clear remain backward compatible',()=>{
 assert.equal(parse({name:'Object'}).value.contract_amount,null);
 assert.equal(parse({name:'Object',contract_amount:'5500000.25'}).value.contract_amount,5500000.25);
 assert.equal(parse({contract_amount:6000000},true).value.contract_amount,6000000);
 for(const value of [null,''])assert.equal(parse({contract_amount:value},true).value.contract_amount,null);
 assert.deepEqual(parse({status:'archived'},true).value,{status:'archived'});
});
test('contract amount rejects invalid money and unsafe coercions',()=>{
 for(const value of ['text','NaN','Infinity',NaN,Infinity,-1,0,0.001,true,[],{},'0x10',1000000000000])assert.equal(parse({contract_amount:value},true).error,'invalid_contract_amount',String(value));
});
test('Project API contract and presentation use the canonical nullable field',()=>{
 const contract=JSON.parse(read('contracts/api-contracts.json'));
 assert.deepEqual(contract.models.Project.contract_amount.type,['number','null']);
 assert.equal(contract.endpoints['adma-api'].actions.update_project.project_model,'Project');
 assert.match(read('src/cloud/shared.fragment.js'),/contractAmount: p.contract_amount == null \? null : Number\(p.contract_amount\)/);
 assert.match(read('src/cloud/projects.fragment.js'),/p.contractAmount == null \? 'Не указана' : money\(p.contractAmount\)/);
 for(const path of ['src/cloud/finance.fragment.js','src/cloud/dashboard.fragment.js','supabase/functions/finance-api/index.ts','supabase/functions/leads-api/index.ts','supabase/functions/reimbursement-pdf/index.ts'])assert.doesNotMatch(read(path),/contract_amount|contractAmount/);
});
