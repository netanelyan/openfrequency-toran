import type { App } from '../app.ts';
import { cleanLine, prefixed } from '../core/hebrew.ts';
import { ingestStore } from '../ingest/pack.ts';
import { readLooks } from '../ingest/looks.ts';
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
import { watchStores } from '../ops/watch.ts';
import { monthlyReports } from '../owners/reports.ts';
import { rereadCompany, scheduleReread } from './reread.ts';
import { alertOperator } from '../ops/alert.ts';
import { interruptedSends } from '../auto/send.ts';
import { handleTederEvent, handleTederReady } from '../owners/events.ts';
import { deliverRequested, deliverTeder } from '../ops/actions.ts';
import { handToTeder, unbuildableRequests } from '../channels/request.ts';
import { checkAccount, checkToken, deliveryStatus, ownerEcho } from '../channels/waStore.ts';
import { checkKapsoAccount, isKapsoAccount } from '../channels/kapso.ts';
import { refreshInstagram, REFRESH_DAYS, socialEcho } from '../channels/socialStore.ts';
import { finishZernioConnect, zernioEcho } from '../channels/zernio.ts';
import { checkDomain, domainsToCheck } from '../channels/mailDomain.ts';
import { handleHook, pollStore, scheduleAuto, sendDue, setupSource, submitNew } from '../auto/jobs.ts';
import { checkTemplates, templateStatus } from '../auto/templates.ts';
import { waitingDigest } from '../owners/waiting.ts';
import { learnVoice } from '../agent/voice.ts';
import { takeOrderKey } from '../domainProof.ts';

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
//   web_inbound  a message in the chat on a store's own site (channels/web.ts): the same
//   dm_echo      the owner answered from the Page's inbox or the Instagram app (channels/socialStore.ts)
//   zernio_echo  the same, for a Page or account connected through Zernio, unless it is the Page's own instant reply
//                (channels/zernio.ts)
//   zernio_account a Page or Instagram account Zernio says was connected for a store (its account.connected webhook)
//   ig_refresh   an Instagram token's 60 days, renewed before they end
//   mail_domain_check  a store's own mail domain read again at Resend, until it is verified (channels/mailDomain.ts)
//   add_store    "add by URL" from the dashboard, or a demo asked for on the website: detect and score, ingest, build
//                the page. With workspaceId, a customer's own store from /start: the same, the store born in their
//                workspace (never a lead to sell to)
//   ingest       ingest a store again and rebuild its page (after an edit, or by hand)
//   rescrape     the daily refresh of a store whose demo is open
//   looks        after an ingest or a re-scrape: the photos of the products whose photo is new, put into words for the
//                agent's search (ingest/looks.ts)
//   company_reread  our support's daily re-read of the website: its /support.json (TORAN_SUPPORT_EXPORT_URL), synced
//                into the company store when it changed (jobs/reread.ts)
//   teder_lead   a Teder demo asked for on the website, its code just sent from WhatsApp: handed to Teder (its POST
//                /internal/lead, channels/request.ts handToTeder), tried again while Teder does not take it
//   teder_event  Teder's news for a workspace's owners, on the owner line (owners/events.ts); off since 2026-11-02,
//                each job ends with nothing sent
//   teder_ready  the posts waiting for a workspace's approval, as one numbered list, a moment after Teder's post.ready
//                events stop coming; off since 2026-11-02 too
//   auto_setup, auto_hook, auto_poll, auto_send   the automatic messages (cart, payment, shipping, review): a
//                store's webhooks registered, one webhook, a reading of its orders and checkouts, the messages due
//                (auto/jobs.ts)
//   wa_templates, wa_template_status   a store's WhatsApp templates at Meta, read again or as the webhook says
//   wa_templates_new   the new marketing templates (the URL button) for a store whose old ones are approved
//
// Scheduled each minute: a rescrape for every store with a built page that is not
// skipped and was last ingested over 20 hours ago, each at its own offset of up to six hours so the stores' re-scrapes
// do not all start in the same minute; expired WhatsApp bindings cleaned up; the link to each demo asked for on the
// website whose page is now ready, Toran's or Teder's, sent on the demo number, and the word that it cannot be built to
// a number whose site Toran cannot read (channels/request.ts); the automatic messages' readings and
// sends, and any left "sending" by a restart marked as not sent; the operator told when a customer's message has waited
// in the queue over five minutes; and once a day the retention pass (jobs/retention.ts) and, with
// TORAN_SUPPORT_EXPORT_URL set, our support's re-read of the website, which also runs soon after each start
// (jobs/reread.ts).
//
// The loops (startWorker): TORAN_MESSAGE_LOOPS (2) take customers' messages and nothing else, so a re-scrape or an
// ingest never stands between a customer and their answer; TORAN_QUICK_LOOPS (1) take the short jobs someone is waiting
// on (QUICK_KINDS: the owners' email about a waiting customer, Zernio's echoes and connections, Meta's delivery reports,
// a number waiting at Meta, Teder's requests); TORAN_BACKGROUND_LOOPS (1) take everything else. The schedule runs on a
// timer of its own, beside the loops. Before 2026-11-12 the one background loop also ran the schedule, the owners'
// emails and the echoes: one ingest that never ended held all of them, the five-minute queue alert included, while
// /readyz stayed green (that day's audit, P1-26). Each job has a deadline by its kind (deadlineMs): past it the worker
// stops waiting, the job is failed and not tried again by itself (its work may still be running), the operator hears of
// it, and a customer's message goes to the owner as below. A message job that fails its last attempt is not lost: the
// message and a handoff go into its conversation for the owner, and the operator hears of it (jobs/lost.ts). A running
// job's lease is refreshed every minute until its end or its deadline; at start every job another boot left running
// goes back to the queue, and on a stop the loops finish what they hold, for up to STOP_GRACE_MS.

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
      // A number connected through Kapso is read from Kapso, one connected on Meta from Meta (channels/kapso.ts).
      return (await isKapsoAccount(app, Number(p.accountId))) ? checkKapsoAccount(app, Number(p.accountId)) : checkAccount(app, Number(p.accountId));
    case 'wa_token':
      return checkToken(app, Number(p.accountId));
    case 'dm_inbound':
    case 'web_inbound':
      return handleInbound(app, p);
    case 'dm_echo':
      return socialEcho(app, p);
    case 'zernio_echo':
      return zernioEcho(app, p);
    case 'zernio_account':
      return finishZernioConnect(app, Number(p.storeId), p.channel, p.accountId, 'Zernio');
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
      // A customer's store starts switched off (golive.ts): its owner switches Toran on once its channels and answers
      // are ready. One that already answers on a channel of its own is left as it is.
      if (workspaceId) await app.db.query('UPDATE stores SET agent_live_at = NULL, agent_paused_at = NULL WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM channel_accounts a WHERE a.store_id = stores.id)', [store.id]);
      // Asked for on the website: the number that asked is the one to send the page to.
      if (/^9725\d{8}$/.test(String(p.whatsapp || ''))) await app.db.query('UPDATE stores SET contact_whatsapp = $2 WHERE id = $1', [store.id, p.whatsapp]);
      // The site proven with the store's own key (domainProof.ts): the key is the store's order key now, a step done.
      if (workspaceId) await takeOrderKey(app, store.id, p.by || 'owner');
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
    case 'company_reread':
      return rereadCompany(app);
    case 'owner_waiting':
      return waitingDigest(app, Number(p.storeId));
    case 'looks':
      return await readLooks(app, Number(p.storeId));
    case 'ingest':
    case 'rescrape':
      return { storeId: p.storeId, ...(await ingestAndBuild(app, Number(p.storeId), say, job.kind === 'rescrape')) };
    default:
      throw new Error(`unknown job kind ${job.kind}`);
  }
}

async function ingestAndBuild(app: App, storeId: number, say: (l: string) => Promise<void>, rescrape = false) {
  const s = await ingestStore(app, storeId, { progress: (m) => void say(m) });
  // How the store writes, learned again only when its copy changed (agent/voice.ts); never stops the job.
  const voice = await learnVoice(app, storeId).catch(() => 'failed');
  if (voice === 'learned') app.log(`[voice] store ${storeId}: learned from its site`);
  forgetStorePrompt(storeId);
  // A daily re-scrape keeps the sample chat the owner approved; an ingest asked for by hand rebuilds the page.
  const built = await app.db.one('SELECT page_built_at FROM stores WHERE id = $1', [storeId]);
  if (!rescrape || !built?.page_built_at) {
    await say('בונה את דף הדמו ואת שיחת הדוגמה');
    await buildPitch(app, storeId);
  }
  if (rescrape) await event(app.db, storeId, 'rescrape', { products: s.products, gone: s.gone });
  // The photos are read on their own job: the ingest is done, and its page is not waiting on them.
  await enqueue(app.db, 'looks', { storeId }, { dedupeKey: `looks:${storeId}`, maxAttempts: 2 });
  return { products: s.products, policies: s.policies.length, warnings: s.warnings };
}

/** A store's own offset for its daily re-scrape, up to six hours, the same every day. */
export const rescrapeOffsetMs = (storeId: number) => ((Number(storeId) * 2654435761) % 21_600) * 1000;

/** A customer's message waiting this long in the queue is said to the operator. */
export const QUEUE_ALERT_MINUTES = 5;

/** How long one pass of the schedule waits on one of its steps before it goes on to the next (the step keeps running). */
export const STEP_WAIT_MS = 2 * 60_000;
/** A step still running this long after it started is said to the operator, and later passes skip it until it ends. */
export const STEP_ALERT_MINUTES = 15;

/** The schedule's steps running now, by name and since when: per database, so two apps in one process never meet. */
const stepsRunning = new WeakMap<object, Map<string, number>>();

/**
 * One step of the schedule, on its own (P1-26 of the 2026-11-12 audit): one that throws is a log line and the next
 * steps run; one that has not ended after STEP_WAIT_MS is left to finish while the pass goes on, and until it ends the
 * next passes skip it rather than start it twice (a slow send of a demo's link must not go out twice). Before, the
 * steps ran in one line, so any one of them that threw or hung took every step after it along, the five-minute queue
 * alert included.
 */
async function step(app: App, name: string, fn: () => Promise<unknown>): Promise<void> {
  let running = stepsRunning.get(app.db);
  if (!running) stepsRunning.set(app.db, (running = new Map()));
  const since = running.get(name);
  if (since != null) {
    const minutes = (Date.now() - since) / 60_000;
    if (minutes > STEP_ALERT_MINUTES) await alertOperator(app, `schedule_stuck:${name}`, `שלב בתזמון תקוע (${name})`, `השלב ${name} של התזמון רץ כבר ${Math.round(minutes)} דקות. שאר השלבים ממשיכים לרוץ כל דקה, והוא לא יתחיל שוב עד שייגמר. כדאי להסתכל ביומן של תורן.`, { everyMinutes: 60 }).catch(() => {});
    return;
  }
  running.set(name, Date.now());
  const work = Promise.resolve()
    .then(fn)
    .catch((e: any) => app.log(`[schedule] ${name}: ${e?.message || e}`))
    .finally(() => running!.delete(name));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((r) => {
    timer = setTimeout(r, STEP_WAIT_MS);
    timer.unref?.();
  })]);
  clearTimeout(timer);
}

export async function schedule(app: App) {
  // A customer waiting on the queue: first, so nothing the other steps do can hold it back.
  await step(app, 'queue', async () => {
    const old = await app.db.one<{ n: number; at: string | null }>(`SELECT COUNT(*)::int AS n, MIN(run_at) AS at FROM jobs WHERE status = 'queued' AND kind = ANY($1::text[]) AND run_at < now() - interval '${QUEUE_ALERT_MINUTES} minutes'`, [MESSAGE_KINDS]);
    if (old?.n) await alertOperator(app, 'queue_old', 'הודעות של לקוחות מחכות בתור', `${old.n} הודעות מחכות יותר מ-${QUEUE_ALERT_MINUTES} דקות, הוותיקה מ-${old.at}. כדאי לבדוק שה-worker של תורן רץ, ולהסתכל בדף התור.`, { everyMinutes: 30 });
  });
  await step(app, 'rescrape', async () => {
    const due = await app.db.query<{ id: number }>(
      "SELECT id FROM stores WHERE page_built_at IS NOT NULL AND status <> 'skipped' AND platform = ANY($1::text[]) AND (ingested_at IS NULL OR ingested_at < now() - interval '20 hours')",
      [[...INGESTIBLE]],
    );
    for (const s of due) await enqueue(app.db, 'rescrape', { storeId: s.id }, { dedupeKey: `ingest:${s.id}`, runAt: new Date(Date.now() + rescrapeOffsetMs(s.id)) });
  });
  await step(app, 'expired', async () => {
    await app.db.query("DELETE FROM wa_users WHERE expires_at < now() - interval '1 day'");
    await app.db.query('DELETE FROM pay_waits WHERE expires_at < now()'); // a payment's wait for its receipt (channels/pay.ts)
  });
  // A demo asked for on the website whose page is ready: its link, on the demo number (ops/actions.ts). Teder's are
  // read from Teder only while one waits. One whose site Toran cannot read: the number is told so (channels/request.ts).
  await step(app, 'requested', () => deliverRequested(app));
  await step(app, 'teder', () => deliverTeder(app));
  await step(app, 'unbuildable', () => unbuildableRequests(app));
  await step(app, 'whatsapp', async () => {
    // A store's own WhatsApp number waiting at Meta: read again every ten minutes, so it turns on by itself.
    const pending = await app.db.query<{ id: number }>("SELECT id FROM channel_accounts WHERE channel = 'whatsapp' AND kind IN ('meta', 'kapso') AND status = 'pending' AND COALESCE((meta->>'checked_at')::timestamptz, 'epoch') < now() - interval '10 minutes'");
    for (const a of pending) await enqueue(app.db, 'wa_check', { accountId: a.id }, { dedupeKey: `wa_check:${a.id}`, maxAttempts: 1 });
    // A store's WhatsApp token: read once a day, and at once when the end we know of has come.
    const tokens = await app.db.query<{ id: number }>("SELECT id FROM channel_accounts WHERE channel = 'whatsapp' AND kind = 'meta' AND status IN ('active', 'pending') AND secret IS NOT NULL AND (token_checked_at IS NULL OR token_checked_at < now() - interval '1 day' OR token_expires_at <= now())");
    for (const a of tokens) await enqueue(app.db, 'wa_token', { accountId: a.id }, { dedupeKey: `wa_token:${a.id}`, maxAttempts: 1 });
  });
  await step(app, 'instagram', async () => {
    // An Instagram token that ends within REFRESH_DAYS, and was not renewed today: a fresh 60 days.
    const ending = await app.db.query<{ id: number }>(`SELECT id FROM channel_accounts WHERE channel = 'instagram' AND status = 'active' AND (meta->>'expires_at')::timestamptz < now() + interval '${REFRESH_DAYS} days' AND COALESCE((meta->>'refreshed_at')::timestamptz, connected_at) < now() - interval '1 day'`);
    for (const a of ending) await enqueue(app.db, 'ig_refresh', { accountId: a.id }, { dedupeKey: `ig_refresh:${a.id}`, maxAttempts: 3 });
  });
  // A store's own mail domain whose DNS records are not verified yet: read again every ten minutes, for three days.
  if (app.mail) await step(app, 'mail', async () => {
    for (const storeId of await domainsToCheck(app)) await enqueue(app.db, 'mail_domain_check', { storeId }, { dedupeKey: `mail_domain:${storeId}`, maxAttempts: 1 });
  });
  // The automatic messages: each store's reading of its platform when due, the messages whose time has come, and any a
  // restart stopped in the middle of its send.
  await step(app, 'auto', async () => {
    await scheduleAuto(app);
    await interruptedSends(app);
  });
  // Once a day, the retention pass; and our support's re-read of the website, once a day and soon after a start.
  await step(app, 'retention', () => dailyRetention(app));
  // Once a day: a customer store over its plan, or stuck with nothing connected (ops/watch.ts).
  await step(app, 'watch', () => watchStores(app));
  // On the 1st from 09:00: last month's results to each customer store's owners (owners/reports.ts).
  await step(app, 'reports', () => monthlyReports(app));
  await step(app, 'reread', () => scheduleReread(app));
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

/**
 * The short jobs someone is waiting on, on a loop of their own (startWorker), so no ingest stands in front of them: the
 * owners' email about a waiting customer, Zernio's echoes of the owner's own answers and its connections, Meta's
 * delivery reports, a number waiting at Meta, a webhook of a store's orders (it only records), and Teder's requests.
 */
export const QUICK_KINDS = ['owner_waiting', 'zernio_echo', 'zernio_account', 'wa_status', 'wa_check', 'auto_hook', 'teder_lead', 'teder_event', 'teder_ready'];
/** The jobs that read a whole site or catalogue, or many photos: minutes, sometimes tens of them. */
export const LONG_KINDS = ['add_store', 'ingest', 'rescrape', 'looks', 'discover', 'company_reread'];

// The deadlines, in minutes (P1-26 of the 2026-11-12 audit), each well past what the job takes on a slow day:
//   long   40 (TORAN_LONG_JOB_MINUTES): a site is read one page at a time, 1.2 seconds apart per host and up to 20
//          seconds a page (core/http.ts), at most 150 product pages off Shopify (ingest/sitemap.ts), then the chunks are
//          embedded and the demo page's sample chat is written; the photos' looks are up to 50 model calls (ingest/looks.ts)
//   quick   5 (TORAN_QUICK_JOB_MINUTES): a few calls to accounts, Zernio, Meta or Teder, each with a timeout of 3 to
//          15 seconds
//   other  10 (TORAN_JOB_MINUTES): a customer's message (its turn has its own 60 seconds, agent/loop.ts), the automatic
//          messages' sends (at most 50 a run, auto/send.ts), a store's orders read, templates at Meta
export const LONG_JOB_MINUTES = 40;
export const QUICK_JOB_MINUTES = 5;
export const JOB_MINUTES = 10;

/** How long a job of this kind may run before the worker stops waiting for it. */
export function deadlineMs(env: Record<string, string | undefined>, kind: string): number {
  const minutes = (key: string, fallback: number) => (Number(env[key]) > 0 ? Number(env[key]) : fallback);
  const m = LONG_KINDS.includes(kind) ? minutes('TORAN_LONG_JOB_MINUTES', LONG_JOB_MINUTES) : QUICK_KINDS.includes(kind) ? minutes('TORAN_QUICK_JOB_MINUTES', QUICK_JOB_MINUTES) : minutes('TORAN_JOB_MINUTES', JOB_MINUTES);
  return Math.round(m * 60_000);
}

/** A deadline as the operator reads it: "40 דקות", "דקה", "30 שניות". */
const spanHe = (ms: number) => (ms >= 120_000 ? `${Math.round(ms / 60_000)} דקות` : ms >= 60_000 ? 'דקה' : ms >= 1500 ? `${Math.round(ms / 1000)} שניות` : 'שנייה');

export async function runOne(app: App, job: Job, { boot = BOOT, deadline = deadlineMs(app.env, job.kind) }: { boot?: string; deadline?: number } = {}) {
  const heartbeat = setInterval(() => void beat(app.db, job.id, boot).catch(() => {}), BEAT_MS);
  heartbeat.unref?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A query the database cancels for running too long is logged with the job's kind (db/index.ts).
    const run = withDbLabel(`job ${job.kind}`, () => runJob(app, job));
    const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), deadline)));
    const out = await Promise.race([run.then((result) => ({ result }), (error) => ({ error })), late]);
    if (out === 'late') return await pastDeadline(app, job, deadline, run);
    if ('error' in out) throw out.error;
    await done(app.db, job.id, out.result ?? null);
  } catch (e: any) {
    app.log(`[job ${job.id} ${job.kind}] ${cleanLine(e?.stack || e?.message || e, 800)}`);
    // Kapso out of credit refuses every send of every store on it: said to the operator at once (TORAN-READINESS.md P1-25).
    if (/Kapso refused [^(]*\(402|insufficient_credits/.test(String(e?.message || e))) await alertOperator(app, 'kapso_credits', 'תורן: נגמר הקרדיט ב-Kapso', 'Kapso מסרב לשלוח (insufficient_credits), אז הודעות של חנויות בוואטסאפ לא יוצאות. להוסיף קרדיט בלוח של Kapso.', { everyMinutes: 60 }).catch(() => {});
    const last = await fail(app.db, job, String(e?.message || e));
    // A customer's message that failed every attempt: kept in its conversation for the owner, and said to the operator.
    if (last && MESSAGE_KINDS.includes(job.kind)) await lostMessage(app, job, String(e?.message || e)).catch((x) => app.log(`[job ${job.id}] the lost message could not be kept: ${x?.message || x}`));
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
  }
}

/**
 * A job that ran past its deadline: its heartbeat stops (runOne's finally), it is failed with the reason and not tried
 * again by itself, since its work may still be running and a second run beside it would do that work twice (the
 * operator's queue page runs it again). Whatever it does from here changes nothing in the queue: its end, if it ever
 * comes, is a log line. A customer's message goes to the owner as one that failed every attempt does (jobs/lost.ts,
 * which tells the operator); any other job is said to the operator here, once an hour a kind. So a stuck ingest ends as
 * a failed reading, which Today and /start already show, instead of "קוראים את האתר" for good.
 */
async function pastDeadline(app: App, job: Job, deadline: number, run: Promise<unknown>) {
  const why = `ran past its deadline of ${Math.round(deadline / 1000)} seconds and was stopped, not tried again by itself`;
  app.log(`[job ${job.id} ${job.kind}] ${why}`);
  run.then(
    () => app.log(`[job ${job.id} ${job.kind}] ended after its deadline; it stays failed`),
    (e: any) => app.log(`[job ${job.id} ${job.kind}] failed after its deadline: ${cleanLine(e?.message || e, 300)}`),
  );
  await fail(app.db, job, why, { final: true });
  if (MESSAGE_KINDS.includes(job.kind)) {
    await lostMessage(app, job, why, { stuck: true }).catch((x) => app.log(`[job ${job.id}] the lost message could not be kept: ${x?.message || x}`));
    return;
  }
  const storeId = Number(job.payload?.storeId) || null;
  await alertOperator(app, `deadline:${job.kind}`, `עבודה ברקע נתקעה ונעצרה (${job.kind})`, `עבודה ${job.id}${storeId ? ` של חנות ${storeId}` : ''} רצה יותר ${prefixed('מ', spanHe(deadline))}, אז הפסקנו לחכות לה וסימנו שהיא נכשלה. היא לא תרוץ שוב לבד, ואפשר להריץ אותה שוב מדף התור. כדאי להסתכל ביומן של תורן למה היא נתקעה.`, { everyMinutes: 60, storeId }).catch(() => {});
}

/** How long a stop waits for the loops to finish the jobs they hold. */
export const STOP_GRACE_MS = 25_000;
/** The schedule's pace: a pass starts this long after the last one started, or at once when that one took longer. */
export const SCHEDULE_EVERY_MS = 60_000;

type WorkerOpts = { idleMs?: number; messageLoops?: number; quickLoops?: number; backgroundLoops?: number; boot?: string; scheduler?: boolean; scheduleEveryMs?: number; deadline?: (kind: string) => number };

/**
 * The long-running worker: its own loops for customers' messages, for the short jobs someone waits on, and for the rest,
 * and the schedule on its own timer beside them. Two message loops by default, as many loops as the whole worker had
 * before: the server's Toran already sits at its memory cap with two (SERVER-FACTS.md), and what more loops cost has
 * not been measured. Raise TORAN_MESSAGE_LOOPS once it has. The quick loop holds only short jobs, a few calls each.
 */
export function startWorker(app: App, { idleMs = 1000, messageLoops = Number(app.env.TORAN_MESSAGE_LOOPS) || 2, quickLoops = Number(app.env.TORAN_QUICK_LOOPS) || 1, backgroundLoops = Number(app.env.TORAN_BACKGROUND_LOOPS) || 1, boot = BOOT, scheduler = true, scheduleEveryMs = SCHEDULE_EVERY_MS, deadline = (kind: string) => deadlineMs(app.env, kind) }: WorkerOpts = {}) {
  let stopped = false;
  // Ends the schedule's wait for its next pass at once, on a stop.
  let wake: (() => void) | null = null;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Jobs another boot left running are put back first, so a restart costs a customer seconds, not a lease.
  const ready = requeueOrphans(app.db, boot)
    .then((n) => (n ? app.log(`[worker] ${n} job(s) left running by the last boot went back to the queue`) : undefined))
    .catch((e) => app.log(`[worker] could not put back the jobs left running: ${e?.message || e}`));
  const loop = async (take: () => Promise<Job | null>) => {
    await ready;
    while (!stopped) {
      try {
        // A sign of life for /readyz (health.ts): written at most every 30 seconds, whichever loop gets there.
        await workerBeat(app);
        const job = await take();
        if (job) await runOne(app, job, { boot, deadline: deadline(job.kind) });
        else await pause(idleMs);
      } catch (e: any) {
        app.log(`[worker] ${e?.message || e}`);
        await pause(5000);
      }
    }
  };
  // The schedule, on a timer of its own: no job a loop holds can delay it, and its steps cannot hold one another
  // (schedule's step).
  const ticking = async () => {
    await ready;
    while (!stopped) {
      const started = Date.now();
      try {
        await workerBeat(app);
        await schedule(app);
      } catch (e: any) {
        app.log(`[worker] the schedule: ${e?.message || e}`);
      }
      const left = scheduleEveryMs - (Date.now() - started);
      if (left > 0 && !stopped) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, left);
          wake = () => {
            clearTimeout(t);
            r();
          };
        });
      }
      wake = null;
    }
  };
  const elsewhere = [...MESSAGE_KINDS, ...QUICK_KINDS];
  const loops = [
    ...Array.from({ length: Math.max(1, messageLoops) }, () => loop(() => claim(app.db, MESSAGE_KINDS, { boot }))),
    ...Array.from({ length: Math.max(1, quickLoops) }, () => loop(() => claim(app.db, QUICK_KINDS, { boot }))),
    ...Array.from({ length: Math.max(1, backgroundLoops) }, () => loop(() => claim(app.db, null, { except: elsewhere, boot }))),
    ...(scheduler ? [ticking()] : []),
  ];
  return {
    /** Stop taking jobs, give the ones held `graceMs` to finish, and put back whatever still runs. */
    stop: async ({ graceMs = STOP_GRACE_MS }: { graceMs?: number } = {}) => {
      stopped = true;
      wake?.();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled(loops), new Promise((r) => (timer = setTimeout(r, graceMs)))]);
      clearTimeout(timer);
      await app.db.query("UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, attempts = GREATEST(attempts - 1, 0), run_at = now() WHERE status = 'running' AND locked_by = $1", [boot]).catch(() => {});
    },
  };
}
