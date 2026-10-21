// npm run leads -- <command>
//
//   find  [--source storecensus|seeds|brave|crawl|all] [--pages N] [--from-page N] [--limit N] [--queries N]
//         discovery: candidates in, scored leads out
//   add   <url> [<url>...]       one store by hand (what the dashboard's "add by URL" does)
//   list  [--all]                the leads, qualified first (--all includes the unqualified)
//   show  <domain|id>            one lead with its score breakdown and signals
//
// Discovery only reads: it fetches public pages politely (robots.txt, one request a
// second per host) and never contacts anyone.

import { makeApp } from '../src/app.ts';
import { closeBrowser } from '../src/core/browser.ts';
import { israelDate } from '../src/core/clock.ts';
import { discover } from '../src/leads/discover.ts';
import { brave, braveQueries, crawl, seeds, storecensus, type Candidate } from '../src/leads/sources.ts';

const args = process.argv.slice(2);
const cmd = args[0] || 'list';
const opt = (name: string, d: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const app = await makeApp({ quiet: true });
const say = (m: string) => console.log(m);

async function* chain(...gens: AsyncIterable<Candidate>[]) {
  for (const g of gens) yield* g;
}

try {
  if (cmd === 'find') {
    const source = opt('source', 'storecensus');
    const limit = Number(opt('limit', '40'));
    const pages = Number(opt('pages', '3'));
    const fromPage = Number(opt('from-page', '1'));
    const gens: AsyncIterable<Candidate>[] = [];
    if (source === 'storecensus' || source === 'all') gens.push(storecensus(app.fetcher, { fromPage, pages }));
    if (source === 'seeds' || source === 'all') gens.push(seeds(app.fetcher));
    if (source === 'crawl' || source === 'all') gens.push(crawl(app.db, { limit }));
    if (source === 'brave' || source === 'all') {
      if (!app.env.BRAVE_API_KEY) say('brave: BRAVE_API_KEY is not set in private/.env, skipped');
      else {
        const day = Math.floor(Date.parse(`${israelDate()}T00:00:00Z`) / 86_400_000);
        gens.push(brave(app.db, { apiKey: app.env.BRAVE_API_KEY, queries: braveQueries(day, Number(opt('queries', '5'))) }));
      }
    }
    say(`discovery: ${source}, up to ${limit} new leads`);
    const { stats } = await discover(app.db, chain(...gens), { fetcher: app.fetcher, render: app.render, limit, log: say }, source);
    say(`\n${stats.candidates} candidates · ${stats.skipped} already seen · ${stats.leads} new leads (${stats.qualified} qualified) · ${stats.merged} merged · ${stats.rejected} not stores · ${stats.failed} failed`);
    for (const [r, n] of Object.entries(stats.byReason).sort((a, b) => b[1] - a[1])) say(`  ${n} × ${r}`);
  } else if (cmd === 'add') {
    const urls = args.slice(1).filter((a) => !a.startsWith('--'));
    const gen = (async function* () {
      for (const u of urls) yield { url: u, source: 'manual', detail: {} } as Candidate;
    })();
    const { stats } = await discover(app.db, gen, { fetcher: app.fetcher, render: app.render, limit: urls.length, log: say }, 'manual');
    say(`${stats.leads} added, ${stats.merged} merged, ${stats.skipped} already known, ${stats.rejected + stats.failed} not added`);
  } else if (cmd === 'forget-failed') {
    // After a network outage: the domains that failed to load are tried again on the next run.
    const r = await app.db.query("DELETE FROM seen_domains WHERE verdict = 'failed' RETURNING domain");
    say(`${r.length} failed domains will be tried again`);
  } else if (cmd === 'rescore') {
    // Detect and score every new lead again (after a change to detection or scoring). Their status is kept.
    const { detect } = await import('../src/leads/detect.ts');
    const { scoreStore } = await import('../src/leads/score.ts');
    const { saveLead } = await import('../src/leads/store.ts');
    const rows = await app.db.query<{ id: number; url: string; source: string; source_detail: any }>("SELECT id, url, source, source_detail FROM stores WHERE status = 'new' ORDER BY id");
    for (const r of rows) {
      try {
        const d = await detect(r.url, { fetcher: app.fetcher, render: app.render });
        const s = scoreStore(d);
        await saveLead(app.db, d, s, r.source, r.source_detail);
        say(`  ${s.qualified ? '✓' : '–'} ${d.domain} ${s.score}${s.reject ? ` (${s.reject})` : ''}`);
      } catch (e: any) {
        say(`  ✗ ${r.url}: ${e.code || e.message}`);
      }
    }
  } else if (cmd === 'list') {
    const all = args.includes('--all');
    const rows = await app.db.query<any>(`SELECT id, domain, name, platform, score, qualified, reject_reason, status, signals->>'productCount' AS n FROM stores ${all ? '' : 'WHERE qualified'} ORDER BY qualified DESC, score DESC`);
    for (const r of rows) say(`${String(r.id).padStart(4)}  ${String(r.score).padStart(3)} ${r.qualified ? '✓' : ' '}  ${r.platform.padEnd(11)} ${String(r.n ?? '?').padStart(5)}  ${r.status.padEnd(12)} ${r.domain}${r.reject_reason ? `  (${r.reject_reason})` : ''}`);
    const c = await app.db.one<any>('SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE qualified)::int AS q FROM stores');
    say(`\n${c.q} qualified of ${c.n} stores`);
  } else if (cmd === 'show') {
    const key = args[1];
    const r = await app.db.one<any>('SELECT * FROM stores WHERE domain = $1 OR id::text = $1', [key]);
    if (!r) say('no such lead');
    else {
      say(`${r.name} (${r.domain})  ${r.platform}  score ${r.score}${r.qualified ? ' qualified' : ''}${r.reject_reason ? `  rejected: ${r.reject_reason}` : ''}`);
      for (const f of r.score_breakdown) say(`  ${f.factor.padEnd(10)} ${String(f.points).padStart(3)}/${f.max}  ${f.evidence}`);
      say(`  contact: ${[r.contact_email, r.contact_whatsapp && 'WhatsApp', r.contact_phone && 'phone'].filter(Boolean).join(', ') || 'none'}`);
      say(`  source: ${r.source} ${JSON.stringify(r.source_detail)}`);
    }
  } else say('commands: find | add <url> | list [--all] | show <domain|id>');
} finally {
  await closeBrowser();
  await app.db.close();
}
