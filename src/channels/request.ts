import type { App } from '../app.ts';
import { event } from '../db/log.ts';
import { enqueue } from '../jobs/queue.ts';
import type { RouteResult } from './demo.ts';
import { reply } from './send.ts';
import type { ChannelAdapter, Inbound } from './types.ts';

// A demo asked for on openfrequency.co.il. The form takes only the store's address; its button then opens WhatsApp
// to the demo number with a message holding the request's code (REQ-XXXXXX). That message is the proof: the number it
// came from is the person's own, so the store is added for that number, and one number gets one demo. Until it
// arrives the request is a row in demo_requests and nothing is fetched or built.
//
// demoNumber (demo.ts) asks here first; a message with no REQ- code is not ours, and goes on to the DEMO-XXXX codes
// and the bindings as before. The owner's own phone (TORAN_OWNER_WHATSAPP) may ask any number of times.

export const REQ_RE = /\bREQ-([A-Z0-9]{6})\b/i;

const msg = {
  requested: (domain: string) => `קיבלנו, תודה. אנחנו בונים עכשיו דמו של תורן ל־${domain}, ונשלח לכם לכאן את הלינק כשהוא מוכן.`,
  already: 'כבר קיבלנו מהמספר הזה בקשה לדמו, והיא אצלנו. נשלח לכם לכאן את הלינק כשהדמו מוכן.',
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

  const req = await db.one<{ id: number; url: string; domain: string; phone: string | null }>('SELECT id, url, domain, phone FROM demo_requests WHERE code = $1', [code]);
  // A code nobody gave out, or one another number already used.
  if (!req || (req.phone && req.phone !== phone)) {
    await event(db, null, 'request_bad_code', { code });
    return say(msg.unknown, 'bad_code');
  }
  if (req.phone === phone) return say(msg.already, 'already_requested');
  if (!ownerPhones(app.env).has(phone) && (await db.one('SELECT 1 FROM demo_requests WHERE phone = $1', [phone]))) {
    await event(db, null, 'request_again', { code });
    return say(msg.already, 'already_requested');
  }

  // Claimed only if nobody claimed it a moment ago.
  const claimed = await db.one('UPDATE demo_requests SET phone = $2, claimed_at = now() WHERE id = $1 AND phone IS NULL RETURNING id', [req.id, phone]);
  if (!claimed) return say(msg.unknown, 'bad_code');
  const store = await db.one<{ id: number }>('SELECT id FROM stores WHERE domain = $1', [req.domain]);
  if (store) {
    // Toran has the store already: it keeps its page, and this is the number to send it to.
    await db.query('UPDATE stores SET contact_whatsapp = $2 WHERE id = $1', [store.id, phone]);
    await db.query('UPDATE demo_requests SET store_id = $2 WHERE id = $1', [req.id, store.id]);
  } else {
    await enqueue(db, 'add_store', { url: req.url, by: 'website', whatsapp: phone }, { dedupeKey: `add:${req.domain}`, maxAttempts: 1 });
  }
  await event(db, store?.id ?? null, 'demo_requested', { code, domain: req.domain });
  return say(msg.requested(req.domain), 'requested', store?.id ?? null);
}
