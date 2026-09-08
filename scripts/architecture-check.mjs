import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const sourceDir = new URL('../src/cloud/', import.meta.url);
const expected = new Set(['shared.fragment.js','platform.fragment.js','dashboard.fragment.js','projects.fragment.js','finance.fragment.js','masters.fragment.js','operations.fragment.js','designers.fragment.js','leads.fragment.js']);
const files = (await readdir(sourceDir)).filter(name => name.endsWith('.fragment.js'));
const failures = [];
const fail = message => failures.push(message);

for (const name of expected) if (!files.includes(name)) fail(`missing source module ${name}`);
for (const name of files) if (!expected.has(name)) fail(`unregistered source module ${name}`);
for (const name of files) {
  const source = await readFile(new URL(name, sourceDir), 'utf8');
  const lines = source.split('\n').length;
  const limit = name === 'platform.fragment.js' ? 220 : name === 'shared.fragment.js' ? 260 : 520;
  if (lines > limit) fail(`${name} has ${lines} lines (limit ${limit})`);
  if (/^\s*(?:import|export)\s/m.test(source)) fail(`${name} imports another feature's internals`);
}

const frontendFiles = ['app.js','auth.js',...files.map(name => `src/cloud/${name}`)];
for (const name of frontendFiles) {
  const source = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  if (/createClient\s*\(|\.from\s*\(|\/rest\/v1\//.test(source)) fail(`${name} contains a direct database call`);
}

const platform = await readFile(new URL('platform.fragment.js', sourceDir), 'utf8');
if (/['"](?:create_project|update_project|delete_expense|save_act|save_master|save_document|save_designer|save_lead|convert_lead)['"]/.test(platform)) fail('platform contains a feature API action');
const shared = await readFile(new URL('shared.fragment.js', sourceDir), 'utf8');
if (/\b(?:renderLeadsCloud|renderDesignersCloud|renderMastersCloud|renderProjectFinance)\b/.test(shared)) fail('shared depends on a feature renderer');

const build = spawnSync(process.execPath, ['scripts/build-frontend.mjs','--check'], { cwd: new URL('..', import.meta.url), encoding:'utf8' });
if (build.status !== 0) fail((build.stderr || build.stdout).trim());
if (failures.length) {
  console.error(failures.map(x => `- ${x}`).join('\n'));
  process.exit(1);
}
console.log(`Architecture checks passed for ${files.length} frontend source modules.`);
