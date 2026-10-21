// npm run ingest -- <domain|id|url> [more...] [--verify]
//   ingest a store into its knowledge pack (a URL that is not a lead yet is detected and added first)
// npm run ingest -- verify <domain|id>   check stored prices against each product's own JSON
// npm run ingest -- export <domain|id>   write the pack to private/packs/<domain>.json

import { makeApp } from '../src/app.ts';
import { closeBrowser } from '../src/core/browser.ts';
import { canonicalDomain } from '../src/core/urls.ts';
import { discover } from '../src/leads/discover.ts';
import { exportPack, ingestStore, verifyPrices } from '../src/ingest/pack.ts';

const args = process.argv.slice(2);
const app = await makeApp({ quiet: true });
const say = (m: string) => console.log(m);

async function storeId(key: string): Promise<number | null> {
  const d = canonicalDomain(key);
  const r = await app.db.one<{ id: number }>('SELECT id FROM stores WHERE id::text = $1 OR domain = $2', [key, d]);
  if (r) return r.id;
  if (!d) return null;
  say(`${d} is not a lead yet: detecting it`);
  const gen = (async function* () {
    yield { url: key, source: 'manual', detail: {} };
  })();
  await discover(app.db, gen, { fetcher: app.fetcher, render: app.render, limit: 1, log: say }, 'manual');
  return (await app.db.one<{ id: number }>('SELECT id FROM stores WHERE domain = $1', [d]))?.id ?? null;
}

try {
  const cmd = args[0];
  if (cmd === 'verify' || cmd === 'export') {
    const id = await storeId(args[1]);
    if (!id) throw new Error('no such store');
    if (cmd === 'export') say(await exportPack(app.db, id));
    else {
      const v = await verifyPrices(app, id);
      say(`${v.ok}/${v.checked} prices match the product's own page${v.mismatches.length ? '' : ' ✓'}`);
      for (const m of v.mismatches) say(`  ✗ ${m.title}: stored ${m.stored}, live ${m.live}`);
    }
  } else {
    for (const key of args.filter((a) => !a.startsWith('--'))) {
      const id = await storeId(key);
      if (!id) {
        say(`✗ ${key}: not found and not detectable`);
        continue;
      }
      const t0 = Date.now();
      try {
        const s = await ingestStore(app, id, { progress: (m) => process.stdout.write(`\r  ${m}                    `) });
        process.stdout.write('\r');
        say(`✓ ${s.domain}: ${s.products} products (${s.available} in stock${s.gone ? `, ${s.gone} gone` : ''}), ${s.policies.length} policy pages [${s.policies.map((p) => p.kind).join(', ')}], ${s.chunks} chunks, ${s.faqs} FAQ, colours ${s.brand.colors.join(' ') || 'none'}${s.brand.logo ? ', logo' : ''}${s.brand.tone ? ', tone sample' : ''} (${Math.round((Date.now() - t0) / 1000)} s)`);
        for (const w of s.warnings) say(`    ! ${w}`);
        if (args.includes('--verify')) {
          const v = await verifyPrices(app, id);
          say(`    prices: ${v.ok}/${v.checked} match the product's own page${v.mismatches.length ? '' : ' ✓'}`);
          for (const m of v.mismatches) say(`    ✗ ${m.title}: stored ${m.stored}, live ${m.live}`);
        }
        await exportPack(app.db, id);
      } catch (e: any) {
        process.stdout.write('\r');
        say(`✗ ${key}: ${e.message}`);
      }
    }
  }
} finally {
  await closeBrowser();
  await app.db.close();
}
