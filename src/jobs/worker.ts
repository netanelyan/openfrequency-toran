import type { App } from '../app.ts';
import { cleanLine } from '../core/hebrew.ts';
import { ingestStore } from '../ingest/pack.ts';
import { INGESTIBLE, INGESTIBLE_EN, canIngest } from '../ingest/catalogue.ts';
import { buildPitch } from '../pitch/build.ts';
import { forgetStorePrompt } from '../agent/loop.ts';
import { handleInbound } from '../channels/route.ts';
import { discover } from '../leads/discover.ts';
import { canonicalDomain } from '../core/urls.ts';
import { event } from '../db/log.ts';
import { claim, done, enqueue, fail, progress, type Job } from './queue.ts';
import { handleTederEvent, handleTederReady } from '../owners/events.ts';
import { deliverRequested } from '../ops/actions.ts';
import { checkAccount, checkToken, deliveryStatus, ownerEcho } from '../channels/waStore.ts';
import { refreshInstagram, REFRESH_DAYS, socialEcho } from '../channels/socialStore.ts';
import { checkDomain, domainsToCheck } from '../channels/mailDomain.ts';

// The worker: runs the queue's jobs, and once a minute schedules what is due.
//
//   wa_inbound   a WhatsApp message: route it, answer it (channels/route.ts)
//   mail_inbound an email to a store's address, or Resend's report of a bounce: the same
//   wa_echo      the owner wrote to a customer from the WhatsApp Business app on their phone (channels/waStore.ts)
//   wa_status    Meta's delivery report on a message from a store's own number: a failure is kept
//   wa_check     a store's own WhatsApp number's state at Meta, read again (pending ones every ten minutes)
//   wa_token     a store's WhatsApp token, read again once a day: renewed before it ends, or the store asked to
//                connect again (channels/waStore.ts checkToken)
//   dm_inbound   a message to a store's Facebook Page (Messenger) or Instagram account: the same as wa_inbound
//   dm_echo      the owner answered from the Page's inbox or the Instagram app (channels/socialStore.ts)
//   ig_refresh   an Instagram token's 60 days, renewed before they end
//   mail_domain_check  a store's own mail domain read again at Resend, until it is verified (channels/mailDomain.ts)
//   add_store    "add by URL" from the dashboard, or a demo asked for on the website: detect and score, ingest, build
//                the page
//   ingest       ingest a store again and rebuild its page (after an edit, or by hand)
//   rescrape     the daily refresh of a store whose demo is open
//   teder_event  Teder's news for a workspace's owners, on the owner line (owners/events.ts)
//   teder_ready  the posts waiting for a workspace's approval, as one numbered list, a moment after Teder's post.ready
//                events stop coming
//
// Scheduled each minute: a rescrape for every store with a built page that is not
// skipped and was last ingested over 20 hours ago; expired WhatsApp bindings cleaned up; the link to each demo asked
// for on the website whose page is now ready, sent on the demo number.

export async function runJob(app: App, job: Job): Promise<unknown> {
  const p = job.payload || {};
  const say = (line: string) => progress(app.db, job.id, line);
  switch (job.kind) {
    case 'wa_inbound':
      return handleInbound(app, p);
    case 'mail_inbound':
      return handleInbound(app, { ...p, channel: 'email' });
    case 'wa_echo':
      return ownerEcho(app, p);
    case 'wa_status':
      return deliveryStatus(app, p);
    case 'wa_check':
      return checkAccount(app, Number(p.accountId));
    case 'wa_token':
      return checkToken(app, Number(p.accountId));
    case 'dm_inbound':
      return handleInbound(app, p);
    case 'dm_echo':
      return socialEcho(app, p);
    case 'ig_refresh':
      return refreshInstagram(app, Number(p.accountId));
    case 'mail_domain_check': {
      const d = await checkDomain(app, Number(p.storeId), { verify: false });
      return d ? { domain: d.domain, status: d.status, receiving: d.receiving_status } : null;
    }
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
      if (!canIngest(store.platform)) return { storeId: store.id, stats: r.stats, ingested: false, why: `the platform is ${store.platform}: Toran reads ${INGESTIBLE_EN} stores` };
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
    case 'teder_event':
      return handleTederEvent(app, String(p.id || ''));
    case 'teder_ready':
      return handleTederReady(app, Number(p.workspace));
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
    "SELECT id FROM stores WHERE page_built_at IS NOT NULL AND status <> 'skipped' AND platform = ANY($1::text[]) AND (ingested_at IS NULL OR ingested_at < now() - interval '20 hours')",
    [[...INGESTIBLE]],
  );
  for (const s of due) await enqueue(app.db, 'rescrape', { storeId: s.id }, { dedupeKey: `ingest:${s.id}` });
  await app.db.query("DELETE FROM wa_users WHERE expires_at < now() - interval '1 day'");
  // A demo asked for on the website whose page is ready: its link, on the demo number (ops/actions.ts).
  await deliverRequested(app);
  // A store's own WhatsApp number waiting at Meta: read again every ten minutes, so it turns on by itself.
  const pending = await app.db.query<{ id: number }>("SELECT id FROM channel_accounts WHERE channel = 'whatsapp' AND kind = 'meta' AND status = 'pending' AND COALESCE((meta->>'checked_at')::timestamptz, 'epoch') < now() - interval '10 minutes'");
  for (const a of pending) await enqueue(app.db, 'wa_check', { accountId: a.id }, { dedupeKey: `wa_check:${a.id}`, maxAttempts: 1 });
  // A store's WhatsApp token: read once a day, and at once when the end we know of has come.
  const tokens = await app.db.query<{ id: number }>("SELECT id FROM channel_accounts WHERE channel = 'whatsapp' AND kind = 'meta' AND status IN ('active', 'pending') AND secret IS NOT NULL AND (token_checked_at IS NULL OR token_checked_at < now() - interval '1 day' OR token_expires_at <= now())");
  for (const a of tokens) await enqueue(app.db, 'wa_token', { accountId: a.id }, { dedupeKey: `wa_token:${a.id}`, maxAttempts: 1 });
  // An Instagram token that ends within REFRESH_DAYS, and was not renewed today: a fresh 60 days.
  const ending = await app.db.query<{ id: number }>(`SELECT id FROM channel_accounts WHERE channel = 'instagram' AND status = 'active' AND (meta->>'expires_at')::timestamptz < now() + interval '${REFRESH_DAYS} days' AND COALESCE((meta->>'refreshed_at')::timestamptz, connected_at) < now() - interval '1 day'`);
  for (const a of ending) await enqueue(app.db, 'ig_refresh', { accountId: a.id }, { dedupeKey: `ig_refresh:${a.id}`, maxAttempts: 3 });
  // A store's own mail domain whose DNS records are not verified yet: read again every ten minutes, for three days.
  if (app.mail) for (const storeId of await domainsToCheck(app)) await enqueue(app.db, 'mail_domain_check', { storeId }, { dedupeKey: `mail_domain:${storeId}`, maxAttempts: 1 });
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
        const job = (await claim(app.db, ['wa_inbound', 'mail_inbound', 'wa_echo'])) || (await claim(app.db));
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
