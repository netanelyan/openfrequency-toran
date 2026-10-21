// npm run init-private: create the private folder with an .env to fill in, and the database.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureDir, home, ROOT } from '../src/core/paths.ts';
import { openDb } from '../src/db/index.ts';

const h = ensureDir(home());
const env = path.join(h, '.env');
if (!existsSync(env)) {
  copyFileSync(path.join(ROOT, '.env.example'), env);
  // A session secret is the one value nobody needs to choose.
  const text = readFileSync(env, 'utf8').replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${randomBytes(32).toString('hex')}`);
  writeFileSync(env, text);
  console.log(`created ${env}: fill in the keys you have`);
} else console.log(`${env} exists, left as it is`);
for (const f of ['known-stores.txt', 'public-denylist.txt']) {
  const p = path.join(h, f);
  if (!existsSync(p)) writeFileSync(p, `# ${f === 'known-stores.txt' ? 'every real store the engine touched; written by the engine, read by check:public' : 'any other word that must never be committed (one a line)'}\n`);
}
ensureDir(path.join(h, 'logs'));
const db = await openDb();
console.log(`database ready (${db.kind})`);
await db.close();
