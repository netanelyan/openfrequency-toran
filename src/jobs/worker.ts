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
import { withDbLabel } from '../db/index.ts';
import { workerBeat } from '../health.ts';
import { BOOT, beat, claim, done, enqueue, fail, MESSAGE_KINDS, progress, requeueOrphans, type Job } from './queue.ts';
import { lostMessage } from './lost.ts';
import { dailyRetention } from './retention.ts';
import { alertOperator } from '../ops/alert.ts';
import { interruptedSends } from '../auto/send.ts';
import { handleTederEvent, handleTederReady } from '../owners/events.ts';
import { deliverRequested, deliverTeder } from '../ops/actions.ts';
import { handToTeder } from '../channels/request.ts';
import { checkAccount, checkToken, deliveryStatus, ownerEcho } from '../channels/waStore.ts';
import { refreshInstagram, REFRESH_DAYS, socialEcho } from '../channels/socialStore.ts';
import { checkDomain, domainsToCheck } from '../channels/mailDomain.ts';
import { handleHook, pollStore, scheduleAuto, sendDue, setupSource, submitNew } from '../auto/jobs.ts';
import { checkTemplates, templateStatus } from '../auto/templates.ts';

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
//                the page. With workspaceId, a customer's own store from /start: the same, the store born in their
//                workspace (never a lead to sell to)
//   ingest       ingest a store again and rebuild its page (after an edit, or by hand)
//   rescrape     the daily refresh of a store whose demo is open
//   teder_lead   a Teder demo asked for on the website, its code just sent from WhatsApp: handed to Teder (its POST
//                /internal/lead, channels/request.ts handToTeder), tried again while Teder does not take it
//   teder_event  Teder's news for a workspace's owners, on the owner line (owners/events.ts)
//   teder_ready  the posts waiting for a workspace's approval, as one numbered list, a moment after Teder's post.ready
//                events stop coming
//   auto_setup, auto_hook, auto_poll, auto_send   the automatic messages (cart, payment, shipping, review): a
//                store's webhooks registered, one webhook, a reading of its orders and checkouts, the messages due
//                (auto/jobs.ts)
//   wa_templates, wa_template_status   a store's WhatsApp templates at Meta, read again or as the webhook says
//   wa_templates_new   the new marketing templates (the URL button) for a store whose old ones are approved
//
// Scheduled each minute: a rescrape for every store with a built page that is not
// skipped and was last ingested over 20 hours ago, each at its own offset of up to six hours so the stores' re-scrapes
// do not all start in the same minute; expired WhatsApp bindings cleaned up; the link to each demo asked for on the
// website whose page is now ready, Toran's or Teder's, sent on the demo number; the automatic messages' readings and
// sends, and any left "sending" by a restart marked as not sent; the operator told when a customer's message has waited
// in the queue over five minutes; and once a day the retention pass (jobs/retention.ts).
//
// The loops (startWorker): TORAN_MESSAGE_LOOPS (2) take customers' messages and nothing else, so a re-scrape or an
// ingest never stands between a customer and their answer; TORAN_BACKGROUND_LOOPS (1) take everything else. A message
// job that fails its last attempt is not lost: the message and a handoff go into its conversation for the owner, and
// the operator hears of it (jobs/lost.ts). A running job's lease is refreshed every minute; at start every job another
// boot left running goes back to the queue, and on a stop the loops finish what they hold, for up to STOP_GRACE_MS.

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
      // A customer's own store, from /start (web/pages/start.ts): workspaceId is theirs, and the store is born in it.
      // The operator's "add by URL" carries none, and its store is a lead as before.
      const workspaceId = Number.isInteger(p.workspaceId) && p.workspaceId > 0 ? Number(p.workspaceId) : null;
      const gen = (async function* () {
        yield { url: p.url, source: workspaceId ? 'signup' : 'manual', detail: { by: p.by || null, ...(workspaceId ? { workspace: workspaceId } : {}) }, workspaceId };
      })();
      const r = await discover(app.db, gen, { fetcher: app.fetcher, render: app.render, limit: 1 }, workspaceId ? 'signup' : 'manual');
      const store = await app.db.one<{ id: number; platform: string; reject_reason: string | null; workspace_id: number | null }>('SELECT id, platform, reject_reason, workspace_id FROM stores WHERE domain = $1', [domain]);
      if (!store) {
        const seen = await app.db.one<{ reason: string | null }>('SELECT reason FROM seen_domains WHERE domain = $1', [domain]);
        throw new Error(seen?.reason ? `האתר לא נכנס כליד: ${seen.reason}` : 'האתר לא נמצא או לא ענה');
      }
      // The domain was nobody's when the customer asked (start.ts checks), but a lead found in between is merged, not
      // made: an operator's lead becomes theirs, another workspace's store is never handed over.
      if (workspaceId && store.workspace_id !== workspaceId) {
        const mine = await app.db.one('UPDATE stores SET workspace_id = $2, updated_at = now() WHERE id = $1 AND workspace_id IS NULL RETURNING id', [store.id, workspaceId]);
        if (!mine) throw new Error('the store is already another workspace\'s');
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
    case 'auto_setup':
      return setupSource(app, Number(p.storeId));
    case 'auto_hook':
      return handleHook(app, p);
    case 'auto_poll':
      return pollStore(app, Number(p.storeId));
    case 'auto_send':
      return sendDue(app);
    case 'wa_templates':
      return checkTemplates(app, Number(p.accountId));
    case 'wa_templates_new':
      return submitNew(app, Number(p.storeId));
    case 'wa_template_status':
      return templateStatus(app, p);
    case 'teder_lead':
      return handToTeder(app, Number(p.requestId));
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

/** A store's own offset for its daily re-scrape, up to six hours, the same every day. */
export const rescrapeOffsetMs = (storeId: number) => ((Number(storeId) * 2654435761) % 21_600) * 1000;

/** A customer's message waiting this long in the queue is said to the operator. */
export const QUEUE_ALERT_MINUTES = 5;

export async function schedule(app: App) {
  const due = await app.db.query<{ id: number }>(
    "SELECT id FROM stores WHERE page_built_at IS NOT NULL AND status <> 'skipped' AND platform = ANY($1::text[]) AND (ingested_at IS NULL OR ingested_at < now() - interval '20 hours')",
    [[...INGESTIBLE]],
  );
  for (const s of due) await enqueue(app.db, 'rescrape', { storeId: s.id }, { dedupeKey: `ingest:${s.id}`, runAt: new Date(Date.now() + rescrapeOffsetMs(s.id)) });
  await app.db.query("DELETE FROM wa_users WHERE expires_at < now() - interval '1 day'");
  // A demo asked for on the website whose page is ready: its link, on the demo number (ops/actions.ts). Teder's are
  // read from Teder only while one waits.
  await deliverRequested(app);
  await deliverTeder(app);
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
  // The automatic messages: each store's reading of its platform when due, the messages whose time has come, and any a
  // restart stopped in the middle of its send.
  await scheduleAuto(app);
  await interruptedSends(app);
  // A customer waiting on the queue.
  const old = await app.db.one<{ n: number; at: string | null }>(`SELECT COUNT(*)::int AS n, MIN(run_at) AS at FROM jobs WHERE status = 'queued' AND kind = ANY($1::text[]) AND run_at < now() - interval '${QUEUE_ALERT_MINUTES} minutes'`, [MESSAGE_KINDS]);
  if (old?.n) await alertOperator(app, 'queue_old', 'הודעות של לקוחות מחכות בתור', `${old.n} הודעות מחכות יותר מ-${QUEUE_ALERT_MINUTES} דקות, הוותיקה מ-${old.at}. כדאי לבדוק שה-worker של תורן רץ, ולהסתכל בדף התור.`, { everyMinutes: 30 });
  // Once a day, the retention pass.
  await dailyRetention(app);
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

/** How often a running job says it is alive (its lease is LEASE_MINUTES). */
export const BEAT_MS = 60_000;

export async function runOne(app: App, job: Job, { boot = BOOT }: { boot?: string } = {}) {
  const heartbeat = setInterval(() => void beat(app.db, job.id, boot).catch(() => {}), BEAT_MS);
  heartbeat.unref?.();
  try {
    // A query the database cancels for running too long is logged with the job's kind (db/index.ts).
    const result = await withDbLabel(`job ${job.kind}`, () => runJob(app, job));
    await done(app.db, job.id, result ?? null);
  } catch (e: any) {
    app.log(`[job ${job.id} ${job.kind}] ${cleanLine(e?.stack || e?.message || e, 800)}`);
    const last = await fail(app.db, job, String(e?.message || e));
    // A customer's message that failed every attempt: kept in its conversation for the owner, and said to the operator.
    if (last && MESSAGE_KINDS.includes(job.kind)) await lostMessage(app, job, String(e?.message || e)).catch((x) => app.log(`[job ${job.id}] the lost message could not be kept: ${x?.message || x}`));
  } finally {
    clearInterval(heartbeat);
  }
}

/** How long a stop waits for the loops to finish the jobs they hold. */
export const STOP_GRACE_MS = 25_000;

type WorkerOpts = { idleMs?: number; messageLoops?: number; backgroundLoops?: number; boot?: string; scheduler?: boolean };

/**
 * The long-running worker: its own loops for customers' messages, and the rest beside them. Two message loops by
 * default, as many loops as the whole worker had before: the server's Toran already sits at its memory cap with two
 * (SERVER-FACTS.md), and what more loops cost has not been measured. Raise TORAN_MESSAGE_LOOPS once it has.
 */
export function startWorker(app: App, { idleMs = 1000, messageLoops = Number(app.env.TORAN_MESSAGE_LOOPS) || 2, backgroundLoops = Number(app.env.TORAN_BACKGROUND_LOOPS) || 1, boot = BOOT, scheduler = true }: WorkerOpts = {}) {
  let stopped = false;
  let lastSchedule = 0;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Jobs another boot left running are put back first, so a restart costs a customer seconds, not a lease.
  const ready = requeueOrphans(app.db, boot)
    .then((n) => (n ? app.log(`[worker] ${n} job(s) left running by the last boot went back to the queue`) : undefined))
    .catch((e) => app.log(`[worker] could not put back the jobs left running: ${e?.message || e}`));
  const loop = async (kinds: string[] | null, schedules: boolean) => {
    await ready;
    while (!stopped) {
      try {
        // A sign of life for /readyz (health.ts): written at most every 30 seconds, whichever loop gets there.
        await workerBeat(app);
        if (schedules && Date.now() - lastSchedule > 60_000) {
          lastSchedule = Date.now();
          await schedule(app);
        }
        const job = kinds ? await claim(app.db, kinds, { boot }) : await claim(app.db, null, { except: MESSAGE_KINDS, boot });
        if (job) await runOne(app, job, { boot });
        else await pause(idleMs);
      } catch (e: any) {
        app.log(`[worker] ${e?.message || e}`);
        await pause(5000);
      }
    }
  };
  const loops = [
    ...Array.from({ length: Math.max(1, messageLoops) }, () => loop(MESSAGE_KINDS, false)),
    ...Array.from({ length: Math.max(1, backgroundLoops) }, (_, i) => loop(null, scheduler && i === 0)),
  ];
  return {
    /** Stop taking jobs, give the ones held `graceMs` to finish, and put back whatever still runs. */
    stop: async ({ graceMs = STOP_GRACE_MS }: { graceMs?: number } = {}) => {
      stopped = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled(loops), new Promise((r) => (timer = setTimeout(r, graceMs)))]);
      clearTimeout(timer);
      await app.db.query("UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, attempts = GREATEST(attempts - 1, 0), run_at = now() WHERE status = 'running' AND locked_by = $1", [boot]).catch(() => {});
    },
  };
}
