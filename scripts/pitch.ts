// npm run pitch -- <domain|id> [more...]
// Build (or rebuild) a store's pitch page: its demo code, its slug and the sample chat, made by the real agent on
// one of its real products (two questions and two answers, or none: then the page waits in the review queue). Prints the page's address. The store must be ingested first (npm run ingest).
//
// npm run pitch -- --check [--rebuild]
// Read every page's sample chat again, the way its store's owner will (src/pitch/review.ts; the owner, 2026-11-12, on
// the first demo they opened: "make sure it catches things like that"), and list each one turned down with why.
// --rebuild builds each of those again; a page already sent keeps its chat when no new one passes either, so a link a
// store has does not stop opening.

import { makeApp } from '../src/app.ts';
import { canonicalDomain } from '../src/core/urls.ts';
import { buildPitch } from '../src/pitch/build.ts';
import { reviewStored } from '../src/pitch/review.ts';
import { pitchUrl } from '../src/outreach.ts';

const app = await makeApp({ quiet: true });
const log = (m: string) => console.log(`  ${m}`);
try {
  if (process.argv.includes('--check')) {
    const rebuild = process.argv.includes('--rebuild');
    const pages = await app.db.query<{ id: number; domain: string; sent_at: string | null }>(
      "SELECT s.id, s.domain, s.sent_at FROM stores s JOIN pitches p ON p.store_id = s.id WHERE s.page_built_at IS NOT NULL AND s.taken_down_at IS NULL AND s.status <> 'skipped' AND jsonb_array_length(p.sample_chat) >= 4 ORDER BY s.id",
    );
    let down = 0;
    for (const s of pages) {
      const r = await reviewStored(app, s.id);
      if (!r || r.ok) {
        console.log(`✓ ${s.domain}`);
        continue;
      }
      down++;
      console.log(`✗ ${s.domain}${s.sent_at ? ' (sent)' : ''}: ${r.why}`);
      if (!rebuild) continue;
      const b = await buildPitch(app, s.id, { keep: Boolean(s.sent_at), log });
      console.log(b.chat.length ? `  rebuilt: ${pitchUrl(app.env, b.slug)}` : b.kept ? '  no new chat passed: it keeps the one it had, since it was sent' : '  no new chat passed: the page waits in review');
      for (const m of b.chat || []) console.log(`    ${m.role === 'agent' ? '←' : '→'} ${m.text.replace(/\n/g, ' ')}`);
    }
    console.log(`${pages.length} pages read, ${down} turned down${rebuild ? ', each built again' : ''}.`);
  }
  for (const key of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
    const s = await app.db.one<any>('SELECT id, domain, ingested_at FROM stores WHERE id::text = $1 OR domain = $2', [key, canonicalDomain(key)]);
    if (!s?.ingested_at) {
      console.log(`✗ ${key}: not ingested yet`);
      continue;
    }
    const r = await buildPitch(app, s.id, { log });
    console.log(`✓ ${s.domain}: ${pitchUrl(app.env, r.slug)}  code ${r.code}  (${r.chat.length ? `sample chat: the agent, ${r.turns} turns, second question on ${r.second}` : `no sample chat after ${r.turns} turns: the page waits in review`})`);
    for (const t of r.turnedDown || []) console.log(`    turned down (${t.product}, ${t.question}): ${t.why}`);
    for (const m of r.chat || []) console.log(`    ${m.role === 'agent' ? '←' : '→'} ${m.text.replace(/\n/g, ' ')}`);
  }
} finally {
  await app.db.close();
}
