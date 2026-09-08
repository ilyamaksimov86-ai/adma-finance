import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';

const migration=readFileSync(new URL('../supabase/migrations/20260908103000_add_designer_crm_stage7.sql',import.meta.url),'utf8');
const apiSource=readFileSync(new URL('../supabase/functions/designers-api/index.ts',import.meta.url),'utf8');
const cloud=readFileSync(new URL('../cloud.js',import.meta.url),'utf8');

function parsers(){
 const source=apiSource.replace(/^import .*;\s*$/gm,'');
 return new Function('Deno','createClient','requireUser','AuthError',`${stripTypeScriptTypes(source)}\nreturn {designerInput,normalizedPhone};`)({env:{get:()=>''},serve(){}},()=>({}),async()=>({}),class extends Error{});
}

test('stage 7 migration is additive and keeps one canonical designer relation',()=>{
 assert.match(migration,/create table if not exists public\.designers/);
 assert.match(migration,/create table if not exists public\.designer_interactions/);
 assert.match(migration,/add column if not exists designer_id uuid references public\.designers\(id\) on delete set null/);
 assert.match(migration,/alter table public\.designers enable row level security/);
 assert.match(migration,/alter table public\.designer_interactions enable row level security/);
 assert.doesNotMatch(migration,/drop\s+(table|column)|truncate|delete\s+from/i);
});

test('designer metadata and structured contacts are validated',()=>{
 const {designerInput,normalizedPhone}=parsers();
 const value=designerInput({full_name:'  Анна Иванова ',status:'partner',priority:'high',phone:'+7 (999) 123-45-67',tags:['Москва','Москва',' premium ']});
 assert.equal(value.full_name,'Анна Иванова');assert.deepEqual(value.tags,['Москва','premium']);assert.equal(normalizedPhone(value.phone),'79991234567');
 assert.throws(()=>designerInput({full_name:'Анна',status:'unknown'}),/invalid_status/);
 assert.throws(()=>designerInput({full_name:'',status:'found'}),/required_field/);
});

test('contact history, computed overdue state and project relation are wired',()=>{
 assert.match(migration,/sync_designer_last_contact/);
 assert.match(migration,/interaction_type = any\(array\['message','call','meeting'/);
 assert.match(cloud,/const designerOverdue=d=>/);
 assert.match(cloud,/new Date\(d\.nextContactAt\)\.getTime\(\)<Date\.now\(\)/);
 assert.match(cloud,/designer_id: optionalValue\(pDesigner\.value\)/);
 assert.match(cloud,/designerView==='funnel'/);
 assert.match(cloud,/possible_duplicate/);
});
