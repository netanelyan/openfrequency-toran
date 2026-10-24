import type { App } from '../app.ts';
import { J } from '../db/index.ts';
import { audit, event } from '../db/log.ts';
import { seal, open } from '../core/secrets.ts';
import { accountState, exchangeCode, phoneInfo, subscribeApp, unsubscribeApp, waConnectReady, type Echo, type PhoneInfo, type Status } from './meta.ts';
import { PAUSE_HOURS } from './owner.ts';

// A store's own WhatsApp number, connected through Meta (meta.ts), as a row of channel_accounts:
//
//   channel 'whatsapp', kind 'meta', external_id the number's Meta id (phone_number_id), secret the store's token
//   sealed (core/secrets.ts), status pending | active | error | off, meta { waba_id, display_phone_number,
//   verified_name, phone_status, why, checked_at, event }
//
// connectWhatsapp() is the end of Embedded Signup: the code becomes the token, Meta is asked to send the number's
// messages here, and the number's state decides the row's status. A pending number is read again by the worker
// (checkAccount, every ten minutes) and turns itself on when Meta says CONNECTED; a message arriving on it does the
// same. Only coexistence is accepted: the number the store already has on the WhatsApp Business app, which keeps
// working on the owner's phone. ownerEcho() is that phone: a message the owner sends from the app is the owner
// answering, so it lands in the inbox and the agent steps back, as when they answer from the dashboard.

export class ConnectError extends Error {
  he: string;
  constructor(message: string, he: string) {
    super(message);
    this.he = he;
  }
}

const COEXISTENCE = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

export type ConnectInput = { code: string; phoneId: string; wabaId: string; event: string; by: string };

export async function connectWhatsapp(app: App, storeId: number, input: ConnectInput) {
  if (!waConnectReady(app.env)) throw new ConnectError('the Meta settings or TORAN_SECRETS_KEY are missing', 'החיבור לוואטסאפ עוד לא פתוח בשרת. כתבו לנו ונחבר יחד.');
  const phoneId = digits(input.phoneId);
  const wabaId = digits(input.wabaId);
  const code = String(input.code || '').trim();
  if (!code || !phoneId || !wabaId) throw new ConnectError('the signup gave no code or ids', 'Meta לא החזירה את פרטי החיבור. אפשר לנסות שוב.');
  if (input.event !== COEXISTENCE) throw new ConnectError(`not a coexistence onboarding (${input.event})`, 'צריך לבחור בחלון של Meta לחבר את המספר שכבר פעיל באפליקציית WhatsApp Business. ככה הוואטסאפ ממשיך לעבוד גם בטלפון.');
  const taken = await app.db.one<{ store_id: number }>("SELECT store_id FROM channel_accounts WHERE channel = 'whatsapp' AND external_id = $1", [phoneId]);
  if (taken && taken.store_id !== storeId) throw new ConnectError(`phone ${phoneId} belongs to store ${taken.store_id}`, 'המספר הזה כבר מחובר לחנות אחרת.');

  const token = await exchangeCode(app.env, app.graph, code);
  await subscribeApp(app.env, app.graph, wabaId, token);
  const info = await phoneInfo(app.env, app.graph, phoneId, token);
  const state = accountState(info);
  const meta = { waba_id: wabaId, display_phone_number: digits(info.display_phone_number) || null, verified_name: info.verified_name || null, phone_status: info.status || null, why: state.why, checked_at: new Date().toISOString(), event: input.event };
  const row = await app.db.one<{ id: number }>(
    `INSERT INTO channel_accounts (store_id, channel, kind, external_id, name, secret, status, meta) VALUES ($1, 'whatsapp', 'meta', $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (channel, external_id) DO UPDATE SET kind = 'meta', name = EXCLUDED.name, secret = EXCLUDED.secret, status = EXCLUDED.status, meta = EXCLUDED.meta, connected_at = now()
     RETURNING id`,
    [storeId, phoneId, info.verified_name || null, seal(app.env, token), state.status, J(meta)],
  );
  await audit(app.db, { actor: input.by, action: 'whatsapp_connect', storeId, detail: { phoneId, wabaId, status: state.status } });
  await event(app.db, storeId, state.status === 'active' ? 'wa_connected' : 'wa_pending', { accountId: row!.id, phone: meta.display_phone_number });
  return { accountId: row!.id, status: state.status, phone: meta.display_phone_number };
}

/** Read a number's state from Meta again, and turn it on (or off) when it changed. */
export async function checkAccount(app: App, accountId: number) {
  const a = await app.db.one<any>("SELECT id, store_id, external_id, secret, status, meta FROM channel_accounts WHERE id = $1 AND channel = 'whatsapp' AND kind = 'meta'", [accountId]);
  if (!a || a.status === 'off' || !a.secret) return { status: a?.status || 'missing' };
  let info: PhoneInfo;
  try {
    info = await phoneInfo(app.env, app.graph, a.external_id, open(app.env, a.secret));
  } catch (e: any) {
    await app.db.query("UPDATE channel_accounts SET meta = meta || $2::jsonb WHERE id = $1", [a.id, J({ checked_at: new Date().toISOString(), check_error: String(e?.message || e).slice(0, 200) })]);
    return { status: a.status, error: String(e?.message || e) };
  }
  const state = accountState(info);
  await app.db.query('UPDATE channel_accounts SET status = $2, name = COALESCE($3, name), meta = meta || $4::jsonb WHERE id = $1', [a.id, state.status, info.verified_name || null, J({ phone_status: info.status || null, why: state.why, display_phone_number: digits(info.display_phone_number) || a.meta?.display_phone_number || null, checked_at: new Date().toISOString(), check_error: null })]);
  if (state.status !== a.status) await event(app.db, a.store_id, state.status === 'active' ? 'wa_connected' : state.status === 'error' ? 'wa_error' : 'wa_pending', { accountId: a.id, why: state.why });
  return { status: state.status };
}

/** A message arrived on a number still marked pending: Meta is delivering, so it is on. */
export async function markLive(app: App, accountId: number, storeId: number) {
  const r = await app.db.query("UPDATE channel_accounts SET status = 'active', meta = meta || $2::jsonb WHERE id = $1 AND status = 'pending' RETURNING id", [accountId, J({ why: null, live_by: 'message' })]);
  if (r.length) await event(app.db, storeId, 'wa_connected', { accountId, by: 'message' });
}

export async function disconnectWhatsapp(app: App, storeId: number, by: string) {
  const a = await app.db.one<any>("SELECT id, secret, meta FROM channel_accounts WHERE store_id = $1 AND channel = 'whatsapp' AND kind = 'meta' AND status <> 'off' ORDER BY id DESC LIMIT 1", [storeId]);
  if (!a) return false;
  // Meta stops sending us the number's messages; the number itself stays on the owner's phone, untouched.
  if (a.secret && a.meta?.waba_id) {
    try {
      await unsubscribeApp(app.env, app.graph, a.meta.waba_id, open(app.env, a.secret));
    } catch (e: any) {
      app.log(`[wa] unsubscribe of account ${a.id} failed (it is off here anyway): ${e?.message || e}`);
    }
  }
  await app.db.query("UPDATE channel_accounts SET status = 'off', secret = NULL WHERE id = $1", [a.id]);
  await audit(app.db, { actor: by, action: 'whatsapp_disconnect', storeId, detail: { accountId: a.id } });
  await event(app.db, storeId, 'wa_disconnected', { accountId: a.id });
  return true;
}

/** The owner wrote to a customer from the WhatsApp Business app: their answer, in the inbox, and Toran steps back. */
export async function ownerEcho(app: App, echo: Echo) {
  const a = await app.db.one<{ id: number; store_id: number }>("SELECT id, store_id FROM channel_accounts WHERE channel = 'whatsapp' AND external_id = $1 AND status IN ('active', 'pending')", [echo.account]);
  if (!a) return { action: 'unknown_account' };
  // Meta reports our own API sends as delivery statuses, not echoes; this guards against one arriving as both.
  if (await app.db.one('SELECT 1 FROM messages WHERE ext_id = $1 OR delivery @> $2::jsonb', [`echo:${echo.id}`, J([echo.id])])) return { action: 'duplicate' };
  let c = await app.db.one<{ id: number }>("SELECT id FROM conversations WHERE account_id = $1 AND peer = $2 AND last_at > now() - interval '7 days' AND closed_at IS NULL ORDER BY last_at DESC LIMIT 1", [a.id, echo.to]);
  c ??= await app.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer, account_id) VALUES ($1, 'whatsapp', $2, $3) RETURNING id", [a.store_id, echo.to, a.id]);
  await app.db.query("INSERT INTO messages (conversation_id, role, text, author, ext_id) VALUES ($1, 'owner', $2, 'מהטלפון', $3)", [c!.id, echo.text || '(קובץ)', `echo:${echo.id}`]);
  await app.db.query(`UPDATE conversations SET last_at = now(), agent_paused_until = now() + interval '${PAUSE_HOURS} hours' WHERE id = $1`, [c!.id]);
  await event(app.db, a.store_id, 'owner_reply', { conversationId: c!.id, via: 'phone' });
  return { action: 'owner_echo', conversationId: c!.id };
}

/** A delivery report: only a failure is kept, with Meta's reason, so a reply that never arrived is visible. */
export async function deliveryStatus(app: App, s: Status) {
  if (s.status !== 'failed') return;
  const a = await app.db.one<{ store_id: number }>("SELECT store_id FROM channel_accounts WHERE channel = 'whatsapp' AND external_id = $1", [s.account]);
  await event(app.db, a?.store_id ?? null, 'wa_failed', { id: s.id, error: s.error });
}
