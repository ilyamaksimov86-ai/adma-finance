import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const platform=readFileSync(new URL('../src/cloud/platform.fragment.js',import.meta.url),'utf8');
const performance=readFileSync(new URL('../src/cloud/performance.fragment.js',import.meta.url),'utf8');
const projects=readFileSync(new URL('../src/cloud/projects.fragment.js',import.meta.url),'utf8');
const designers=readFileSync(new URL('../src/cloud/designers.fragment.js',import.meta.url),'utf8');
const operations=readFileSync(new URL('../src/cloud/operations.fragment.js',import.meta.url),'utf8');
const finance=readFileSync(new URL('../src/cloud/finance.fragment.js',import.meta.url),'utf8');
const admaApi=readFileSync(new URL('../supabase/functions/adma-api/index.ts',import.meta.url),'utf8');
const financeApi=readFileSync(new URL('../supabase/functions/finance-api/index.ts',import.meta.url),'utf8');
const operationsApi=readFileSync(new URL('../supabase/functions/project-operations-api/index.ts',import.meta.url),'utf8');
const knowledgeApi=readFileSync(new URL('../supabase/functions/knowledge-api/index.ts',import.meta.url),'utf8');

test('critical boot renders before secondary module loading',()=>{
 const renderAt=platform.indexOf('applyHashRoute();\n      render();');
 const backgroundAt=platform.indexOf("const background=['finance'");
 assert.ok(renderAt>0&&backgroundAt>renderAt);
 assert.doesNotMatch(platform,/await Promise\.all\(\[loadFinanceCloud/);
});

test('module loading has explicit state and reuses inflight requests',()=>{
 for(const status of ['idle','loading','loaded','error'])assert.match(performance,new RegExp(`'${status}'`));
 assert.match(performance,/entry\.status === 'loading' && entry\.promise/);
 assert.match(performance,/entry\.status === 'loaded'/);
});

test('ordinary project and stage writes patch server entities without loadCloud',()=>{
 assert.match(projects,/patchMapped\('projects',data\.project,mapProject\)/);
 assert.match(projects,/patchMapped\('stages',data\.stage,mapStage\)/);
 assert.doesNotMatch(projects,/await loadCloud\(/);
});

test('designer and task writes patch local state from server responses',()=>{
 assert.match(designers,/patchMapped\('designers',data\.designer,mapDesigner\)/);
 assert.match(operations,/patchMapped\('projectTasks',data\.task,mapProjectTask\)/);
 assert.doesNotMatch(designers,/await refreshDesigners/);
 assert.doesNotMatch(operations,/await refreshOperations/);
});

test('private file lists are metadata-only and URLs are lazy',()=>{
 assert.doesNotMatch(admaApi,/Promise\.all\(\(expenses\|\|\[\]\)\.map/);
 assert.match(admaApi,/action==="get_receipt_url"/);
 assert.match(admaApi,/canAccessProject\(expense\.project_id\)/);
 assert.doesNotMatch(financeApi,/acts:await signed|waybills:await signed|company_expenses:await signed/);
 assert.match(financeApi,/action==='get_file_url'/);
 assert.match(financeApi,/user\.role!=='owner'&&user\.role!=='partner'/);
 assert.match(operationsApi,/await requireProject\(file\.project_id\)/);
 assert.match(knowledgeApi,/\['owner','partner'\]\.includes\(user\.role\)/);
 assert.match(finance,/financeApi\('get_file_url'/);
});
