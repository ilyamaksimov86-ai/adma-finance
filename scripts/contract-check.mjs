import { readFile } from 'node:fs/promises';

const contracts = JSON.parse(await readFile(new URL('../contracts/api-contracts.json', import.meta.url), 'utf8'));
const failures = [];
for (const field of ['version','compatibility','errors','endpoints']) if (!(field in contracts)) failures.push(`contract root missing ${field}`);
const actionEndpoints = ['adma-api','finance-api','masters-api','project-operations-api','designers-api','leads-api'];
for (const endpoint of actionEndpoints) {
  const contract = contracts.endpoints[endpoint];
  if (!contract?.actions) { failures.push(`${endpoint}: actions missing`); continue; }
  const source = await readFile(new URL(`../supabase/functions/${endpoint}/index.ts`, import.meta.url), 'utf8');
  const implemented = new Set([...source.matchAll(/action\s*={2,3}\s*['"]([a-z_]+)['"]/g)].map(x => x[1]));
  const documented = new Set(Object.keys(contract.actions));
  for (const action of implemented) if (!documented.has(action)) failures.push(`${endpoint}: undocumented action ${action}`);
  for (const action of documented) if (!implemented.has(action)) failures.push(`${endpoint}: contract action not implemented ${action}`);
  for (const [action, shape] of Object.entries(contract.actions)) if (!Array.isArray(shape.request) || !Array.isArray(shape.response)) failures.push(`${endpoint}.${action}: request/response arrays required`);
}
for (const endpoint of ['receipt-upload','finance-file-upload','project-file-upload','reimbursement-pdf']) if (!contracts.endpoints[endpoint]) failures.push(`missing file contract ${endpoint}`);
if (failures.length) {
  console.error(failures.map(x => `- ${x}`).join('\n'));
  process.exit(1);
}
console.log(`API contracts cover ${Object.keys(contracts.endpoints).length} endpoints.`);
