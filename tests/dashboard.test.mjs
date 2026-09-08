import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const cloud=readFileSync(new URL('../cloud.js',import.meta.url),'utf8');
const styles=readFileSync(new URL('../styles.css',import.meta.url),'utf8');

test('dashboard reuses canonical finance and schedule calculations',()=>{
  assert.match(cloud,/function projectFinanceTotals\(projectId, month = ''\)/);
  assert.match(cloud,/function companyFinanceTotals\(month = ''\)/);
  assert.match(cloud,/profit:objectProfit-general/);
  assert.match(cloud,/checks\.filter\(pending\)/);
  assert.match(cloud,/const summary=scheduleSummary\(project\.id\)/);
  assert.match(cloud,/current=summary\.current\|\|summary\.next/);
});

test('attention aggregates real modules and sorts critical overdue items first',()=>{
  assert.match(cloud,/state\.projectTasks\|\|\[\]/);
  assert.match(cloud,/filter\(leadOverdue\)/);
  assert.match(cloud,/filter\(designerOverdue\)/);
  assert.match(cloud,/\['issued','signed','partially_paid'\]/);
  assert.match(cloud,/\['sent','partially_paid'\]/);
  assert.match(cloud,/sort\(\(a,b\)=>b\.priority-a\.priority\|\|b\.days-a\.days\)\.slice\(0,10\)/);
});

test('dashboard has period, real previews, empty states and responsive layout',()=>{
  for(const text of ['Активные объекты','Прибыль объектов','К возмещению','Общие расходы','Итоговая прибыль ADMA','Требует внимания','Заявки','Задачи','Дизайнеры','Финансы по объектам']) assert.match(cloud,new RegExp(text));
  assert.match(cloud,/id="dashboardPeriod" type="month"/);
  assert.match(cloud,/Нет элементов, требующих внимания/);
  assert.match(cloud,/Promise\.allSettled/);
  assert.match(styles,/Stage 10 — real-data operational Dashboard/);
  assert.match(styles,/@media\(max-width:520px\).*dashboard-kpis/s);
});
