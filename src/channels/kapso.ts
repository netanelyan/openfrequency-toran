import { createHmac, timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import { J } from '../db/index.ts';
import { audit, event } from '../db/log.ts';
import { isCompany } from '../company.ts';
import { lineNumber, lineOf, oneNumber, withOne } from './lines.ts';
import { GraphError, waConnectReady } from './meta.ts';
import { OURS_HE } from './waStore.ts';
import { alertOperator } from '../ops/alert.ts';
import { zernioWaReady } from './zernio.ts';

// A store's own WhatsApp number through Kapso (docs.kapso.ai), while our own Meta app waits for its review (the owner,
// 2026-11-08: "i cant wait for the meta app approval ... lets build toran around that, make it live"). Kapso's Meta app
// holds the connection, so nothing of ours needs Meta's approval. TORAN_WA_PROVIDER=kapso turns it on for every store;
// our own number (lines.ts: the demo, support, the owner line, the alerts, the pitches) stays on Meta directly.
//
//   connecting   the store's WhatsApp page makes the store a Kapso "customer" once (kapso_customers, migration 049),
//                then a setup link (POST /platform/v1/customers/<id>/setup_links: the WhatsApp Business app's number
//                kept on the phone, coexistence, or a dedicated one; Meta's fees billed to the store, customer_managed,
//                unless KAPSO_META_BILLING says partner_managed), and sends the store to Kapso's hosted page. Kapso comes
//                back to /lead/<id>/whatsapp/kapso?phone_number_id=..., and the number is taken only when Kapso's own
//                API says it belongs to this store's customer (the query is not signed). The project webhook's
//                whatsapp.phone_number.created (/kapso/events) does the same for a store that closed the tab first.
//   receiving    on connect, Toran registers a Meta-format webhook for the number (kind meta: "the exact payload Meta
//                sends", signed with X-Webhook-Signature, an HMAC-SHA256 hex of the raw body under KAPSO_WEBHOOK_SECRET),
//                at /kapso/webhook: meta.ts parseWebhook reads it as it reads Meta's own, so customers' messages, the
//                owner's answers from the phone, delivery reports and template news take the same way as /meta/webhook.
//                Only numbers connected through Kapso are taken from it.
//   sending      the same Cloud API bodies through Kapso's Meta proxy (https://api.kapso.ai/meta/whatsapp/v24.0) with
//                our project's key in X-API-Key (meta.ts kapsoProxy, credOf): replies, the store's templates.
//   leaving      "לנתק" deletes the number from our Kapso project; the WhatsApp Business app on the phone stays.
//
// docs/connecting-channels.md, "A store's number through Kapso", has each fact with the page of Kapso's docs it is from.

type Env = Record<string, string | undefined>;

export const kapsoSettings = (env: Env) => ({
  apiKey: String(env.KAPSO_API_KEY || '').trim(),
  webhookSecret: String(env.KAPSO_WEBHOOK_SECRET || '').trim(),
  eventsSecret: String(env.KAPSO_EVENTS_SECRET || '').trim(),
  base: String(env.KAPSO_BASE_URL || '').trim().replace(/\/+$/, '') || 'https://api.kapso.ai',
  billing: String(env.KAPSO_META_BILLING || '').trim() === 'partner_managed' ? 'partner_managed' : 'customer_managed',
  publicBase: String(env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
});

/**
 * Which way a store's own number is connected here: through Zernio (zernio.ts; the owner, 2026-11-08: "yes, switch to
 * zernio"), through Kapso, or Meta's Embedded Signup with our own app. Unset: Meta.
 */
export const waProvider = (env: Env): 'zernio' | 'kapso' | 'meta' => {
  const v = String(env.TORAN_WA_PROVIDER || '').trim().toLowerCase();
  return v === 'zernio' ? 'zernio' : v === 'kapso' ? 'kapso' : 'meta';
};

/** May a store connect through Kapso now: our key, the webhook's secret, and an https address for Kapso to come back to. */
export function kapsoReady(env: Env): boolean {
  const k = kapsoSettings(env);
  return Boolean(k.apiKey && k.webhookSecret.length >= 16 && k.publicBase.startsWith('https://'));
}

/** May a store connect its own WhatsApp on this server, the way TORAN_WA_PROVIDER says. Our company store is always Meta's. */
export const storeConnectReady = (env: Env, company = false): boolean => {
  if (company) return waConnectReady(env);
  const p = waProvider(env);
  return p === 'zernio' ? zernioWaReady(env) : p === 'kapso' ? kapsoReady(env) : waConnectReady(env);
};

/** A refusal said to the store, in Hebrew, beside the reason for the log. */
export class KapsoError extends Error {
  he: string;
  constructor(message: string, he: string) {
    super(message);
    this.he = he;
  }
}

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** Kapso's Platform API (https://api.kapso.ai/platform/v1), with our project's key. A refusal is a GraphError, as Meta's. */
async function platform(app: App, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<any> {
  const k = kapsoSettings(app.env);
  if (!k.apiKey) throw new GraphError('KAPSO_API_KEY is not set', 0, null);
  const res = await app.graph(`${k.base}/platform/v1/${path.replace(/^\//, '')}`, {
    method,
    headers: { 'x-api-key': k.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 204) return {};
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = typeof out?.error === 'string' ? out.error : out?.error?.message || out?.message || JSON.stringify(out?.errors || '').slice(0, 200);
    throw new GraphError(`Kapso refused ${method} /platform/v1/${path} (${res.status}): ${String(why || '').slice(0, 200)}`, res.status, null);
  }
  return out;
}

/** The HMAC-SHA256 hex of the raw body under a secret, as Kapso signs each webhook (X-Webhook-Signature). */
export const kapsoSign = (secret: string, raw: string) => createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('hex');

export function kapsoSignatureOk(secret: string, raw: string, header: unknown): boolean {
  if (!secret || typeof header !== 'string' || !header) return false;
  const a = Buffer.from(kapsoSign(secret, raw), 'utf8');
  const b = Buffer.from(header.trim(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- connecting

/** The store's Kapso customer, made the first time. */
async function customerOf(app: App, storeId: number, name: string): Promise<string> {
  const had = await app.db.one<{ customer_id: string }>('SELECT customer_id FROM kapso_customers WHERE store_id = $1', [storeId]);
  if (had) return had.customer_id;
  const out = await platform(app, 'POST', 'customers', { customer: { name: name.slice(0, 120) || `store ${storeId}`, external_customer_id: `toran-store-${storeId}` } });
  const id = String(out?.data?.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new GraphError('Kapso gave no customer id', 200, null);
  await app.db.query('INSERT INTO kapso_customers (store_id, customer_id) VALUES ($1, $2) ON CONFLICT (store_id) DO NOTHING', [storeId, id]);
  return (await app.db.one<{ customer_id: string }>('SELECT customer_id FROM kapso_customers WHERE store_id = $1', [storeId]))!.customer_id;
}

/** Where Kapso's hosted page is: its links are on app.kapso.ai, and the store is sent nowhere else. */
const LINK = /^https:\/\/app\.kapso\.ai\//;

/**
 * The store pressed "לחבר": its Kapso customer (made once), a new setup link, and the hosted page's address to send the
 * store to. Kapso comes back to /lead/<id>/whatsapp/kapso when the number is connected, or to the page with
 * ?kapso=failed when it was not.
 */
export async function startKapsoConnect(app: App, storeId: number, by: string): Promise<string> {
  if (!kapsoReady(app.env)) throw new KapsoError('KAPSO_API_KEY, KAPSO_WEBHOOK_SECRET or an https PUBLIC_BASE_URL is missing', 'החיבור לוואטסאפ עוד לא פתוח בשרת. כתבו לנו ונחבר יחד.');
  const s = await app.db.one<{ name: string | null; domain: string; platform: string | null }>('SELECT name, domain, platform FROM stores WHERE id = $1', [storeId]);
  if (!s) throw new KapsoError(`no store ${storeId}`, 'אין חנות כזו.');
  // Our own number is on Meta directly, never through Kapso (lines.ts).
  if (isCompany(s)) throw new KapsoError('the company store connects on Meta directly', OURS_HE);
  const k = kapsoSettings(app.env);
  const customer = await customerOf(app, storeId, s.name || s.domain);
  const out = await platform(app, 'POST', `customers/${customer}/setup_links`, {
    setup_link: {
      success_redirect_url: `${k.publicBase}/lead/${storeId}/whatsapp/kapso`,
      failure_redirect_url: `${k.publicBase}/lead/${storeId}/whatsapp?kapso=failed`,
      allowed_connection_types: ['coexistence', 'dedicated'],
      meta_billing_mode: k.billing,
      language: 'en',
    },
  });
  const url = String(out?.data?.url || '');
  if (!LINK.test(url)) throw new GraphError(`Kapso gave a setup link off app.kapso.ai: ${url.slice(0, 80)}`, 200, null);
  await app.db.query('UPDATE kapso_customers SET link_at = now() WHERE store_id = $1', [storeId]);
  await audit(app.db, { actor: by, action: 'whatsapp_kapso_link', storeId, detail: { customer, link: out?.data?.id || null } });
  return url;
}

/** One number of our Kapso project, as its Platform API lists it, or null. */
async function kapsoNumber(app: App, phoneId: string): Promise<any | null> {
  const out = await platform(app, 'GET', `whatsapp/phone_numbers?phone_number_id=${encodeURIComponent(phoneId)}`);
  return (out?.data || []).find((n: any) => digits(n?.phone_number_id || n?.id) === phoneId) || null;
}

/** Kapso's state of a number, as the row's status. */
const stateOf = (n: any): 'active' | 'pending' | 'error' => {
  const st = String(n?.status || '').toUpperCase();
  if (st === 'CONNECTED' || (!st && n?.inbound_processing_enabled !== false)) return 'active';
  if (/BANNED|RESTRICTED|FLAGGED|DISCONNECTED|OFFBOARDED/.test(st)) return 'error';
  return 'pending';
};

/**
 * Toran's Meta-format webhook on a number (kind meta: Meta's own payload, which parseWebhook reads). Kapso allows one
 * per number, inactive ones included, so a number connected again has its receiver pointed here again.
 */
async function ensureWebhook(app: App, phoneId: string) {
  const k = kapsoSettings(app.env);
  const want = { url: `${k.publicBase}/kapso/webhook`, secret_key: k.webhookSecret, active: true };
  const list = await platform(app, 'GET', `whatsapp/phone_numbers/${phoneId}/webhooks?kind=meta`).catch(() => ({ data: [] }));
  const had = (list?.data || []).find((w: any) => w?.kind === 'meta');
  if (had?.id) return platform(app, 'PATCH', `whatsapp/phone_numbers/${phoneId}/webhooks/${had.id}`, { whatsapp_webhook: want });
  return platform(app, 'POST', `whatsapp/phone_numbers/${phoneId}/webhooks`, { whatsapp_webhook: { kind: 'meta', ...want } });
}

/** What Toran keeps of a Kapso number on the store's row. */
const metaOf = (n: any, customer: string) => ({
  provider: 'kapso',
  waba_id: digits(n?.business_account_id) || null,
  display_phone_number: digits(n?.display_phone_number_normalized || n?.display_phone_number) || null,
  verified_name: n?.verified_name || n?.display_name || null,
  connection_type: n?.is_coexistence ? 'coexistence' : 'dedicated',
  kapso_customer_id: customer,
  phone_status: n?.status || null,
  quality_rating: n?.quality_rating || null,
  why: stateOf(n) === 'error' ? String(n?.status || '') : null,
  checked_at: new Date().toISOString(),
});

/**
 * Kapso says a number is connected (its redirect back, or the project webhook): taken for the store only when Kapso's
 * own API lists it under this store's customer, it is none of ours, and no other store has it. Toran's webhook is put
 * on it, and it is the store's WhatsApp from here on.
 */
export async function finishKapsoConnect(app: App, storeId: number, phoneIdIn: unknown, by: string) {
  const phoneId = digits(phoneIdIn);
  if (!phoneId) throw new KapsoError('no phone_number_id came back', 'Kapso לא החזירה את פרטי המספר. אפשר לנסות שוב.');
  const c = await app.db.one<{ customer_id: string }>('SELECT customer_id FROM kapso_customers WHERE store_id = $1', [storeId]);
  if (!c) throw new KapsoError(`store ${storeId} has no Kapso customer`, 'לא התחלנו חיבור לחנות הזו. לוחצים על "לחבר" ומתחילים מחדש.');
  const n = await kapsoNumber(app, phoneId);
  if (!n || String(n.customer_id || '') !== c.customer_id) throw new KapsoError(`number ${phoneId} is not store ${storeId}'s customer's at Kapso`, 'המספר הזה לא חובר דרך החנות שלכם. לוחצים על "לחבר" ומתחילים מחדש.');
  const one = await oneNumber(app);
  const display = digits(n.display_phone_number_normalized || n.display_phone_number);
  const ours = new Set([lineNumber(app.env, 'demo'), lineNumber(app.env, 'owner'), one?.number || null].filter(Boolean));
  if (lineOf(app.env, phoneId, withOne(app.env, one)) || (display && ours.has(display))) throw new KapsoError(`phone ${phoneId} is our own number`, OURS_HE);
  const taken = await app.db.one<{ store_id: number }>("SELECT store_id FROM channel_accounts WHERE channel = 'whatsapp' AND external_id = $1 AND status <> 'off'", [phoneId]);
  if (taken && taken.store_id !== storeId) throw new KapsoError(`phone ${phoneId} belongs to store ${taken.store_id}`, 'המספר הזה כבר מחובר לחנות אחרת.');
  await ensureWebhook(app, phoneId);
  const state = stateOf(n);
  const meta = { ...metaOf(n, c.customer_id), by };
  const row = await app.db.one<{ id: number }>(
    `INSERT INTO channel_accounts (store_id, channel, kind, external_id, name, secret, status, meta) VALUES ($1, 'whatsapp', 'kapso', $2, $3, NULL, $4, $5::jsonb)
     ON CONFLICT (channel, external_id) DO UPDATE SET store_id = EXCLUDED.store_id, kind = 'kapso', name = EXCLUDED.name, secret = NULL, status = EXCLUDED.status, meta = EXCLUDED.meta, connected_at = now(),
       token_issued_at = NULL, token_expires_at = NULL, token_data_until = NULL, token_checked_at = NULL
     RETURNING id`,
    [storeId, phoneId, meta.verified_name, state, J(meta)],
  );
  await audit(app.db, { actor: by, action: 'whatsapp_connect', storeId, detail: { phoneId, via: 'kapso', status: state, connection: meta.connection_type } });
  await event(app.db, storeId, state === 'active' ? 'wa_connected' : 'wa_pending', { accountId: row!.id, phone: meta.display_phone_number, via: 'kapso' });
  return { accountId: row!.id, status: state, phone: meta.display_phone_number };
}

/** Read a Kapso number's state again (the worker, ten minutes apart while it is pending; a Kapso account event). */
export async function checkKapsoAccount(app: App, accountId: number) {
  const a = await app.db.one<any>("SELECT id, store_id, external_id, status, meta FROM channel_accounts WHERE id = $1 AND channel = 'whatsapp' AND kind = 'kapso'", [accountId]);
  if (!a || a.status === 'off') return { status: a?.status || 'missing' };
  let n: any;
  try {
    n = await kapsoNumber(app, a.external_id);
  } catch (e: any) {
    await app.db.query('UPDATE channel_accounts SET meta = meta || $2::jsonb WHERE id = $1', [a.id, J({ checked_at: new Date().toISOString(), check_error: String(e?.message || e).slice(0, 200) })]);
    return { status: a.status, error: String(e?.message || e) };
  }
  // Gone from our project (deleted at Kapso): off here too.
  const status = n ? stateOf(n) : 'off';
  await app.db.query('UPDATE channel_accounts SET status = $2, meta = meta || $3::jsonb WHERE id = $1', [a.id, status, J(n ? { ...metaOf(n, a.meta?.kapso_customer_id), check_error: null } : { checked_at: new Date().toISOString(), why: 'not in the Kapso project' })]);
  if (status !== a.status) await event(app.db, a.store_id, status === 'active' ? 'wa_connected' : status === 'off' ? 'wa_disconnected' : status === 'error' ? 'wa_error' : 'wa_pending', { accountId: a.id, via: 'kapso' });
  return { status };
}

/** "לנתק": the number leaves our Kapso project, and Toran stops answering in it. The app on the phone stays as it is. */
/** `strict` (retention.ts, a stopped store): a delete Kapso refuses throws, and the number stays on here to be tried again. */
export async function disconnectKapso(app: App, storeId: number, by: string, { strict = false }: { strict?: boolean } = {}) {
  const a = await app.db.one<{ id: number; external_id: string }>("SELECT id, external_id FROM channel_accounts WHERE store_id = $1 AND channel = 'whatsapp' AND kind = 'kapso' AND status <> 'off' ORDER BY id DESC LIMIT 1", [storeId]);
  if (!a) return false;
  try {
    await platform(app, 'DELETE', `whatsapp/phone_numbers/${a.external_id}`);
  } catch (e: any) {
    // Already gone at Kapso is what we wanted; anything else is logged, and the number is off here anyway.
    if (!(e instanceof GraphError && e.status === 404)) {
      if (strict) throw e;
      app.log(`[kapso] delete of number ${a.external_id} failed (it is off here anyway): ${e?.message || e}`);
    }
  }
  await app.db.query("UPDATE channel_accounts SET status = 'off' WHERE id = $1", [a.id]);
  await audit(app.db, { actor: by, action: 'whatsapp_disconnect', storeId, detail: { accountId: a.id, via: 'kapso' } });
  await event(app.db, storeId, 'wa_disconnected', { accountId: a.id, via: 'kapso' });
  return true;
}

/** Whether an account row is a number connected through Kapso. */
export async function isKapsoAccount(app: App, accountId: number): Promise<boolean> {
  return Boolean(await app.db.one("SELECT 1 FROM channel_accounts WHERE id = $1 AND kind = 'kapso'", [accountId]));
}

/** Of these Meta phone number ids, the ones connected here through Kapso (the only ones /kapso/webhook may speak for). */
export async function kapsoNumbers(app: App, ids: string[]): Promise<Set<string>> {
  const want = [...new Set(ids.map(digits).filter(Boolean))];
  if (!want.length) return new Set();
  const rows = await app.db.query<{ external_id: string }>("SELECT external_id FROM channel_accounts WHERE channel = 'whatsapp' AND kind = 'kapso' AND external_id = ANY($1::text[])", [want]);
  return new Set(rows.map((r) => r.external_id));
}

/**
 * A project event (/kapso/events, X-Webhook-Event): a number connected through a setup link is taken for the store
 * whose customer it is; one deleted from the project is off; one Meta offboarded or whose access was removed waits to
 * be connected again (status reconnect: the store's page and Today say so); reconnected, it is read again.
 */
export async function kapsoEvent(app: App, name: string, body: any) {
  const phoneId = digits(body?.phone_number_id);
  if (name === 'whatsapp.phone_number.created') {
    const store = await app.db.one<{ store_id: number }>('SELECT store_id FROM kapso_customers WHERE customer_id = $1', [String(body?.customer?.id || '')]);
    if (!store || !phoneId) return { action: 'unknown_customer' };
    try {
      await finishKapsoConnect(app, store.store_id, phoneId, 'Kapso');
      return { action: 'connected', storeId: store.store_id };
    } catch (e: any) {
      app.log(`[kapso] connect from the event for store ${store.store_id} refused: ${e?.message || e}`);
      return { action: 'refused' };
    }
  }
  const a = phoneId ? await app.db.one<{ id: number; store_id: number }>("SELECT id, store_id FROM channel_accounts WHERE channel = 'whatsapp' AND kind = 'kapso' AND external_id = $1 AND status <> 'off'", [phoneId]) : null;
  if (!a) return { action: 'unknown_number' };
  if (name === 'whatsapp.phone_number.deleted') {
    await app.db.query("UPDATE channel_accounts SET status = 'off' WHERE id = $1", [a.id]);
    await event(app.db, a.store_id, 'wa_disconnected', { accountId: a.id, via: 'kapso', by: 'kapso' });
    await alertOperator(app, `kapso_gone:${a.store_id}`, `תורן: הוואטסאפ של חנות ${a.store_id} נמחק ב-Kapso`, 'המספר הוסר מהפרויקט ב-Kapso, ותורן כבר לא עונה בו. אם זה לא היה מכוון, החנות מחברת אותו שוב בדף הוואטסאפ שלה.', { storeId: a.store_id, everyMinutes: 24 * 60 }).catch(() => {});
    return { action: 'off' };
  }
  if (name === 'whatsapp.phone_number.offboarded' || name === 'whatsapp.phone_number.disconnected') {
    await app.db.query("UPDATE channel_accounts SET status = 'reconnect', meta = meta || $2::jsonb WHERE id = $1", [a.id, J({ why: String(body?.disconnection?.reason || body?.source?.event || name).slice(0, 80) })]);
    await event(app.db, a.store_id, 'wa_reconnect', { accountId: a.id, via: 'kapso', why: name });
    await alertOperator(app, `kapso_reconnect:${a.store_id}`, `תורן: הוואטסאפ של חנות ${a.store_id} התנתק`, `Kapso אומר ${name.replace('whatsapp.phone_number.', '')}. תורן לא עונה בו עד שהחנות מחברת שוב בדף הוואטסאפ שלה (היא רואה את זה ב"היום").`, { storeId: a.store_id, everyMinutes: 24 * 60 }).catch(() => {});
    return { action: 'reconnect' };
  }
  if (name === 'whatsapp.phone_number.reconnected') return { action: 'checked', ...(await checkKapsoAccount(app, a.id)) };
  return { action: 'ignored' };
}
