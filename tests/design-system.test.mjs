import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../design-system.css',import.meta.url),'utf8');

test('canonical final design tokens and Inter typography are active',()=>{
  assert.match(html,/design-system\.css\?v=33/);
  for(const token of ['--bg:#f8fafc','--card:#fff','--text:#0f172a','--border:#e2e8f0','--blue:#2563eb']) assert.match(css,new RegExp(token));
  assert.match(css,/Inter,-apple-system/);
  assert.match(css,/font-variant-numeric:tabular-nums/);
  assert.doesNotMatch(css,/Playfair|limestone|bronze|#9e7d47/i);
});

test('CRM funnels keep native two-axis gestures without trapping page scroll',()=>{
  assert.match(css,/\.crm-funnel-board\{[^}]*overflow-x:auto;[^}]*overflow-y:visible;/);
  assert.match(css,/\.crm-funnel-board\{[^}]*overscroll-behavior-inline:contain;[^}]*overscroll-behavior-block:auto;/);
  assert.match(css,/\.crm-funnel-board\{[^}]*touch-action:pan-x pan-y;/);
  assert.doesNotMatch(css,/\.crm-funnel-board\{[^}]*overflow-y:hidden;/);
});

test('desktop, mobile and Telegram safe-area presentation are defined',()=>{
  assert.match(css,/grid-template-columns:250px minmax\(0,1fr\)/);
  assert.match(css,/@media\(max-width:899px\)/);
  assert.match(css,/env\(safe-area-inset-top\)/);
  assert.match(css,/env\(safe-area-inset-bottom\)/);
  assert.match(html,/data-tab="leads"/);
});

test('the visual layer contains no product or backend behavior',()=>{
  assert.doesNotMatch(css,/supabase|fetch\(|XMLHttpRequest|receipt-upload|reimbursement-pdf/i);
  assert.doesNotMatch(html,/демоданн|ЖК «Символ»|Александр В\./i);
});
