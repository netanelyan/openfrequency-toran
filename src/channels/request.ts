import type { App } from '../app.ts';
import { isIsraeliMobile } from '../core/urls.ts';
import { event } from '../db/log.ts';
import { enqueue } from '../jobs/queue.ts';
import { tederLead } from '../ops/sources.ts';
import type { RouteResult } from './demo.ts';
import { reply } from './send.ts';
import type { ChannelAdapter, Inbound } from './types.ts';

// A demo asked for on openfrequency.co.il, of Toran or of Teder. The form takes only the store's address; its button
// then opens WhatsApp to the demo number with a message holding the request's code (REQ-XXXXXX). That message is the
// proof: the number it came from is the person's own, and one number gets one demo of each product. Until it arrives
// the request is a row in demo_requests and nothing is fetched or built.
//
//   Toran  the store is added for that number (the worker's add_store), and its page's link goes to it once ready
//          (ops/actions.ts deliverRequested)
//   Teder  the request is handed to Teder (its POST /internal/lead, the worker's teder_lead job, tried again while
//          Teder does not answer), which builds the store's demo, one per store; its link goes to the number once
//          Teder has it up (ops/actions.ts deliverTeder)
//
// demoNumber (demo.ts) asks here first; a message with no REQ- code is not ours, and goes on to the DEMO-XXXX codes
// and the bindings as before. The owner's own phone (TORAN_OWNER_WHATSAPP) may ask any number of times.

export const REQ_RE = /\bREQ-([A-Z0-9]{6})\b/i;

export type Product = 'toran' | 'teder';
export const PRODUCT_HE: Record<Product, string> = { toran: 'תורן', teder: 'תדר' };

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
  const store = await db.one<{ id: number }>('SELECT id FROM stores WHERE domain = $1', [req.domain]);
  if (store) {
    // Toran has the store already: it keeps its page, and this is the number to send it to.
    await db.query('UPDATE stores SET contact_whatsapp = $2 WHERE id = $1', [store.id, phone]);
    await db.query('UPDATE demo_requests SET store_id = $2 WHERE id = $1', [req.id, store.id]);
  } else {
    await enqueue(db, 'add_store', { url: req.url, by: 'website', whatsapp: phone }, { dedupeKey: `add:${req.domain}`, maxAttempts: 1 });
  }
  await event(db, store?.id ?? null, 'demo_requested', { code, domain: req.domain, product });
  return say(msg.requested(product, req.domain), 'requested', store?.id ?? null);
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
