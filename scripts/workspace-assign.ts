// npm run workspace:assign -- <workspace id | none> <store id or domain>... [--dry-run]
//
// Gives stores to a workspace of openfrequency-accounts (the customer's), so that workspace's sessions see them and
// nothing else (src/web/workspace.ts). "none" gives them back to the operator. The workspace id is the one accounts'
// admin shows. --dry-run says what would change and changes nothing.
import { makeApp } from '../src/app.ts';
import { audit } from '../src/db/log.ts';

const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
const dry = process.argv.includes('--dry-run');
const [ws, ...stores] = args;
const workspaceId = ws === 'none' ? null : Number(ws);
if (!ws || (workspaceId !== null && !(Number.isInteger(workspaceId) && workspaceId > 0)) || !stores.length) {
  console.log('usage: npm run workspace:assign -- <workspace id | none> <store id or domain>... [--dry-run]');
  process.exit(1);
}
const app = await makeApp({ quiet: true });
let failed = false;
for (const key of stores) {
  const s = await app.db.one<{ id: number; domain: string; workspace_id: number | null }>(/^\d+$/.test(key) ? 'SELECT id, domain, workspace_id FROM stores WHERE id = $1' : 'SELECT id, domain, workspace_id FROM stores WHERE domain = $1', [/^\d+$/.test(key) ? Number(key) : key.toLowerCase()]);
  if (!s) {
    console.log(`${key}: no such store`);
    failed = true;
    continue;
  }
  const from = s.workspace_id ?? 'none';
  const to = workspaceId ?? 'none';
  if (from === to) {
    console.log(`${s.domain} (${s.id}): already ${to}`);
    continue;
  }
  console.log(`${s.domain} (${s.id}): ${from} -> ${to}${dry ? ' (dry run)' : ''}`);
  if (dry) continue;
  await app.db.query('UPDATE stores SET workspace_id = $2, updated_at = now() WHERE id = $1', [s.id, workspaceId]);
  await audit(app.db, { actor: 'cli', action: 'workspace_assign', storeId: s.id, detail: { from: s.workspace_id, to: workspaceId } });
}
await app.db.close();
process.exit(failed ? 1 : 0);
