import type { App } from '../app.ts';
import { DAY, now } from '../core/clock.ts';
import { cleanLine } from '../core/hebrew.ts';
import { event } from '../db/log.ts';
import { conversationFor, DEMO_FOOTER, runTurn } from '../agent/loop.ts';
import { CODE_RE } from '../pitch/build.ts';
import { reply } from './send.ts';
import type { ChannelAdapter, Inbound } from './types.ts';

// The demo number: one WhatsApp number for every store's demo (route.ts hands it each message).
//
//   a message with a code (DEMO-XXXX, from a pitch page's button) binds that phone to
//   that store in wa_users for 7 days; a new code overwrites the binding
//   every later message from that phone goes to the bound store's agent
//   a message without a code from a phone with no live binding gets one short reply
//   asking for the demo link, and nothing else
//
// THE RULE: nothing here, or anywhere, sends a message to a phone that did not just
// write. Every send answers the inbound message being handled, through send.ts (the
// 24-hour service window, which costs nothing at Meta and is the only kind of message
// Toran sends).
//
// The owner's own phone (TORAN_OWNER_WHATSAPP) can test any store without moving a
// lead's status. A phone gets at most DAILY_TURNS agent answers a day, so a curious
// visitor cannot run up the bill.

export const BINDING_DAYS = 7;
const DAILY_TURNS = 40;

const msg = {
  welcome: (name: string) => `היי, כאן ${name}. אפשר לשאול על כל מוצר באתר, כמה הוא עולה ואם יש במלאי. מה מחפשים?`,
  noBinding: 'היי, זה מספר הדמו של תורן. כדי להתחיל לוחצים על הכפתור בעמוד שהכנו לחנות, והוא שולח לכאן הודעה עם קוד.',
  badCode: 'את הקוד הזה אנחנו לא מכירים. אפשר ללחוץ שוב על הכפתור בעמוד?',
  expired: `עברו ${BINDING_DAYS} ימים מאז שהדמו הזה התחיל, אז סגרנו אותו. כדי להתחיל מחדש לוחצים שוב על הכפתור בעמוד.`,
  limit: `בדמו אפשר לשאול עד ${DAILY_TURNS} שאלות ביום, והן נגמרו להיום. אפשר להמשיך מחר.`,
  noText: 'בדמו אפשר לשלוח רק טקסט. אפשר לכתוב את השאלה במילים?',
};

export type RouteResult = { action: 'bound' | 'answered' | 'no_binding' | 'bad_code' | 'duplicate' | 'limit' | 'no_text'; storeId?: number; reply?: string };

const ownerPhones = (env: Record<string, string | undefined>) => new Set(String(env.TORAN_OWNER_WHATSAPP || '').split(/[,\s]+/).map((p) => p.replace(/\D/g, '')).filter(Boolean));

/** Store a message the router answered itself (welcome, no binding), so the conversation shows it. */
async function logPair(app: App, conversationId: number, inbound: Inbound, text: string) {
  await app.db.query('INSERT INTO messages (conversation_id, role, text, ext_id) VALUES ($1, $2, $3, $4) ON CONFLICT (ext_id) DO NOTHING', [conversationId, 'customer', inbound.text, inbound.id]);
  await app.db.query('INSERT INTO messages (conversation_id, role, text) VALUES ($1, $2, $3)', [conversationId, 'agent', text]);
  await app.db.query('UPDATE conversations SET last_at = now() WHERE id = $1', [conversationId]);
}

export async function demoNumber(app: App, adapter: ChannelAdapter, inbound: Inbound): Promise<RouteResult> {
  const { db } = app;
  const phone = inbound.from;
  const text = String(inbound.text || '').trim();
  const isOwner = ownerPhones(app.env).has(phone);

  // A code binds (or re-binds) the phone to its store.
  const m = CODE_RE.exec(text);
  if (m) {
    const code = `DEMO-${m[1].toUpperCase()}`;
    const store = await db.one<{ id: number; name: string | null; domain: string; brand: any; status: string }>("SELECT id, name, domain, brand, status FROM stores WHERE demo_code = $1 AND page_built_at IS NOT NULL AND status <> 'skipped' AND taken_down_at IS NULL", [code]);
    if (!store) {
      await reply(app, adapter, inbound, msg.badCode, null, null);
      await event(db, null, 'wa_bad_code', { code });
      return { action: 'bad_code' };
    }
    await db.query(
      `INSERT INTO wa_users (phone, store_id, code, bound_at, expires_at, last_inbound_at) VALUES ($1, $2, $3, now(), now() + ($4 || ' days')::interval, now())
       ON CONFLICT (phone) DO UPDATE SET store_id = EXCLUDED.store_id, code = EXCLUDED.code, bound_at = now(), expires_at = EXCLUDED.expires_at, last_inbound_at = now()`,
      [phone, store.id, code, String(BINDING_DAYS)],
    );
    if (!isOwner) await db.query("UPDATE stores SET demo_started_at = COALESCE(demo_started_at, now()), status = CASE WHEN status IN ('page_ready', 'sent', 'opened') THEN 'demo_started' ELSE status END, updated_at = now() WHERE id = $1", [store.id]);
    await event(db, store.id, 'demo_bound', { owner: isOwner });
    const conv = await conversationFor(db, store.id, 'whatsapp', phone);
    const name = store.brand?.name || store.name || store.domain;
    // The button's message is the code and a greeting; anything more is a question to answer now.
    const rest = text.replace(CODE_RE, '').replace(/^[\s,.!-]*היי,?\s*(?:אני רוצה|באתי) לנסות את (?:העוזר|הבוט|תורן) של .*$/s, '').trim();
    if (!rest) {
      const welcome = `${msg.welcome(name)}\n\n${DEMO_FOOTER}`;
      await logPair(app, conv, inbound, welcome);
      await reply(app, adapter, inbound, welcome, store.id, conv);
      return { action: 'bound', storeId: store.id, reply: welcome };
    }
    const o = await runTurn(app, { storeId: store.id, conversationId: conv, text: rest, extId: inbound.id });
    await reply(app, adapter, inbound, o.reply, store.id, conv);
    return { action: 'bound', storeId: store.id, reply: o.reply };
  }

  const binding = await db.one<{ store_id: number; expired: boolean }>('SELECT store_id, expires_at < now() AS expired FROM wa_users WHERE phone = $1', [phone]);
  if (!binding) {
    await reply(app, adapter, inbound, msg.noBinding, null, null);
    await event(db, null, 'wa_unbound', {});
    return { action: 'no_binding', reply: msg.noBinding };
  }
  if (binding.expired) {
    await reply(app, adapter, inbound, msg.expired, binding.store_id, null);
    return { action: 'no_binding', storeId: binding.store_id, reply: msg.expired };
  }
  await db.query('UPDATE wa_users SET last_inbound_at = now() WHERE phone = $1', [phone]);
  const conv = await conversationFor(db, binding.store_id, 'whatsapp', phone);
  if (!text) {
    await logPair(app, conv, inbound, msg.noText);
    await reply(app, adapter, inbound, msg.noText, binding.store_id, conv);
    return { action: 'no_text', storeId: binding.store_id };
  }
  const today = await db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.peer = $1 AND m.role = 'agent' AND m.at > now() - interval '1 day'", [phone]);
  if (!isOwner && (today?.n || 0) >= DAILY_TURNS) {
    await reply(app, adapter, inbound, msg.limit, binding.store_id, conv);
    return { action: 'limit', storeId: binding.store_id };
  }
  await event(db, binding.store_id, 'wa_in', { conversationId: conv, chars: text.length, preview: cleanLine(text, 60) });
  const o = await runTurn(app, { storeId: binding.store_id, conversationId: conv, text, extId: inbound.id });
  await reply(app, adapter, inbound, o.reply, binding.store_id, conv);
  return { action: 'answered', storeId: binding.store_id, reply: o.reply };
}

export const bindingExpiresIn = (boundAt: number) => boundAt + BINDING_DAYS * DAY - now();
