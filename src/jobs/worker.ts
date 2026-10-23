import type { App } from '../app.ts';
import { cleanLine } from '../core/hebrew.ts';
import { ingestStore } from '../ingest/pack.ts';
import { buildPitch } from '../pitch/build.ts';
import { forgetStorePrompt } from '../agent/loop.ts';
import { handleInbound } from '../channels/route.ts';
import { discover } from '../leads/discover.ts';
import { canonicalDomain } from '../core/urls.ts';
import { event } from '../db/log.ts';
import { claim, done, enqueue, fail, progress, type Job } from './queue.ts';

// The worker: runs the queue's jobs, and once a minute schedules what is due.
//
//   wa_inbound   a WhatsApp message: route it, answer it (channels/route.ts)
//   mail_inbound an email to a store's address, or Resend's report of a bounce: the same
//   add_store    "add by URL" from the dashboard, or a demo asked for on the website: detect and score, ingest, build
//                the page
//   ingest       ingest a store again and rebuild its page (after an edit, or by hand)
//   rescrape     the daily refresh of a store whose demo is open
//
// Scheduled each minute: a rescrape for every store with a built page that is not
// skipped and was last ingested over 20 hours ago; expired WhatsApp bindings cleaned up.

export async function runJob(app: App, job: Job): Promise<unknown> {
  const p = job.payload || {};
  const say = (line: string) => progress(app.db, job.id, line);
  switch (job.kind) {
    case 'wa_inbound':
      return handleInbound(app, p);
    case 'mail_inbound':
      return handleInbound(app, { ...p, channel: 'email' });
    case 'add_store': {
      await say('בודק את האתר');
      const domain = canonicalDomain(p.url);
      const gen = (async function* () {
        yield { url: p.url, source: 'manual', detail: { by: p.by || null } };
      })();
      const r = await discover(app.db, gen, { fetcher: app.fetcher, render: app.render, limit: 1 }, 'manual');
      const store = await app.db.one<{ id: number; platform: string; reject_reason: string | null }>('SELECT id, platform, reject_reason FROM stores WHERE domain = $1', [domain]);
      if (!store) {
        const seen = await app.db.one<{ reason: string | null }>('SELECT reason FROM seen_domains WHERE domain = $1', [domain]);
        throw new Error(seen?.reason ? `האתר לא נכנס כליד: ${seen.reason}` : 'האתר לא נמצא או לא ענה');
      }
      // Asked for on the website: the number that asked is the one to send the page to.
      if (/^9725\d{8}$/.test(String(p.whatsapp || ''))) await app.db.query('UPDATE stores SET contact_whatsapp = $2 WHERE id = $1', [store.id, p.whatsapp]);
      if (store.platform !== 'shopify') return { storeId: store.id, stats: r.stats, ingested: false, why: `the platform is ${store.platform}: phase 1 ingests Shopify only` };
      return { storeId: store.id, ...(await ingestAndBuild(app, store.id, say)) };
    }
    case 'discover': {
      const { storecensus, crawl, seeds, brave, braveQueries } = await import('../leads/sources.ts');
      const src = String(p.source || 'storecensus');
      const gen =
        src === 'crawl' ? crawl(app.db, { limit: 40 })
        : src === 'seeds' ? seeds(app.fetcher)
        : src === 'brave' ? brave(app.db, { apiKey: String(app.env.BRAVE_API_KEY || ''), queries: braveQueries(Math.floor(Date.now() / 86_400_000), 5) })
        : storecensus(app.fetcher, { fromPage: Number(p.from) || 1, pages: 3 });
      const r = await discover(app.db, gen, { fetcher: app.fetcher, render: app.render, limit: 40, log: (m) => void say(m.trim().slice(0, 150)) }, src);
      return r.stats;
    }
    case 'ingest':
    case 'rescrape':
      return { storeId: p.storeId, ...(await ingestAndBuild(app, Number(p.storeId), say, job.kind === 'rescrape')) };
    default:
      throw new Error(`unknown job kind ${job.kind}`);
  }
}

async function ingestAndBuild(app: App, storeId: number, say: (l: string) => Promise<void>, rescrape = false) {
  const s = await ingestStore(app, storeId, { progress: (m) => void say(m) });
  forgetStorePrompt(storeId);
  // A daily re-scrape keeps the sample chat the owner approved; an ingest asked for by hand rebuilds the page.
  const built = await app.db.one('SELECT page_built_at FROM stores WHERE id = $1', [storeId]);
  if (!rescrape || !built?.page_built_at) {
    await say('בונה את דף הדמו ואת שיחת הדוגמה');
    await buildPitch(app, storeId);
  }
  if (rescrape) await event(app.db, storeId, 'rescrape', { products: s.products, gone: s.gone });
  return { products: s.products, policies: s.policies.length, warnings: s.warnings };
}

export async function schedule(app: App) {
  const due = await app.db.query<{ id: number }>(
    "SELECT id FROM stores WHERE page_built_at IS NOT NULL AND status <> 'skipped' AND platform = 'shopify' AND (ingested_at IS NULL OR ingested_at < now() - interval '20 hours')",
  );
  for (const s of due) await enqueue(app.db, 'rescrape', { storeId: s.id }, { dedupeKey: `ingest:${s.id}` });
  await app.db.query("DELETE FROM wa_users WHERE expires_at < now() - interval '1 day'");
}

/** Run jobs until none is due (tests and one-shot scripts). */
export async function drain(app: App, { kinds = null }: { kinds?: string[] | null } = {}): Promise<number> {
  let n = 0;
  for (let job = await claim(app.db, kinds); job; job = await claim(app.db, kinds)) {
    await runOne(app, job);
    n++;
  }
  return n;
}

async function runOne(app: App, job: Job) {
  try {
    const result = await runJob(app, job);
    await done(app.db, job.id, result ?? null);
  } catch (e: any) {
    app.log(`[job ${job.id} ${job.kind}] ${cleanLine(e?.stack || e?.message || e, 800)}`);
    await fail(app.db, job, String(e?.message || e));
  }
}

/** The long-running worker: messages first (a customer waits on them), then the rest. */
export function startWorker(app: App, { idleMs = 1000, concurrency = 2 }: { idleMs?: number; concurrency?: number } = {}) {
  let stopped = false;
  let lastSchedule = 0;
  const loop = async () => {
    while (!stopped) {
      try {
        if (Date.now() - lastSchedule > 60_000) {
          lastSchedule = Date.now();
          await schedule(app);
        }
        const job = (await claim(app.db, ['wa_inbound', 'mail_inbound'])) || (await claim(app.db));
        if (job) await runOne(app, job);
        else await new Promise((r) => setTimeout(r, idleMs));
      } catch (e: any) {
        app.log(`[worker] ${e?.message || e}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  const loops = Array.from({ length: concurrency }, loop);
  return {
    stop: async () => {
      stopped = true;
      await Promise.allSettled(loops);
    },
  };
}
