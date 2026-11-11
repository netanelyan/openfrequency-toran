import type { App } from '../app.ts';
import { prefixed } from '../core/hebrew.ts';
import { isIsraeliMobile } from '../core/urls.ts';
import { event } from '../db/log.ts';
import { canIngest, INGESTIBLE_HE } from '../ingest/catalogue.ts';
import { enqueue } from '../jobs/queue.ts';
import { tederLead } from '../ops/sources.ts';
import type { RouteResult } from './demo.ts';
import { demoLine } from './lines.ts';
import { reply } from './send.ts';
import type { ChannelAdapter, Inbound } from './types.ts';

// A demo asked for on openfrequency.co.il, of Toran or of Teder. The form takes only the store's address; its button
// then opens WhatsApp to the demo number with a message holding the request's code (REQ-XXXXXX). That message is the
// proof: the number it came from is the person's own, and one number gets one demo of each product. Until it arrives
// the request is a row in demo_requests and nothing is fetched or built.
//
//   Toran  the store is added for that number (the worker's add_store), and its page's link goes to it once ready
//          (ops/actions.ts deliverRequested). A site Toran cannot build a demo from (no store found there, a platform
//          it does not read, a reading that failed) is said to the number instead, once (unbuildableRequests): before
//          2026-11-12 the number was told "אנחנו בונים עכשיו דמו" and then heard nothing (that day's audit, P1-22)
//   Teder  the request is handed to Teder (its POST /internal/lead, the worker's teder_lead job, tried again while
//          Teder does not answer), which builds the store's demo, one per store; its link goes to the number once
//          Teder has it up (ops/actions.ts deliverTeder)
//
// demoNumber (demo.ts) asks here first; a message with no REQ- code is not ours, and goes on to the DEMO-XXXX codes
// and the bindings as before. The owner's own phone (TORAN_OWNER_WHATSAPP) may ask any number of times.

export const REQ_RE = /\bREQ-([A-Z0-9]{6})\b/i;

export type Product = 'toran' | 'teder';
export const PRODUCT_HE: Record<Product, string> = { toran: 'תורן', teder: 'תדר' };

/** The word to a number whose Toran demo cannot be built from its site: what Toran reads, and the way to us. */
export const cannotBuild = (domain: string) => `לא הצלחנו לבנות דמו מהאתר ${domain}. כרגע תורן קורא חנויות ${prefixed('ב', INGESTIBLE_HE)}. אם החנות בנויה על משהו אחר, כתבו לנו כאן ונבדוק.`;

const msg = {
  requested: (product: Product, domain: string) => `קיבלנו, תודה. אנחנו בונים עכשיו דמו של ${PRODUCT_HE[product]} ל־${domain}, ונשלח לכם לכאן את הלינק כשהוא מוכן.`,
  already: (product: Product) => `כבר קיבלנו מהמספר הזה בקשה לדמו של ${PRODUCT_HE[product]}, והיא אצלנו. נשלח לכם לכאן את הלינק כשהדמו מוכן.`,
  unknown: 'את הקוד הזה אנחנו לא מכירים. אפשר למלא שוב את הטופס באתר, והוא ישלח לכאן קוד חדש.',
};

const ownerPhones = (env: Record<string, string | undefined>) => new Set(String(env.TORAN_OWNER_WHATSAPP || '').split(/[,\s]+/).map((p) => p.replace(/\D/g, '')).filter(Boolean));

export async function claimRequest(app: App, adapter: ChannelAdapter, inbound: Inbound): Promise<RouteResult | null> {
  const m = REQ_RE.exec(String(inbound.text || ''));
  if (!m) return null;
  const { db } = app;
  const code = `REQ-${m[1].toUpperCase()}`;
  const phone = inbound.from;
  const say = async (text: string, action: RouteResult['action'], storeId: number | null = null): Promise<RouteResult> => {
    await reply(app, adapter, inbound, text, storeId, null);
    return { action, ...(storeId ? { storeId } : {}), reply: text };
  };

  const req = await db.one<{ id: number; url: string; domain: string; phone: string | null; product: Product }>('SELECT id, url, domain, phone, product FROM demo_requests WHERE code = $1', [code]);
  // A code nobody gave out, or one another number already used.
  if (!req || (req.phone && req.phone !== phone)) {
    await event(db, null, 'request_bad_code', { code });
    return say(msg.unknown, 'bad_code');
  }
  const product: Product = req.product === 'teder' ? 'teder' : 'toran';
  if (req.phone === phone) return say(msg.already(product), 'already_requested');
  // One demo of each product per number: a number that had Toran's may still ask for Teder's, and the other way.
  if (!ownerPhones(app.env).has(phone) && (await db.one('SELECT 1 FROM demo_requests WHERE phone = $1 AND product = $2', [phone, product]))) {
    await event(db, null, 'request_again', { code, product });
    return say(msg.already(product), 'already_requested');
  }

  // Claimed only if nobody claimed it a moment ago.
  const claimed = await db.one('UPDATE demo_requests SET phone = $2, claimed_at = now() WHERE id = $1 AND phone IS NULL RETURNING id', [req.id, phone]);
  if (!claimed) return say(msg.unknown, 'bad_code');
  if (product === 'teder') {
    // Teder builds it: the request goes to Teder from the queue, so a Teder that is down for a while loses nothing.
    await enqueue(db, 'teder_lead', { requestId: req.id }, { dedupeKey: `teder_lead:${req.id}`, maxAttempts: 8 });
    await event(db, null, 'demo_requested', { code, domain: req.domain, product });
    return say(msg.requested(product, req.domain), 'requested');
  }
  const store = await db.one<{ id: number; platform: string | null; page_built_at: string | null }>('SELECT id, platform, page_built_at FROM stores WHERE domain = $1', [req.domain]);
  if (store) {
    // Toran has the store already: it keeps its page, and this is the number to send it to.
    await db.query('UPDATE stores SET contact_whatsapp = $2 WHERE id = $1', [store.id, phone]);
    await db.query('UPDATE demo_requests SET store_id = $2 WHERE id = $1', [req.id, store.id]);
  } else {
    await enqueue(db, 'add_store', { url: req.url, by: 'website', whatsapp: phone }, { dedupeKey: `add:${req.domain}`, maxAttempts: 1 });
  }
  await event(db, store?.id ?? null, 'demo_requested', { code, domain: req.domain, product });
  // A store Toran has, on a platform it does not read and with no page: no demo is coming, so that is the answer now,
  // said once (unbuildableRequests does not say it again), never a promise of a link.
  if (store && !store.page_built_at && !canIngest(store.platform)) {
    await db.query('UPDATE demo_requests SET delivered_at = now() WHERE id = $1', [req.id]);
    await event(db, store.id, 'demo_unbuildable', { code, domain: req.domain, why: 'platform', at: 'claim' });
    return say(cannotBuild(req.domain), 'requested', store.id);
  }
  return say(msg.requested(product, req.domain), 'requested', store?.id ?? null);
}

/** A Toran request's demo is coming (null), or why it cannot be: no store found, a platform Toran does not read, a failed reading. */
async function whyNoDemo(app: App, r: { domain: string; claimed_at: string }): Promise<'platform' | 'failed' | null> {
  const store = await app.db.one<{ id: number; platform: string | null }>('SELECT id, platform FROM stores WHERE domain = $1', [r.domain]);
  if (store && !canIngest(store.platform)) return 'platform';
  // The jobs that build it: the add from this request (add_store, `add:<domain>`), and a reading of the store's site
  // (ingest or rescrape, `ingest:<id>`), each one that ran for this request or still runs. An older failure is not this
  // request's.
  const keys = [`add:${r.domain}`, ...(store ? [`ingest:${store.id}`] : [])];
  const jobs = await app.db.query<{ kind: string; status: string; result: any }>(
    "SELECT kind, status, result FROM jobs WHERE dedupe_key = ANY($1::text[]) AND (status IN ('queued', 'running') OR created_at >= $2 OR done_at >= $2) ORDER BY id DESC",
    [keys, r.claimed_at],
  );
  if (!jobs.length || jobs.some((j) => j.status === 'queued' || j.status === 'running')) return null;
  if (jobs[0].status === 'failed') return 'failed';
  if (jobs[0].kind === 'add_store' && jobs[0].result?.ingested === false) return 'platform';
  return null;
}

/**
 * A Toran demo asked for on the website whose site Toran cannot build one from: the number that asked is told so, once,
 * on the demo number, as its link would have gone (ops/actions.ts deliverRequested): inside the 23 hours after it wrote
 * (Meta's window), and only while our number is connected (demoLine). delivered_at, the column a Teder request's link
 * uses (a Toran link is the store's sent_at), marks it told: set before the send, given back if the send did not go,
 * so the next minute's pass tries again. The worker's schedule runs this each minute, so the word goes within a minute
 * of the build's end. A request still building, or one whose store waits for the operator, is left alone.
 */
export async function unbuildableRequests(app: App): Promise<number> {
  const open = await app.db.query<{ id: number; code: string; phone: string; claimed_at: string; domain: string }>(
    `SELECT r.id, r.code, r.phone, r.claimed_at, r.domain FROM demo_requests r
      WHERE r.product = 'toran' AND r.phone IS NOT NULL AND r.delivered_at IS NULL AND r.claimed_at > now() - interval '23 hours'
        AND NOT EXISTS (SELECT 1 FROM stores s WHERE s.domain = r.domain AND s.page_built_at IS NOT NULL)
      ORDER BY r.claimed_at LIMIT 50`,
  );
  if (!open.length) return 0;
  const line = await demoLine(app);
  if (!line.live) return 0;
  let n = 0;
  for (const r of open) {
    const why = await whyNoDemo(app, r);
    if (!why) continue;
    if (!(await app.db.one('UPDATE demo_requests SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL RETURNING id', [r.id]))) continue;
    try {
      const out = await reply(app, line.wa, { from: r.phone, text: '', id: `req-${r.code}`, at: new Date(r.claimed_at).getTime(), channel: 'whatsapp' }, cannotBuild(r.domain), null, null);
      if (!out.ok) throw new Error(out.reason);
    } catch (e: any) {
      await app.db.query('UPDATE demo_requests SET delivered_at = NULL WHERE id = $1', [r.id]);
      app.log(`[request] the word that ${r.domain} cannot be built did not go to ${r.code}: ${e?.message || e}`);
      continue;
    }
    await event(app.db, null, 'demo_unbuildable', { code: r.code, domain: r.domain, why });
    n++;
  }
  return n;
}

/**
 * The worker's teder_lead job: a claimed Teder request, handed to Teder with the number that wrote. Teder answers with
 * its demo for that store, a new one or the one it has (it keeps one per store), kept as the request's teder_id. Throws
 * while Teder does not take it, so the job is tried again; a request already handed over, or gone, is left as it is.
 */
export async function handToTeder(app: App, requestId: number): Promise<unknown> {
  const r = await app.db.one<{ id: number; code: string; url: string; phone: string; teder_id: string | null }>("SELECT id, code, url, phone, teder_id FROM demo_requests WHERE id = $1 AND product = 'teder' AND phone IS NOT NULL", [requestId]);
  if (!r) return { gone: true };
  if (r.teder_id) return { tederId: r.teder_id };
  // Teder takes an Israeli mobile only (its /^9725\d{8}$/): any other number would be refused every time.
  if (!isIsraeliMobile(r.phone)) throw new Error('the number is not an Israeli mobile, and Teder takes no other');
  const out = await tederLead(app, { url: r.url, whatsapp: r.phone });
  if (!out.ok) throw new Error(`Teder did not take the request: ${out.why}`);
  await app.db.query('UPDATE demo_requests SET teder_id = $2 WHERE id = $1', [r.id, out.id]);
  await event(app.db, null, 'teder_lead', { code: r.code, tederId: out.id, existing: out.existing });
  return { tederId: out.id, existing: out.existing };
}
