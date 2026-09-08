import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../ui-final.css',import.meta.url),'utf8');

test('final UI layer uses the approved atelier tokens and typography',()=>{
  assert.match(html,/ui-final\.css\?v=30/);
  assert.match(css,/--bg:#fbfbfa/);
  assert.match(css,/--text:#191918/);
  assert.match(css,/--blue:#9e7d47/);
  assert.match(css,/--border:#e2e0d8/);
  assert.match(css,/Playfair Display/);
  assert.match(css,/font-variant-numeric:tabular-nums/);
});

test('final UI layer preserves dedicated desktop, mobile and Telegram safe-area layouts',()=>{
  assert.match(css,/@media\(min-width:900px\)/);
  assert.match(css,/@media\(max-width:899px\)/);
  assert.match(css,/env\(safe-area-inset-top\)/);
  assert.match(css,/env\(safe-area-inset-bottom\)/);
  assert.match(css,/\.tabs\{/);
  assert.match(css,/\.sidebar\{/);
});

test('Stitch layer is presentation-only',()=>{
  assert.doesNotMatch(css,/supabase|fetch\(|XMLHttpRequest|receipt-upload|reimbursement-pdf/i);
  assert.doesNotMatch(html,/mock|demo data|демоданн/i);
});
