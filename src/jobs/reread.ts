import type { App } from '../app.ts';
import { israelDate } from '../core/clock.ts';
import { cleanLine } from '../core/hebrew.ts';
import { J } from '../db/index.ts';
import { event } from '../db/log.ts';
import { forgetStorePrompt } from '../agent/loop.ts';
import { COMPANY, exportHash, parseExport, syncCompany } from '../company.ts';
import { enqueue } from './queue.ts';

// Our support re-reads the website by itself (the owner, 2026-11-01: "toran re reads the website once a day, and
// updates itself"). A customer's store is re-scraped every day (worker.ts, 'rescrape'); the company store, which has
// no catalogue to scrape, gets the site's own export instead: openfrequency-web's real build publishes it as
// https://openfrequency.co.il/support.json (its src/support.mjs, the same object `npm run support` writes), and
// TORAN_SUPPORT_EXPORT_URL names it here. Empty, nothing is read, and the store is synced by hand as before
// (`npm run company -- sync <file>`). There is no default: a laptop's worker or a test would read the live site.
//
//   scheduleReread  the worker's schedule, each minute: the read is queued once an Israel day (the first minute after
//                   midnight, as the retention pass is) and once soon after each start of this process, so a deploy of
//                   Toran picks up the site at once. One live job at a time (its dedupe key)
//   rereadCompany   the job (company_reread): GET the URL with a timeout and a size cap, through the engine's fetcher
//                   (its address rule, and robots.txt: a draft of the site, which disallows everything, is never read),
//                   check it exactly as the sync by hand does (parseExport), and sync it (syncCompany) only when its
//                   hash differs from the one the store's last sync kept; then the store's prompt is forgotten, so
//                   the next answer is made from what the site says now
//
// Which store: the company store whose domain the export names, and it must be there already: the first sync is by
// hand, where its id, slug and email address are printed. With TORAN_SUPPORT_STORE set (company.ts supportAccount),
// an export for any other domain is refused, so a wrong URL never feeds our number's support from another site.
//
// A failed read (the network, a timeout, an HTTP error, a body over the cap, not JSON, not an export, no such store)
// is one log line and a company_reread event with the reason; the store keeps every plan, question and page it had,
// since nothing is written before the whole file has passed, and the sync itself is one transaction. The next try is
// the next Israel day, or the next start. Each read writes one company_reread event, like the rescrape one: changed
// or not, and what the sync wrote.
//
// The hash is what keeps the sync to the days the site changed. Embedding the chunks (ingest/embed.ts) runs on this
// machine's CPU, $0 a call and no paid API, but it loads a model of about 120 MB on a server that already sits near its
// memory cap, and the sync rewrites every page and chunk; an unchanged export costs one GET of about 50 KB.

/** The export is about 50 KB (2026-11-01); a megabyte is room for it to grow, and still a cap. */
export const REREAD_MAX_BYTES = 1024 * 1024;
export const REREAD_TIMEOUT_MS = 15_000;
const KEY = 'company_reread';

/** The URL of the site's export, or null: the daily read is off. */
export const rereadUrl = (env: App['env']) => String(env.TORAN_SUPPORT_EXPORT_URL || '').trim() || null;

// The databases this process has queued its read for since it started: a test's app is a new one each time, the
// server's is one for its life.
const queuedSinceStart = new WeakSet<object>();

/** The worker's call each minute: true when the read was queued now (a new Israel day, or the first call since start). */
export async function scheduleReread(app: App): Promise<boolean> {
  if (!rereadUrl(app.env)) return false;
  const today = israelDate();
  const last = await app.db.one<{ value: any }>('SELECT value FROM settings WHERE key = $1', [KEY]);
  if (queuedSinceStart.has(app.db) && last?.value?.day === today) return false;
  queuedSinceStart.add(app.db);
  await app.db.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [KEY, J({ day: today, at: new Date().toISOString() })]);
  await enqueue(app.db, KEY, {}, { dedupeKey: KEY, maxAttempts: 1 });
  return true;
}

export type Reread = { url: string; ok: boolean; changed: boolean; storeId: number | null; hash?: string; error?: string; plans?: number; faqs?: number; faqsRemoved?: number; policies?: number; chunks?: number };

/** The job: read the site's export, and sync it when it changed. Never throws for a bad read; null when it is off. */
export async function rereadCompany(app: App, { forget = forgetStorePrompt }: { forget?: (storeId: number) => unknown } = {}): Promise<Reread | null> {
  const url = rereadUrl(app.env);
  if (!url) return null;
  let storeId: number | null = null;
  const done = async (r: Reread, line: string) => {
    app.log(`[reread] ${url}: ${line}`);
    await event(app.db, r.storeId, KEY, { ...r }).catch((e) => app.log(`[reread] the event was not written: ${e?.message || e}`));
    return r;
  };
  try {
    if (!/^https:\/\//.test(url)) throw new Error('TORAN_SUPPORT_EXPORT_URL is not an https:// address');
    const res = await app.fetcher(url, { accept: 'application/json', maxBytes: REREAD_MAX_BYTES, timeoutMs: REREAD_TIMEOUT_MS });
    const d = parseExport(res.text);
    const want = String(app.env.TORAN_SUPPORT_STORE || '').trim().toLowerCase();
    if (want && d.domain !== want) throw new Error(`the export is for ${d.domain}, and TORAN_SUPPORT_STORE is ${want}`);
    const store = await app.db.one<{ id: number; config: any }>('SELECT id, config FROM stores WHERE domain = $1 AND platform = $2', [d.domain, COMPANY]);
    if (!store) throw new Error(`no company store ${d.domain} here: sync it once by hand (npm run company -- sync <file>)`);
    storeId = Number(store.id);
    const hash = exportHash(d);
    if (store.config?.company?.hash === hash) return await done({ url, ok: true, changed: false, storeId, hash }, `unchanged, store ${storeId} keeps what it has`);
    const s = await syncCompany(app, d, { from: url });
    forget(s.storeId);
    const r: Reread = { url, ok: true, changed: true, storeId: s.storeId, hash, plans: s.plans, faqs: s.faqs, faqsRemoved: s.faqsRemoved, policies: s.policies, chunks: s.chunks };
    return await done(r, `changed, store ${s.storeId} synced: ${s.plans} plans, ${s.faqs} questions${s.faqsRemoved ? ` (${s.faqsRemoved} dropped)` : ''}, ${s.policies} pages in ${s.chunks} chunks${s.embedded ? '' : ' (no embeddings)'}`);
  } catch (e: any) {
    const why = cleanLine(e?.message || e, 300);
    return done({ url, ok: false, changed: false, storeId, error: why }, `not read (${why}); the store keeps what it had`);
  }
}
