import type { App } from '../app.ts';
import { DAY, now } from '../core/clock.ts';
import { J } from '../db/index.ts';
import { audit, event } from '../db/log.ts';
import { seal, open } from '../core/secrets.ts';
import { ownersOf } from '../owners/identity.ts';
import { accountState, debugToken, exchangeCode, lastingToken, phoneInfo, refreshToken, subscribeApp, unsubscribeApp, waConnectReady, type Echo, type PhoneInfo, type Status, type TokenInfo } from './meta.ts';
import { hold, PAUSE_HOURS } from './owner.ts';
import { lineNumber, lineOf, oneNumber, withOne, type Line } from './lines.ts';
import { isCompany, supportAccount } from '../company.ts';
import { conversationOf, handOver, type Account } from './store.ts';
import { openConversation, sentByUs } from './conversations.ts';
import type { RouteResult } from './demo.ts';
import type { ChannelAdapter, Inbound } from './types.ts';

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
//
// Our own number is connected the same way, on our company store's WhatsApp page (lines.ts oneNumber, docs/company.md):
// from then on it is the demo number, the owner line and our support at once, never that store's own WhatsApp. No
// other store can connect it (OURS_HE), and the operator's answers from our phone land where that person is talking
// (lineEcho).
//
// The token's life (meta.ts has what Meta allows): debug_token is read after the connect and once a day
// (checkToken), and its issue and end are kept in the row's token_* columns. A token that never expires is left
// alone. One that ends within RENEW_DAYS is renewed, a never-expiring one made from it when Meta allows, else another
// 60 days. When neither works: from WARN_DAYS before the end the store's dashboard and the operator's list say
// "לחבר מחדש את הוואטסאפ" (and the owner gets an email, once), and on the end, or the first time Meta refuses the
// token, the status becomes 'reconnect' (needsReconnect): every customer message waits for the owner with a note
// saying why (heldForReconnect), instead of an answer that cannot go out. Connecting again on the same page makes it
// active again with a new token.

export class ConnectError extends Error {
  he: string;
  constructor(message: string, he: string) {
    super(message);
    this.he = he;
  }
}

const COEXISTENCE = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** What a store is told when it tries to connect our own number. */
export const OURS_HE = 'זה המספר של OpenFrequency, ואי אפשר לחבר אותו לחנות. כאן מחברים את מספר הוואטסאפ של החנות עצמה.';

/** The numbers our own WhatsApp is known by: the demo number, the owner line, and our one number as Meta shows it. */
function ourNumbers(env: Record<string, string | undefined>, one: { number: string | null } | null): Set<string> {
  return new Set([lineNumber(env, 'demo'), lineNumber(env, 'owner'), one?.number || null].filter((n): n is string => Boolean(n)));
}

export type ConnectInput = { code: string; phoneId: string; wabaId: string; businessId?: string; event: string; by: string; email?: string | null };

/** The worker renews a token that ends within this many days. */
export const RENEW_DAYS = 20;
/** The store is asked to connect again from this many days before its token ends. */
export const WARN_DAYS = 10;

/** When the token ends (null: never, or not read yet), and whether the store should connect again now. */
export function tokenState(a: { status: string; token_expires_at?: string | Date | null }): { endsAt: number | null; ended: boolean; soon: boolean } {
  const endsAt = a.token_expires_at ? new Date(a.token_expires_at).getTime() : null;
  const ended = a.status === 'reconnect';
  return { endsAt, ended, soon: !ended && a.status !== 'off' && endsAt != null && endsAt - now() < WARN_DAYS * DAY };
}

/** What debug_token said, kept on the row. */
async function recordToken(app: App, accountId: number, t: TokenInfo) {
  await app.db.query('UPDATE channel_accounts SET token_issued_at = $2, token_expires_at = $3, token_data_until = $4, token_checked_at = now(), meta = meta || $5::jsonb WHERE id = $1', [accountId, t.issuedAt, t.expiresAt, t.dataAccessUntil, J({ token_scopes: t.scopes, token_error: null })]);
}

export async function connectWhatsapp(app: App, storeId: number, input: ConnectInput) {
  if (!waConnectReady(app.env)) throw new ConnectError('the Meta settings or TORAN_SECRETS_KEY are missing', 'החיבור לוואטסאפ עוד לא פתוח בשרת. כתבו לנו ונחבר יחד.');
  const phoneId = digits(input.phoneId);
  const wabaId = digits(input.wabaId);
  const code = String(input.code || '').trim();
  if (!code || !phoneId || !wabaId) throw new ConnectError('the signup gave no code or ids', 'Meta לא החזירה את פרטי החיבור. אפשר לנסות שוב.');
  if (input.event !== COEXISTENCE) throw new ConnectError(`not a coexistence onboarding (${input.event})`, 'צריך לבחור בחלון של Meta לחבר את המספר שכבר פעיל באפליקציית WhatsApp Business. ככה הוואטסאפ ממשיך לעבוד גם בטלפון.');
  // Our own number is connected on our company store's page only: on a store's page it would be answered as that
  // store, and our demos, owners and support would stop.
  const company = isCompany(await app.db.one<{ platform: string | null }>('SELECT platform FROM stores WHERE id = $1', [storeId]));
  const one = await oneNumber(app);
  if (!company && lineOf(app.env, phoneId, withOne(app.env, one))) throw new ConnectError(`phone ${phoneId} is our own number`, OURS_HE);
  const taken = await app.db.one<{ store_id: number }>("SELECT store_id FROM channel_accounts WHERE channel = 'whatsapp' AND external_id = $1", [phoneId]);
  if (taken && taken.store_id !== storeId) throw new ConnectError(`phone ${phoneId} belongs to store ${taken.store_id}`, 'המספר הזה כבר מחובר לחנות אחרת.');

  const token = await exchangeCode(app.env, app.graph, code);
  await subscribeApp(app.env, app.graph, wabaId, token);
  const info = await phoneInfo(app.env, app.graph, phoneId, token);
  // Known by its number too, before it is kept. The subscription stays: it is our own account's, which our number
  // needs anyway.
  const display = digits(info.display_phone_number);
  if (!company && display && ourNumbers(app.env, one).has(display)) throw new ConnectError(`phone ${phoneId} (${display}) is our own number`, OURS_HE);
  const state = accountState(info);
  // How long the token lasts. Not knowing yet stops nothing: the worker reads it again within a day.
  let life: TokenInfo | null = null;
  try {
    life = await debugToken(app.env, app.graph, token);
  } catch (e: any) {
    app.log(`[wa] debug_token after the connect of store ${storeId} failed (read again by the worker): ${e?.message || e}`);
  }
  const meta = {
    waba_id: wabaId, business_id: digits(input.businessId) || life?.business || null, display_phone_number: digits(info.display_phone_number) || null, verified_name: info.verified_name || null,
    phone_status: info.status || null, why: state.why, checked_at: new Date().toISOString(), event: input.event, by_email: input.email || null, token_scopes: life?.scopes || [],
  };
  const row = await app.db.one<{ id: number }>(
    `INSERT INTO channel_accounts (store_id, channel, kind, external_id, name, secret, status, meta, token_issued_at, token_expires_at, token_data_until, token_checked_at) VALUES ($1, 'whatsapp', 'meta', $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     ON CONFLICT (channel, external_id) DO UPDATE SET kind = 'meta', name = EXCLUDED.name, secret = EXCLUDED.secret, status = EXCLUDED.status, meta = EXCLUDED.meta, connected_at = now(),
       token_issued_at = EXCLUDED.token_issued_at, token_expires_at = EXCLUDED.token_expires_at, token_data_until = EXCLUDED.token_data_until, token_checked_at = EXCLUDED.token_checked_at
     RETURNING id`,
    [storeId, phoneId, info.verified_name || null, seal(app.env, token), state.status, J(meta), life?.issuedAt ?? null, life?.expiresAt ?? null, life?.dataAccessUntil ?? null, life ? new Date().toISOString() : null],
  );
  await audit(app.db, { actor: input.by, action: 'whatsapp_connect', storeId, detail: { phoneId, wabaId, status: state.status, tokenEnds: life ? life.expiresAt || 'never' : 'unknown', ...(company ? { ours: true } : {}) } });
  await event(app.db, storeId, state.status === 'active' ? 'wa_connected' : 'wa_pending', { accountId: row!.id, phone: meta.display_phone_number });
  // Our company store's number is our one number from now on (lines.ts): nothing to set.
  return { accountId: row!.id, status: state.status, phone: meta.display_phone_number, ours: company };
}

/** Read a number's state from Meta again, and turn it on (or off) when it changed. */
export async function checkAccount(app: App, accountId: number) {
  const a = await app.db.one<any>("SELECT id, store_id, external_id, secret, status, meta FROM channel_accounts WHERE id = $1 AND channel = 'whatsapp' AND kind = 'meta'", [accountId]);
  // A number waiting to be connected again stays so until it is: its token is no good for asking.
  if (!a || a.status === 'off' || a.status === 'reconnect' || !a.secret) return { status: a?.status || 'missing' };
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
  // Our own number (lines.ts): the operator writing from our phone is not a store's owner (lineEcho).
  const line = lineOf(app.env, echo.account, withOne(app.env, await oneNumber(app)));
  if (line) return lineEcho(app, echo, line);
  const a = await app.db.one<{ id: number; store_id: number }>("SELECT id, store_id FROM channel_accounts WHERE channel = 'whatsapp' AND external_id = $1 AND status IN ('active', 'pending', 'reconnect')", [echo.account]);
  if (!a) return { action: 'unknown_account' };
  // Meta reports our own API sends as delivery statuses, not echoes; this guards against one arriving as both.
  if (await sentByUs(app.db, echo.id)) return { action: 'duplicate' };
  const c = await openConversation(app.db, { storeId: a.store_id, channel: 'whatsapp', peer: echo.to, accountId: a.id });
  await app.db.query("INSERT INTO messages (conversation_id, role, text, author, ext_id) VALUES ($1, 'owner', $2, 'מהטלפון', $3)", [c.id, echo.text || '(קובץ)', `echo:${echo.id}`]);
  await app.db.query(`UPDATE conversations SET last_at = now(), agent_paused_until = now() + interval '${PAUSE_HOURS} hours' WHERE id = $1`, [c.id]);
  await event(app.db, a.store_id, 'owner_reply', { conversationId: c.id, via: 'phone' });
  return { action: 'owner_echo', conversationId: c.id };
}

type Where = { kind: 'demo' | 'support' | 'owner'; id: number | null; storeId: number | null; workspaceId?: number | null; at: string | null };

/**
 * The operator wrote from our own phone, on our number (lines.ts): the answer lands where that person is talking now,
 * and Toran steps back there for PAUSE_HOURS, as for a store's owner answering from theirs. Where they wrote last wins:
 *   a demo        the demo conversation (no account) with the store the phone is bound to; on the demo number only
 *   our support   their conversation on our support's account (status 'line', src/company.ts)
 *   an owner      their chat with the assistant (assistant_messages), paused on their number (owner_numbers)
 * Someone who never wrote gets a new support conversation, paused, so their answer waits for the operator; with no
 * support set up, the echo is only recorded.
 */
async function lineEcho(app: App, echo: Echo, line: Line) {
  const { db } = app;
  // Our own sends come back as delivery reports, not echoes; one that came as both is known by its id.
  if (await sentByUs(db, echo.id)) return { action: 'duplicate' };
  // Each half is its own query, so each reads its own index (migration 022): data->>'id' on the sends, data->>'echo'.
  if (await db.one("SELECT 1 FROM events WHERE kind IN ('wa_out', 'owner_reply') AND data->>'id' = $1 AND at > now() - interval '2 days'", [echo.id])) return { action: 'duplicate' };
  if (await db.one("SELECT 1 FROM events WHERE kind = 'owner_reply' AND data->>'echo' = $1 AND at > now() - interval '2 days'", [echo.id])) return { action: 'duplicate' };
  const peer = echo.to;
  const demo = line === 'demo' ? await db.one<Where>(`SELECT 'demo' AS kind, id, store_id AS "storeId", last_at AS at FROM conversations WHERE channel = 'whatsapp' AND peer = $1 AND account_id IS NULL AND closed_at IS NULL AND last_at > now() - interval '7 days' ORDER BY last_at DESC LIMIT 1`, [peer]) : null;
  const support = await db.one<Where>(`SELECT 'support' AS kind, c.id, c.store_id AS "storeId", c.last_at AS at FROM conversations c JOIN channel_accounts a ON a.id = c.account_id WHERE a.channel = 'whatsapp' AND a.status = 'line' AND c.peer = $1 AND c.closed_at IS NULL AND c.last_at > now() - interval '7 days' ORDER BY c.last_at DESC LIMIT 1`, [peer]);
  const owner = await db.one<Where>("SELECT 'owner' AS kind, NULL::int AS id, (SELECT store_id FROM assistant_messages WHERE phone = o.phone ORDER BY id DESC LIMIT 1) AS \"storeId\", o.workspace_id AS \"workspaceId\", GREATEST((SELECT max(at) FROM assistant_messages WHERE phone = o.phone AND via = 'whatsapp'), o.last_inbound_at) AS at FROM owner_numbers o WHERE o.phone = $1", [peer]);
  const when = (w: Where | null) => (w?.at ? new Date(w.at).getTime() : -1);
  let where = [demo, support, owner].reduce<Where | null>((best, w) => (w && when(w) > when(best) ? w : best), null);

  if (where?.kind === 'owner') {
    await db.query("INSERT INTO assistant_messages (store_id, role, text, via, author, workspace_id, phone) VALUES ($1, 'assistant', $2, 'whatsapp', 'מהטלפון', $3, $4)", [where.storeId, echo.text || '(קובץ)', where.workspaceId ?? null, peer]);
    await db.query(`UPDATE owner_numbers SET agent_paused_until = now() + interval '${PAUSE_HOURS} hours' WHERE phone = $1`, [peer]);
    await event(db, where.storeId, 'owner_reply', { via: 'phone', line: 'owner', echo: echo.id });
    return { action: 'owner_echo', owner: peer };
  }
  if (!where) {
    const account = await supportAccount(app, { kind: 'meta_line' }, lineNumber(app.env, line) || (await oneNumber(app))?.number);
    if (!account) {
      await event(db, null, 'our_line_echo', { line, echo: echo.id });
      return { action: 'our_line' };
    }
    const c = await openConversation(db, { storeId: account.store_id, channel: 'whatsapp', peer, accountId: account.id });
    where = { kind: 'support', id: c.id, storeId: account.store_id, at: null };
  }
  await db.query("INSERT INTO messages (conversation_id, role, text, author, ext_id) VALUES ($1, 'owner', $2, 'מהטלפון', $3)", [where.id, echo.text || '(קובץ)', `echo:${echo.id}`]);
  await db.query(`UPDATE conversations SET last_at = now(), agent_paused_until = now() + interval '${PAUSE_HOURS} hours' WHERE id = $1`, [where.id]);
  await event(db, where.storeId, 'owner_reply', { conversationId: where.id, via: 'phone', line: where.kind, echo: echo.id });
  return { action: 'owner_echo', conversationId: where.id, line: where.kind };
}

/** A delivery report: only a failure is kept, with Meta's reason, so a reply that never arrived is visible. */
export async function deliveryStatus(app: App, s: Status) {
  if (s.status !== 'failed') return;
  const a = await app.db.one<{ store_id: number }>("SELECT store_id FROM channel_accounts WHERE channel = 'whatsapp' AND external_id = $1", [s.account]);
  await event(app.db, a?.store_id ?? null, 'wa_failed', { id: s.id, error: s.error });
}

// ---- the token's life

const TZ = 'Asia/Jerusalem';
const dateHe = (t: string | number | Date) => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, day: 'numeric', month: 'long' }).format(new Date(t));

/** The page a store connects its WhatsApp again on (pages/whatsapp.ts). */
export const reconnectUrl = (env: Record<string, string | undefined>, storeId: number) => `${String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/lead/${storeId}/whatsapp`;

/** Read the token's life from Meta, renew it when it ends soon, and say so when it cannot be renewed. The worker, daily. */
export async function checkToken(app: App, accountId: number) {
  const a = await app.db.one<any>("SELECT id, store_id, secret, status, meta, token_expires_at FROM channel_accounts WHERE id = $1 AND channel = 'whatsapp' AND kind = 'meta'", [accountId]);
  if (!a || !a.secret || a.status === 'off' || a.status === 'reconnect') return { status: a?.status || 'missing' };
  const token = open(app.env, a.secret);
  let t: TokenInfo;
  try {
    t = await debugToken(app.env, app.graph, token);
  } catch (e: any) {
    await app.db.query('UPDATE channel_accounts SET token_checked_at = now(), meta = meta || $2::jsonb WHERE id = $1', [a.id, J({ token_error: String(e?.message || e).slice(0, 200) })]);
    // Meta did not answer, and the end we know of has passed: the token is gone either way.
    if (a.token_expires_at && new Date(a.token_expires_at).getTime() <= now()) {
      await needsReconnect(app, a.id, 'expired');
      return { status: 'reconnect' };
    }
    return { status: a.status, error: String(e?.message || e) };
  }
  await recordToken(app, a.id, t);
  const endsAt = t.expiresAt ? new Date(t.expiresAt).getTime() : null;
  if (!t.valid || (endsAt != null && endsAt <= now())) {
    await needsReconnect(app, a.id, t.valid ? 'expired' : 'token');
    return { status: 'reconnect' };
  }
  if (endsAt == null) return { status: a.status, expiresAt: null };
  if (endsAt - now() < RENEW_DAYS * DAY) {
    const how = await renewToken(app, { ...a, meta: a.meta || {} }, token, t);
    if (how) return { status: a.status, renewed: how };
  }
  if (endsAt - now() < WARN_DAYS * DAY) await tellOwner(app, a.id, 'soon');
  return { status: a.status, expiresAt: t.expiresAt };
}

/**
 * A new token before this one ends: one that never expires, when the token covers the store's business
 * (business_management), else another 60 days. The new one is believed only once debug_token says it is valid and
 * lasts longer. Neither: null, and the reasons are kept for the operator.
 */
async function renewToken(app: App, a: { id: number; store_id: number; meta: any }, token: string, t: TokenInfo): Promise<'lasting' | 'refreshed' | null> {
  const business = t.business || a.meta.business_id || null;
  const tries: ['lasting' | 'refreshed', () => Promise<string>][] = [];
  if (business && t.scopes.includes('business_management')) tries.push(['lasting', () => lastingToken(app.env, app.graph, business, token)]);
  tries.push(['refreshed', () => refreshToken(app.env, app.graph, token)]);
  const why: string[] = [];
  for (const [how, get] of tries) {
    try {
      const next = await get();
      const n = await debugToken(app.env, app.graph, next);
      if (!n.valid) throw new Error('Meta says the new token is not valid');
      if (n.expiresAt && t.expiresAt && new Date(n.expiresAt).getTime() <= new Date(t.expiresAt).getTime()) throw new Error('the new token ends no later than the old one');
      await app.db.query('UPDATE channel_accounts SET secret = $2, meta = meta || $3::jsonb WHERE id = $1', [a.id, seal(app.env, next), J({ renewed_at: new Date().toISOString(), renewed_by: how, renew_error: null, notified: {} })]);
      await recordToken(app, a.id, n);
      await event(app.db, a.store_id, 'wa_token_renewed', { accountId: a.id, how, expiresAt: n.expiresAt });
      return how;
    } catch (e: any) {
      why.push(`${how}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  await app.db.query('UPDATE channel_accounts SET meta = meta || $2::jsonb WHERE id = $1', [a.id, J({ renew_error: why.join('; ') })]);
  await event(app.db, a.store_id, 'wa_token_renew_failed', { accountId: a.id, why });
  app.log(`[wa] the token of account ${a.id} (store ${a.store_id}) could not be renewed: ${why.join('; ')}`);
  return null;
}

/** The token ended, or Meta refused it: Toran stops answering on the number, and the owner is told. */
export async function needsReconnect(app: App, accountId: number, why: 'expired' | 'token') {
  const r = await app.db.query<{ id: number; store_id: number }>("UPDATE channel_accounts SET status = 'reconnect', meta = meta || $2::jsonb WHERE id = $1 AND status IN ('active', 'pending') RETURNING id, store_id", [accountId, J({ why: `token_${why}`, reconnect_at: new Date().toISOString() })]);
  if (!r.length) return false;
  await event(app.db, r[0].store_id, 'wa_reconnect', { accountId, why });
  await tellOwner(app, accountId, 'ended');
  return true;
}

const NOTICE = {
  soon: (store: string, ends: string, url: string) => ({
    subject: `צריך לחבר מחדש את הוואטסאפ של ${store} לתורן`,
    text: `שלום,\n\nהחיבור של הוואטסאפ של ${store} לתורן מסתיים ב-${ends}. מהתאריך הזה תורן לא יוכל לענות בו, עד שתחברו אותו מחדש.\n\nזה לוקח דקה: נכנסים לקישור, לוחצים "לחבר מחדש את הוואטסאפ" ומאשרים בחלון של Meta. הוואטסאפ בטלפון ממשיך לעבוד כרגיל, והשיחות נשארות.\n\n${url}\n\nתורן, OpenFrequency`,
  }),
  ended: (store: string, _ends: string, url: string) => ({
    subject: `תורן הפסיק לענות בוואטסאפ של ${store}`,
    text: `שלום,\n\nהחיבור של הוואטסאפ של ${store} לתורן הסתיים, ותורן לא עונה בו עכשיו. ההודעות של הלקוחות מחכות לכם בשיחות בדשבורד, ואפשר לענות להן מהטלפון כרגיל.\n\nכדי שתורן יחזור לענות, צריך לחבר מחדש. זה לוקח דקה:\n\n${url}\n\nתורן, OpenFrequency`,
  }),
};

/**
 * Tell the store's owner, once for each of 'soon' and 'ended': an event (the dashboard and the operator's list read
 * the row itself), and an email when email is on here and an address is known (the person who connected, and the
 * workspace's people accounts knows). An email that fails is logged; the dashboard still says it.
 */
async function tellOwner(app: App, accountId: number, kind: 'soon' | 'ended') {
  const a = await app.db.one<any>('SELECT a.id, a.store_id, a.meta, a.token_expires_at, s.name, s.domain, s.brand, s.workspace_id FROM channel_accounts a JOIN stores s ON s.id = a.store_id WHERE a.id = $1', [accountId]);
  if (!a || a.meta?.notified?.[kind]) return;
  await app.db.query("UPDATE channel_accounts SET meta = jsonb_set(meta, '{notified}', COALESCE(meta->'notified', '{}'::jsonb) || $2::jsonb) WHERE id = $1", [a.id, J({ [kind]: new Date().toISOString() })]);
  const sent: string[] = [];
  if (app.mail) {
    const to = new Set<string>();
    if (a.meta?.by_email) to.add(String(a.meta.by_email).toLowerCase());
    if (a.workspace_id) for (const o of (await ownersOf(app, a.workspace_id)) || []) if (o.user.email) to.add(o.user.email.toLowerCase());
    const name = a.brand?.name || a.name || a.domain;
    const m = NOTICE[kind](name, a.token_expires_at ? dateHe(a.token_expires_at) : '', reconnectUrl(app.env, a.store_id));
    for (const address of [...to].filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) {
      try {
        await app.mail.notice(address, m.subject, m.text);
        sent.push(address);
      } catch (e: any) {
        app.log(`[wa] the ${kind} notice to the owner of store ${a.store_id} failed: ${e?.message || e}`);
      }
    }
  }
  await event(app.db, a.store_id, kind === 'soon' ? 'wa_reconnect_soon' : 'wa_reconnect_told', { accountId: a.id, emails: sent.length });
}

const HELD_NOTE = 'החיבור של הוואטסאפ לתורן הסתיים, אז תורן לא ענה. ההודעה מחכה לכם: אפשר לענות מהטלפון, ולחבר מחדש בהגדרות כדי שתורן יחזור לענות.';

/** A customer wrote while the number needs connecting again: the message waits for the owner, with a note once a day. */
export async function heldForReconnect(app: App, adapter: ChannelAdapter, inbound: Inbound, account: Account): Promise<RouteResult> {
  const conv = await conversationOf(app, adapter, account, inbound);
  await hold(app, conv, inbound);
  const noted = await app.db.one("SELECT 1 FROM messages WHERE conversation_id = $1 AND role = 'system' AND handoff->>'reason' = 'reconnect' AND at > now() - interval '1 day'", [conv]);
  if (!noted) await handOver(app, account.store_id, conv, 'reconnect', 'the WhatsApp token ended', HELD_NOTE);
  await event(app.db, account.store_id, 'held', { conversationId: conv, why: 'reconnect' });
  return { action: 'held', storeId: account.store_id };
}
