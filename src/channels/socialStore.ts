import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import { J } from '../db/index.ts';
import { audit, event } from '../db/log.ts';
import { open, seal } from '../core/secrets.ts';
import { GraphError } from './meta.ts';
import { PAUSE_HOURS } from './owner.ts';
import { LEDGER } from './send.ts';
import { ConnectError } from './waStore.ts';
import {
  authorizeUrl, instagramAccount, messengerPages, refreshInstagramToken, socialReady, socialSettings, subscribeInstagram, subscribePage, unsubscribeInstagram, unsubscribePage,
  type DmEcho, type Page, type Social,
} from './social.ts';

// A store's own Facebook Page (Messenger) or Instagram account, connected through Meta (social.ts), as a row of
// channel_accounts:
//
//   channel 'messenger' | 'instagram', kind 'meta', external_id the Page's id or the Instagram account's id (the
//   ones Meta's webhooks name), name the Page's name or @username, secret the account's token sealed, status
//   active | error | off, meta { username, expires_at (Instagram's token), by, user (the Facebook user, Messenger) }
//
//   beginConnect()   the button: a row in channel_connects, a cookie for this browser, and Meta's login address
//   finishConnect()  Meta's answer at /meta/oauth/<channel>: the state and the cookie checked, the code turned into
//                    the account's token, Meta asked to send its messages here. A person with more than one Page
//                    picks one (pickPage)
//   socialEcho()     the owner answered from the Page's inbox or the Instagram app: their answer, in the inbox, and
//                    Toran steps back, as when they answer from the dashboard
//   refreshInstagram() the worker, before an Instagram token's 60 days end
//
// The connect, the pick and the disconnect are the store's own (server.ts checks the workspace of /lead/<id>/...);
// the answer from Meta comes without a session, so the state, the cookie and the user who pressed are what tie it to
// them.

export const CHANNEL_NAME: Record<Social, string> = { messenger: 'מסנג׳ר', instagram: 'אינסטגרם' };
const CONNECT_MINUTES = 15;
const PICK_MINUTES = 30;
export const NONCE_COOKIE = 'tn_meta';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The button: Meta's login address for this store, and the cookie this browser keeps until Meta sends it back. */
export async function beginConnect(app: App, storeId: number, channel: Social, user: { id: number; name: string }, { secure }: { secure: boolean }) {
  if (!socialReady(app.env, channel)) throw new ConnectError(`${channel} is not ready (TORAN_CHANNELS, the Meta settings, PUBLIC_BASE_URL or TORAN_SECRETS_KEY)`, `החיבור ל${CHANNEL_NAME[channel]} עוד לא פתוח בשרת. כתבו לנו ונחבר יחד.`);
  const state = randomBytes(24).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  await app.db.query("DELETE FROM channel_connects WHERE created_at < now() - interval '1 day'");
  await app.db.query('INSERT INTO channel_connects (state, store_id, channel, user_id, by_name, nonce_hash) VALUES ($1, $2, $3, $4, $5, $6)', [state, storeId, channel, user.id, user.name, hash(nonce)]);
  // Lax: the browser sends it when Meta's page sends it back here, a top-level navigation.
  const cookie = `${NONCE_COOKIE}=${nonce}; Path=/meta/oauth; Max-Age=${CONNECT_MINUTES * 60}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  return { url: authorizeUrl(app.env, channel, state), cookie };
}

export type Finish = { storeId: number | null; outcome: 'connected' | 'pick' | 'error'; why?: string; state?: string };

/** Meta's answer to the login. Never throws: the outcome says what happened, and the page says it in words. */
export async function finishConnect(app: App, channel: Social, q: { state: string; code: string; error: string; nonce: string }): Promise<Finish> {
  const row = q.state ? await app.db.one<any>(`SELECT state, store_id, channel, user_id, by_name, nonce_hash, used_at, created_at > now() - interval '${CONNECT_MINUTES} minutes' AS fresh FROM channel_connects WHERE state = $1`, [q.state]) : null;
  if (!row || row.channel !== channel) return { storeId: null, outcome: 'error', why: 'state' };
  const storeId = Number(row.store_id);
  if (row.used_at || !row.fresh) return { storeId, outcome: 'error', why: 'expired' };
  if (!q.nonce || !sameHash(hash(q.nonce), row.nonce_hash)) return { storeId, outcome: 'error', why: 'browser' };
  await app.db.query('UPDATE channel_connects SET used_at = now() WHERE state = $1', [q.state]);
  if (q.error || !q.code) return { storeId, outcome: 'error', why: 'cancelled' };
  const by = String(row.by_name || 'store');
  try {
    if (channel === 'instagram') {
      const a = await instagramAccount(app.env, app.graph, q.code);
      await connectAccount(app, storeId, 'instagram', { externalId: a.id, name: a.username ? `@${a.username}` : a.name, token: a.token, meta: { username: a.username, name: a.name, expires_at: a.expiresAt } }, by);
      return { storeId, outcome: 'connected' };
    }
    const { user, pages } = await messengerPages(app.env, app.graph, q.code);
    if (!pages.length) return { storeId, outcome: 'error', why: 'no_pages' };
    if (pages.length === 1) {
      await connectPage(app, storeId, pages[0], user, by);
      return { storeId, outcome: 'connected' };
    }
    await app.db.query('UPDATE channel_connects SET data = $2 WHERE state = $1', [q.state, seal(app.env, JSON.stringify({ user, pages }))]);
    return { storeId, outcome: 'pick', state: q.state };
  } catch (e: any) {
    if (e instanceof ConnectError) return { storeId, outcome: 'error', why: e.message === 'taken' ? 'taken' : 'meta' };
    app.log(`[${LEDGER[channel].tag}] connect for store ${storeId} failed: ${e?.message || e}`);
    return { storeId, outcome: 'error', why: 'meta' };
  }
}

/** The Pages a person with more than one can pick from, while the pick lasts; only for the one who pressed. */
export async function pagesToPick(app: App, storeId: number, state: string, userId: number): Promise<Page[] | null> {
  const row = await app.db.one<any>(`SELECT data FROM channel_connects WHERE state = $1 AND store_id = $2 AND channel = 'messenger' AND user_id = $3 AND data IS NOT NULL AND created_at > now() - interval '${PICK_MINUTES} minutes'`, [state, storeId, userId]);
  if (!row) return null;
  try {
    return (JSON.parse(open(app.env, row.data)).pages || []) as Page[];
  } catch {
    return null;
  }
}

export async function pickPage(app: App, storeId: number, state: string, pageId: string, user: { id: number; name: string }) {
  const row = await app.db.one<any>(`SELECT data FROM channel_connects WHERE state = $1 AND store_id = $2 AND channel = 'messenger' AND user_id = $3 AND data IS NOT NULL AND created_at > now() - interval '${PICK_MINUTES} minutes'`, [state, storeId, user.id]);
  if (!row) throw new ConnectError('the pick expired', 'עבר יותר מדי זמן מהכניסה לפייסבוק. אפשר לחבר שוב.');
  const { user: fbUser, pages } = JSON.parse(open(app.env, row.data)) as { user: string | null; pages: Page[] };
  const page = pages.find((p) => p.id === pageId);
  if (!page) throw new ConnectError('not one of the pages', 'הדף הזה לא ברשימה. אפשר לחבר שוב.');
  await app.db.query('UPDATE channel_connects SET data = NULL WHERE state = $1', [state]);
  return connectPage(app, storeId, page, fbUser, user.name);
}

const connectPage = (app: App, storeId: number, page: Page, fbUser: string | null, by: string) =>
  connectAccount(app, storeId, 'messenger', { externalId: page.id, name: page.name, token: page.token, meta: { user: fbUser } }, by);

async function connectAccount(app: App, storeId: number, channel: Social, a: { externalId: string; name: string | null; token: string; meta: Record<string, unknown> }, by: string) {
  const taken = await app.db.one<{ store_id: number }>("SELECT store_id FROM channel_accounts WHERE channel = $1 AND external_id = $2 AND status <> 'off'", [channel, a.externalId]);
  if (taken && taken.store_id !== storeId) {
    await event(app.db, storeId, `${LEDGER[channel].tag}_taken`, { externalId: a.externalId, by: taken.store_id });
    throw new ConnectError('taken', 'החשבון הזה כבר מחובר לחנות אחרת.');
  }
  if (channel === 'messenger') await subscribePage(app.env, app.graph, a.externalId, a.token);
  else await subscribeInstagram(app.env, app.graph, a.token);
  // One Page, or one Instagram account, per store: connecting another turns the old one off.
  const old = await app.db.query<any>("SELECT id, external_id, secret FROM channel_accounts WHERE store_id = $1 AND channel = $2 AND status <> 'off' AND external_id <> $3", [storeId, channel, a.externalId]);
  for (const o of old) await turnOff(app, channel, o);
  const meta = { ...a.meta, by, checked_at: new Date().toISOString() };
  const row = await app.db.one<{ id: number }>(
    `INSERT INTO channel_accounts (store_id, channel, kind, external_id, name, secret, status, meta) VALUES ($1, $2, 'meta', $3, $4, $5, 'active', $6::jsonb)
     ON CONFLICT (channel, external_id) DO UPDATE SET store_id = EXCLUDED.store_id, kind = 'meta', name = EXCLUDED.name, secret = EXCLUDED.secret, status = 'active', meta = EXCLUDED.meta, connected_at = now()
     RETURNING id`,
    [storeId, channel, a.externalId, a.name, seal(app.env, a.token), J(meta)],
  );
  await audit(app.db, { actor: by, action: `${channel}_connect`, storeId, detail: { externalId: a.externalId } });
  await event(app.db, storeId, `${LEDGER[channel].tag}_connected`, { accountId: row!.id, name: a.name });
  return { accountId: row!.id };
}

/** Meta stops sending us the account's messages, and the token is forgotten. The Page or account itself is untouched. */
async function turnOff(app: App, channel: Social, a: { id: number; external_id: string; secret: string | null }) {
  if (a.secret) {
    try {
      const token = open(app.env, a.secret);
      if (channel === 'messenger') await unsubscribePage(app.env, app.graph, a.external_id, token);
      else await unsubscribeInstagram(app.env, app.graph, token);
    } catch (e: any) {
      app.log(`[${LEDGER[channel].tag}] unsubscribe of account ${a.id} failed (it is off here anyway): ${e?.message || e}`);
    }
  }
  await app.db.query("UPDATE channel_accounts SET status = 'off', secret = NULL WHERE id = $1", [a.id]);
}

export async function disconnectSocial(app: App, storeId: number, channel: Social, by: string) {
  const a = await app.db.one<any>("SELECT id, external_id, secret FROM channel_accounts WHERE store_id = $1 AND channel = $2 AND status <> 'off' ORDER BY id DESC LIMIT 1", [storeId, channel]);
  if (!a) return false;
  await turnOff(app, channel, a);
  await audit(app.db, { actor: by, action: `${channel}_disconnect`, storeId, detail: { accountId: a.id } });
  await event(app.db, storeId, `${LEDGER[channel].tag}_disconnected`, { accountId: a.id });
  return true;
}

const ECHO_AUTHOR: Record<Social, string> = { messenger: 'מהדף בפייסבוק', instagram: 'מהאינסטגרם' };

/**
 * The owner answered a customer from the Page's inbox (Meta Business Suite) or the Instagram app: their answer, in
 * the inbox, and Toran steps back. Meta echoes Toran's own sends too: those carry our app's id (Messenger), or are a
 * message Toran already sent (its id in the ledger), and are dropped.
 */
export async function socialEcho(app: App, echo: DmEcho) {
  const a = await app.db.one<{ id: number; store_id: number }>("SELECT id, store_id FROM channel_accounts WHERE channel = $1 AND external_id = $2 AND status = 'active'", [echo.channel, echo.account]);
  if (!a) return { action: 'unknown_account' };
  if (echo.appId && echo.appId === socialSettings(app.env).appId) return { action: 'ours' };
  const tag = LEDGER[echo.channel].tag;
  if (await app.db.one("SELECT 1 FROM messages WHERE ext_id = $1 OR delivery @> $2::jsonb", [`echo:${echo.id}`, J([echo.id])])) return { action: 'duplicate' };
  if (await app.db.one("SELECT 1 FROM events WHERE kind = $1 AND data->>'id' = $2 AND at > now() - interval '1 day'", [`${tag}_out`, echo.id])) return { action: 'ours' };
  let c = await app.db.one<{ id: number }>("SELECT id FROM conversations WHERE account_id = $1 AND peer = $2 AND last_at > now() - interval '7 days' AND closed_at IS NULL ORDER BY last_at DESC LIMIT 1", [a.id, echo.to]);
  c ??= await app.db.one<{ id: number }>('INSERT INTO conversations (store_id, channel, peer, account_id) VALUES ($1, $2, $3, $4) RETURNING id', [a.store_id, echo.channel, echo.to, a.id]);
  await app.db.query("INSERT INTO messages (conversation_id, role, text, author, ext_id) VALUES ($1, 'owner', $2, $3, $4)", [c!.id, echo.text || '(קובץ)', ECHO_AUTHOR[echo.channel], `echo:${echo.id}`]);
  await app.db.query(`UPDATE conversations SET last_at = now(), agent_paused_until = now() + interval '${PAUSE_HOURS} hours' WHERE id = $1`, [c!.id]);
  await event(app.db, a.store_id, 'owner_reply', { conversationId: c!.id, via: echo.channel });
  return { action: 'owner_echo', conversationId: c!.id };
}

/** Instagram tokens last 60 days: the ones ending within REFRESH_DAYS get a fresh 60. */
export const REFRESH_DAYS = 20;

export async function refreshInstagram(app: App, accountId: number) {
  const a = await app.db.one<any>("SELECT id, store_id, secret FROM channel_accounts WHERE id = $1 AND channel = 'instagram' AND status = 'active'", [accountId]);
  if (!a?.secret) return { status: 'missing' };
  try {
    const t = await refreshInstagramToken(app.graph, open(app.env, a.secret));
    await app.db.query('UPDATE channel_accounts SET secret = $2, meta = meta || $3::jsonb WHERE id = $1', [a.id, seal(app.env, t.token), J({ expires_at: t.expiresAt, refreshed_at: new Date().toISOString(), why: null })]);
    return { status: 'active' };
  } catch (e: any) {
    // The token no longer works (190): the owner changed their password, or removed our app. They connect again.
    if (e instanceof GraphError && e.code === 190) {
      await app.db.query("UPDATE channel_accounts SET status = 'error', meta = meta || $2::jsonb WHERE id = $1", [a.id, J({ why: 'token' })]);
      await event(app.db, a.store_id, 'ig_error', { accountId: a.id, why: 'token' });
      return { status: 'error' };
    }
    throw e;
  }
}
