// npm run pitch -- <domain|id> [more...]
// Build (or rebuild) a store's pitch page: its demo code, its slug and the sample chat, made by the real agent on
// one of its real products (two questions and two answers, or none: then the page waits in the review queue). Prints the page's address. The store must be ingested first (npm run ingest).

import { makeApp } from '../src/app.ts';
import { canonicalDomain } from '../src/core/urls.ts';
import { buildPitch } from '../src/pitch/build.ts';
import { pitchUrl } from '../src/outreach.ts';

const app = await makeApp({ quiet: true });
try {
  for (const key of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
    const s = await app.db.one<any>('SELECT id, domain, ingested_at FROM stores WHERE id::text = $1 OR domain = $2', [key, canonicalDomain(key)]);
    if (!s?.ingested_at) {
      console.log(`✗ ${key}: not ingested yet`);
      continue;
    }
    const r = await buildPitch(app, s.id, { log: (m) => console.log(`  ${m}`) });
    console.log(`✓ ${s.domain}: ${pitchUrl(app.env, r.slug)}  code ${r.code}  (${r.chat.length ? `sample chat: the agent, ${r.turns} turns, second question on ${r.second}` : `no sample chat after ${r.turns} turns: the page waits in review`})`);
    for (const m of r.chat || []) console.log(`    ${m.role === 'agent' ? '←' : '→'} ${m.text.replace(/\n/g, ' ')}`);
  }
} finally {
  await app.db.close();
}
