import { createHmac, timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import { J } from '../db/index.ts';
import { audit, event } from '../db/log.ts';
import { enqueue } from '../jobs/queue.ts';
import { enabledChannels } from './config.ts';
import { download } from './files.ts';
import { GraphError } from './meta.ts';
import { LIMITS } from './policy.ts';
import { socialEcho } from './socialStore.ts';
import { socialReady, type Social } from './social.ts';
import { LEDGER } from './send.ts';
import type { ChannelAdapter, Inbound, Sent, SendCtx } from './types.ts';
import { alertOperator } from '../ops/alert.ts';
import { isCompany } from '../company.ts';
import { lineNumber, lineOf, oneNumber, withOne } from './lines.ts';
import { ownerEcho, OURS_HE } from './waStore.ts';

// A store's Facebook Page (Messenger) and Instagram account through Zernio (docs.zernio.com), while our own Meta app has
// no review for them (the owner, 2026-11-08: "find a kapso for instagram and messanger"; INSTAGRAM-MESSENGER-PROVIDERS.md).
// Zernio's approved Meta apps hold the connection, so nothing of ours needs Meta's approval. TORAN_DM_PROVIDER=zernio
// turns it on for every store; the Meta way (social.ts, socialStore.ts) stays for TORAN_DM_PROVIDER=meta.
//
//   connecting   the store's Messenger or Instagram page makes the store a Zernio profile once (zernio_profiles,
//                migration 050; externalId toran-store-<id>), then asks Zernio for a connect link limited to messaging
//                (GET /v1/connect/{facebook|instagram}?scopes=messaging, Zernio's own app: no oauthAppId) behind
//                Zernio's welcome screen with our name, and sends the store there. Zernio comes back to
//                /lead/<id>/<channel>/zernio?connected=..&accountId=.., and the account is taken only when Zernio's own
//                API lists it under this store's profile (the query is not signed). The account.connected webhook does
//                the same for a store that closed the tab first.
//   receiving    one webhook for every store, /zernio/webhook, signed with X-Zernio-Signature (the lowercase hex
//                HMAC-SHA256 of the raw body under ZERNIO_WEBHOOK_SECRET). message.received is a customer's message:
//                the same queue and router as Meta's (dm_inbound). message.sent with sentVia null was sent from the
//                platform's own app: the owner answered, and Toran steps back (socialEcho), unless it came within
//                seconds of the customer's message, which is the Page's own instant reply, not a person.
//                Events of profiles that are not a Toran store's (Teder's accounts share the key) are dropped.
//   sending      POST /v1/inbox/conversations/{conversationId}/messages with the account's id, text only (Toran sends
//                no files on these channels), HUMAN_AGENT only on the owner's own answers past the 24 hours.
//   leaving      "לנתק" disconnects the account at Zernio (DELETE /v1/accounts/{id}); the Page and the Instagram
//                account themselves stay as they are.
//
// A store's own WhatsApp number goes the same way with TORAN_WA_PROVIDER=zernio (the owner, 2026-11-08: "yes, switch to
// zernio": one provider for the store's WhatsApp, Instagram and Messenger; Kapso stays as TORAN_WA_PROVIDER=kapso).
// Our own number (lines.ts: the demo, support, the alerts, the pitches) stays on Meta directly, and the company store
// never connects here.
//
//   connecting   GET /v1/connect/whatsapp with onboarding=business_app (coexistence: the number stays on the WhatsApp
//                Business app on the owner's phone) and signup=hosted (a page on zernio.com that opens Meta's Embedded
//                Signup itself), on Zernio's own app (no oauthAppId); no scopes (refused for WhatsApp). Zernio comes back
//                to /lead/<id>/whatsapp/zernio?connected=whatsapp&accountId=.., taken as for a Page.
//   receiving    message.received with platform whatsapp is a customer's message (wa_inbound, as Meta's own); its sender
//                is the phone without the + (or Meta's business-scoped id while the phone is hidden). message.sent with
//                source whatsapp_business_app was typed on the phone: the owner answered, and Toran steps back (ownerEcho),
//                unless it came within seconds of the customer's (the app's own greeting or away message);
//                meta_business_agent is Meta's own agent, and cloud_api ours. whatsapp.template.status_updated is a
//                store template's review, matched by the account (it may carry no profile).
//   sending      replies through the same inbox send (text only: Toran sends no files on WhatsApp); the store's
//                automatic messages as its own approved templates, POST /v1/inbox/conversations with templateName,
//                templateLanguage and templateParams (body, then the button's link), which also opens the thread.
//   templates    POST /v1/whatsapp/templates with the account's id and Meta's own template body; read back with
//                GET /v1/whatsapp/templates?accountId=..&name=..
//
// docs/connecting-channels.md, "A store's Page and Instagram through Zernio" and "A store's WhatsApp through Zernio",
// has each fact with the page it is from.

type Env = Record<string, string | undefined>;

export const zernioSettings = (env: Env) => ({
  apiKey: String(env.ZERNIO_API_KEY || '').trim(),
  webhookSecret: String(env.ZERNIO_WEBHOOK_SECRET || '').trim(),
  base: String(env.ZERNIO_BASE || '').trim().replace(/\/+$/, '') || 'https://zernio.com/api/v1',
  publicBase: String(env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
  accountsBase: String(env.OF_ACCOUNTS_URL || 'https://accounts.openfrequency.co.il').trim().replace(/\/+$/, ''),
});

/** Which way a store's Page and Instagram connect here: through Zernio, or Meta's login with our own app. */
export const dmProvider = (env: Env): 'zernio' | 'meta' => (String(env.TORAN_DM_PROVIDER || '').trim().toLowerCase() === 'zernio' ? 'zernio' : 'meta');

/** May a store connect through Zernio now: the channel's code on, our key, the webhook's secret, and an https address to come back to. */
export function zernioReady(env: Env, channel: Social): boolean {
  const z = zernioSettings(env);
  return enabledChannels(env).has(channel) && Boolean(z.apiKey && z.webhookSecret.length >= 16 && z.publicBase.startsWith('https://'));
}

/** May a store connect this channel on this server, the way TORAN_DM_PROVIDER says. */
export const dmConnectReady = (env: Env, channel: Social): boolean => (dmProvider(env) === 'zernio' ? zernioReady(env, channel) : socialReady(env, channel));

/** The channels a store connects through Zernio: its Page, its Instagram account, its own WhatsApp number. */
export type ZChannel = Social | 'whatsapp';

/** May a store connect its own WhatsApp number through Zernio now (TORAN_WA_PROVIDER=zernio): our key, the webhook's secret, an https address to come back to. */
export function zernioWaReady(env: Env): boolean {
  const z = zernioSettings(env);
  return Boolean(z.apiKey && z.webhookSecret.length >= 16 && z.publicBase.startsWith('https://'));
}

const readyFor = (env: Env, channel: ZChannel) => (channel === 'whatsapp' ? zernioWaReady(env) : zernioReady(env, channel));
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** A refusal said to the store, in Hebrew, beside the reason for the log. */
export class ZernioError extends Error {
  he: string;
  constructor(message: string, he: string) {
    super(message);
    this.he = he;
  }
}

/** Zernio's names for our channels, and back. */
export const PLATFORM: Record<ZChannel, 'facebook' | 'instagram' | 'whatsapp'> = { messenger: 'facebook', instagram: 'instagram', whatsapp: 'whatsapp' };
const channelOfPlatform = (p: unknown): ZChannel | null => (p === 'facebook' ? 'messenger' : p === 'instagram' ? 'instagram' : p === 'whatsapp' ? 'whatsapp' : null);

/** The externalId of a store's profile, and the store it names (null for any other profile: Teder's, or none). */
export const profileExternalId = (storeId: number) => `toran-store-${storeId}`;
export const storeOfExternalId = (x: unknown): number | null => {
  const m = /^toran-store-(\d+)$/.exec(String(x ?? ''));
  return m ? Number(m[1]) : null;
};

/** Zernio's API (https://zernio.com/api/v1), with our key. A refusal is a GraphError, as Meta's and Kapso's. */
async function api(app: App, method: 'GET' | 'POST' | 'DELETE', path: string, { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}): Promise<any> {
  const z = zernioSettings(app.env);
  if (!z.apiKey) throw new GraphError('ZERNIO_API_KEY is not set', 0, null);
  const res = await app.graph(`${z.base}/${path.replace(/^\//, '')}`, {
    method,
    headers: { authorization: `Bearer ${z.apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 204) return {};
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = out?.error?.message || out?.message || (typeof out?.error === 'string' ? out.error : '') || '';
    const err = new GraphError(`Zernio refused ${method} /${path.split('?')[0]} (${res.status}): ${String(why).slice(0, 200)}`, res.status, out?.error?.code ?? out?.code ?? null);
    (err as any).details = out?.details ?? out?.error?.details ?? null;
    throw err;
  }
  return out;
}

/** The lowercase hex HMAC-SHA256 of the raw body under a secret, as Zernio signs each webhook (X-Zernio-Signature). */
export const zernioSign = (secret: string, raw: string) => createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('hex');

export function zernioSignatureOk(secret: string, raw: string, header: unknown): boolean {
  if (!secret || typeof header !== 'string' || !header) return false;
  const a = Buffer.from(zernioSign(secret, raw), 'utf8');
  const b = Buffer.from(header.trim().toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- connecting

/** The store's Zernio profile, made the first time (or found again by its externalId, after a create that timed out). */
async function profileOf(app: App, storeId: number): Promise<string> {
  const had = await app.db.one<{ profile_id: string }>('SELECT profile_id FROM zernio_profiles WHERE store_id = $1', [storeId]);
  if (had) return had.profile_id;
  const ext = profileExternalId(storeId);
  let id = '';
  const found = await api(app, 'GET', `profiles?externalId=${encodeURIComponent(ext)}`).catch(() => null);
  id = String((found?.profiles || [])[0]?._id || '');
  if (!id) {
    try {
      // Names are unique per Zernio team: ours carry the store's id, never its name, so two stores never collide.
      const out = await api(app, 'POST', 'profiles', { body: { name: `Toran store ${storeId}`, externalId: ext, description: 'Toran: the store\'s Messenger and Instagram' }, headers: { 'idempotency-key': ext } });
      id = String(out?.profile?._id || '');
    } catch (e: any) {
      if (e instanceof GraphError && e.status === 409 && e && (e as any).details?.existingProfileId) id = String((e as any).details.existingProfileId);
      else throw e;
    }
  }
  if (!/^[0-9a-f]{24}$/i.test(id)) throw new GraphError('Zernio gave no profile id', 200, null);
  await app.db.query('INSERT INTO zernio_profiles (store_id, profile_id) VALUES ($1, $2) ON CONFLICT (store_id) DO NOTHING', [storeId, id]);
  return (await app.db.one<{ profile_id: string }>('SELECT profile_id FROM zernio_profiles WHERE store_id = $1', [storeId]))!.profile_id;
}

/** Where Zernio's connect sends the browser: its own welcome screen, or the platform's login. Nowhere else. */
const LINK = /^https:\/\/(zernio\.com|www\.facebook\.com|www\.instagram\.com|api\.instagram\.com|instagram\.com)\//;

/** Which WhatsApp number a store connects: the one in its WhatsApp Business app (coexistence), or a new one for Toran alone. */
export type WaNumber = 'app' | 'new';

/**
 * The store pressed "לחבר": its Zernio profile (made once), and the address of Zernio's connect for this channel,
 * limited to messaging, behind the welcome screen with our name. `back` is where Zernio returns the browser: Toran's
 * own name, or accounts' /admin for our company store connected from there. `number`: WhatsApp's, see WaNumber.
 */
export async function startZernioConnect(app: App, storeId: number, channel: ZChannel, by: string, { viaAdmin = false, number = 'app' }: { viaAdmin?: boolean; number?: WaNumber } = {}): Promise<string> {
  if (!readyFor(app.env, channel)) throw new ZernioError('ZERNIO_API_KEY, ZERNIO_WEBHOOK_SECRET, TORAN_CHANNELS or an https PUBLIC_BASE_URL is missing', `החיבור ל${CHANNEL_HE[channel]} עוד לא פתוח בשרת. כתבו לנו ונחבר יחד.`);
  const s = await app.db.one<{ id: number; name: string | null; domain: string; platform: string | null }>('SELECT id, name, domain, platform FROM stores WHERE id = $1', [storeId]);
  if (!s) throw new ZernioError(`no store ${storeId}`, 'אין חנות כזו.');
  // Our own number is on Meta directly, never through Zernio (lines.ts).
  if (channel === 'whatsapp' && isCompany(s)) throw new ZernioError('the company store connects on Meta directly', OURS_HE);
  const z = zernioSettings(app.env);
  const profileId = await profileOf(app, storeId);
  const dedicated = channel === 'whatsapp' && number === 'new';
  const back = `${viaAdmin ? `${z.accountsBase}/admin/toran` : z.publicBase}/lead/${storeId}/${channel}/zernio${dedicated ? '?number=new' : ''}`;
  // WhatsApp takes no scopes (Zernio refuses them: Meta's dialog cannot be reduced), on a page of Zernio's own
  // (signup=hosted). onboarding=business_app is coexistence: the store's phone keeps the WhatsApp Business app.
  // onboarding=api is Meta's standard Embedded Signup, its WABA and number picker (zernio.com/openapi.yaml,
  // getConnectUrl): a number for Toran alone, not on any WhatsApp app, verified with a code Meta sends to it by SMS or
  // a call in that window (the owner, 2026-11-09: "also build an option for businesses connecting not trough coexistnece").
  const q = new URLSearchParams(channel === 'whatsapp' ? { profileId, redirect_url: back, onboarding: dedicated ? 'api' : 'business_app', signup: 'hosted' } : { profileId, redirect_url: back, scopes: 'messaging', welcome: 'true', brandName: 'Toran' });
  const out = await api(app, 'GET', `connect/${PLATFORM[channel]}?${q.toString()}`);
  const url = String(out?.authUrl || '');
  if (!LINK.test(url)) throw new GraphError(`Zernio gave a connect address off its own and Meta's: ${url.slice(0, 80)}`, 200, null);
  await audit(app.db, { actor: by, action: `${channel}_zernio_link`, storeId, detail: { profileId, ...(channel === 'whatsapp' ? { number: dedicated ? 'new' : 'app' } : {}) } });
  return url;
}

/** One connected account of the store's profile, as Zernio lists it (GET /v1/accounts?profileId=..&platform=..), or null. */
async function zernioAccount(app: App, profileId: string, channel: ZChannel, accountId: string): Promise<any | null> {
  const out = await api(app, 'GET', `accounts?${new URLSearchParams({ profileId, platform: PLATFORM[channel] }).toString()}`);
  const list = Array.isArray(out?.accounts) ? out.accounts : [];
  return list.find((a: any) => String(a?._id || '') === accountId && String(a?.profileId?._id || a?.profileId || '') === profileId) || null;
}

const nameOf = (channel: ZChannel, a: any) =>
  channel === 'whatsapp'
    ? String(a?.metadata?.verifiedName || a?.displayName || a?.metadata?.displayPhoneNumber || a?.username || '') || null
    : channel === 'instagram' && a?.username
      ? `@${String(a.username).replace(/^@/, '')}`
      : String(a?.displayName || a?.username || '') || null;

/** What Toran keeps of a WhatsApp number connected through Zernio (its account's metadata, GET /v1/accounts). */
const waMetaOf = (a: any) => ({
  waba_id: digits(a?.metadata?.wabaId) || null,
  phone_number_id: digits(a?.metadata?.phoneNumberId) || null,
  display_phone_number: digits(a?.metadata?.displayPhoneNumber || a?.username) || null,
  verified_name: a?.metadata?.verifiedName || null,
  quality_rating: a?.metadata?.qualityRating || null,
  connection_type: 'coexistence',
});

/**
 * Zernio says an account is connected (its redirect back, or the account.connected webhook): taken for the store only
 * when Zernio's own API lists it under this store's profile and no other store has it. One Page, or one Instagram
 * account, per store: connecting another turns the old one off, at Zernio too.
 */
export async function finishZernioConnect(app: App, storeId: number, channel: ZChannel, accountIdIn: unknown, by: string, { number = 'app' }: { number?: WaNumber } = {}) {
  const accountId = String(accountIdIn ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(accountId)) throw new ZernioError('no accountId came back', `Zernio לא החזירה את פרטי ה${CHANNEL_HE[channel]}. אפשר לנסות שוב.`);
  const p = await app.db.one<{ profile_id: string }>('SELECT profile_id FROM zernio_profiles WHERE store_id = $1', [storeId]);
  if (!p) throw new ZernioError(`store ${storeId} has no Zernio profile`, 'לא התחלנו חיבור לחנות הזו. לוחצים על "לחבר" ומתחילים מחדש.');
  const a = await zernioAccount(app, p.profile_id, channel, accountId);
  if (!a) throw new ZernioError(`account ${accountId} is not store ${storeId}'s profile's at Zernio`, 'החשבון הזה לא חובר דרך החנות שלכם. לוחצים על "לחבר" ומתחילים מחדש.');
  const wa = channel === 'whatsapp' ? waMetaOf(a) : null;
  if (wa) {
    // Never one of our own numbers (lines.ts), whatever Zernio says it connected.
    const one = await oneNumber(app);
    const ours = new Set([lineNumber(app.env, 'demo'), lineNumber(app.env, 'owner'), one?.number || null].filter(Boolean));
    if ((wa.display_phone_number && ours.has(wa.display_phone_number)) || (wa.phone_number_id && lineOf(app.env, wa.phone_number_id, withOne(app.env, one)))) throw new ZernioError(`account ${accountId} is our own number`, OURS_HE);
  }
  const taken = await app.db.one<{ store_id: number }>("SELECT store_id FROM channel_accounts WHERE channel = $1 AND external_id = $2 AND status <> 'off'", [channel, accountId]);
  if (taken && taken.store_id !== storeId) {
    await event(app.db, storeId, `${LEDGER[channel].tag}_taken`, { externalId: accountId, by: taken.store_id });
    throw new ZernioError(`account ${accountId} belongs to store ${taken.store_id}`, channel === 'whatsapp' ? 'המספר הזה כבר מחובר לחנות אחרת.' : 'החשבון הזה כבר מחובר לחנות אחרת.');
  }
  // One Page, one Instagram account, one WhatsApp number through Zernio per store. A number connected another way
  // (Meta, Kapso) is left to its own page.
  const old = await app.db.query<{ id: number; kind: string; external_id: string }>(`SELECT id, kind, external_id FROM channel_accounts WHERE store_id = $1 AND channel = $2 AND status <> 'off' AND external_id <> $3${channel === 'whatsapp' ? " AND kind = 'zernio'" : ''}`, [storeId, channel, accountId]);
  for (const o of old) await offAccount(app, o);
  const meta = {
    provider: 'zernio',
    profile_id: p.profile_id,
    username: a.username || null,
    platform_user_id: a.platformUserId ? String(a.platformUserId) : null,
    ...(wa || {}),
    // A number for Toran alone has no WhatsApp app beside it: no echoes come, and the owner answers from the inbox.
    ...(channel === 'whatsapp' ? { coexistence: number !== 'new' } : {}),
    by,
    checked_at: new Date().toISOString(),
    why: null,
  };
  const name = nameOf(channel, a);
  const row = await app.db.one<{ id: number }>(
    `INSERT INTO channel_accounts (store_id, channel, kind, external_id, name, secret, status, meta) VALUES ($1, $2, 'zernio', $3, $4, NULL, 'active', $5::jsonb)
     ON CONFLICT (channel, external_id) DO UPDATE SET store_id = EXCLUDED.store_id, kind = 'zernio', name = EXCLUDED.name, secret = NULL, status = 'active', meta = EXCLUDED.meta, connected_at = now()
     RETURNING id`,
    [storeId, channel, accountId, name, J(meta)],
  );
  await audit(app.db, { actor: by, action: `${channel}_connect`, storeId, detail: { externalId: accountId, via: 'zernio' } });
  await event(app.db, storeId, `${LEDGER[channel].tag}_connected`, { accountId: row!.id, name, via: 'zernio' });
  return { accountId: row!.id, name };
}

/** An account off here; one connected through Zernio is disconnected there too (its Page or account itself stays). */
async function offAccount(app: App, a: { id: number; kind: string; external_id: string }, strict = false) {
  if (a.kind === 'zernio') {
    try {
      await api(app, 'DELETE', `accounts/${a.external_id}`);
    } catch (e: any) {
      if (!(e instanceof GraphError && e.status === 404)) {
        if (strict) throw e;
        app.log(`[zernio] disconnect of account ${a.external_id} failed (it is off here anyway): ${e?.message || e}`);
      }
    }
  }
  await app.db.query("UPDATE channel_accounts SET status = 'off', secret = NULL WHERE id = $1", [a.id]);
}

/** "לנתק": the account leaves Zernio, and Toran stops answering in it. */
/** `strict` (retention.ts, a stopped store): a removal Zernio refuses throws, and the account stays on here to be tried again. */
export async function disconnectZernio(app: App, storeId: number, channel: ZChannel, by: string, { strict = false }: { strict?: boolean } = {}) {
  const a = await app.db.one<{ id: number; kind: string; external_id: string }>("SELECT id, kind, external_id FROM channel_accounts WHERE store_id = $1 AND channel = $2 AND kind = 'zernio' AND status <> 'off' ORDER BY id DESC LIMIT 1", [storeId, channel]);
  if (!a) return false;
  await offAccount(app, a, strict);
  await audit(app.db, { actor: by, action: `${channel}_disconnect`, storeId, detail: { accountId: a.id, via: 'zernio' } });
  await event(app.db, storeId, `${LEDGER[channel].tag}_disconnected`, { accountId: a.id, via: 'zernio' });
  return true;
}

// ---- the webhook

/** A customer of one connected account: Zernio's conversation id (sending needs it) and the name Zernio gave. */
async function keepThread(app: App, accountId: number, peer: string, conversationId: string, name: string | null) {
  if (!peer || !conversationId) return;
  await app.db.query(
    `INSERT INTO zernio_threads (account_id, peer, conversation_id, name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, peer) DO UPDATE SET conversation_id = EXCLUDED.conversation_id, name = COALESCE(EXCLUDED.name, zernio_threads.name), updated_at = now()`,
    [accountId, peer, conversationId, name],
  );
}

const textOf = (msg: any, meta: any) => String(msg?.text || meta?.postbackTitle || meta?.quickReplyPayload || '').trim();
const filesOf = (msg: any) => (Array.isArray(msg?.attachments) ? msg.attachments : []).map((a: any) => ({ name: String(a?.payload?.title || a?.type || 'file'), type: String(a?.mimeType || a?.type || 'file'), size: 0, ...(/^https:\/\//.test(String(a?.url || '')) ? { ref: String(a.url) } : {}) }));

/**
 * One Zernio webhook delivery, already signed off. The store is the profile's externalId (toran-store-<id>); the account
 * must be that store's own, connected here through Zernio. Never throws for a delivery we do not take: it says why.
 */
export async function zernioWebhook(app: App, body: any): Promise<{ action: string }> {
  const name = String(body?.event || '');
  // A store template's review (whatsapp.template.status_updated, .category_updated): Zernio says which account, and
  // may name no profile, so it is matched by the account connected here through Zernio.
  if (name === 'whatsapp.template.status_updated' || name === 'whatsapp.template.category_updated') return zernioTemplateNews(app, body);
  const storeId = storeOfExternalId(Array.isArray(body?.profiles) ? body.profiles[0]?.externalId : null);
  if (!storeId) return { action: 'not_ours' };
  if (name === 'account.connected') {
    const channel = channelOfPlatform(body?.account?.platform);
    const accountId = String(body?.account?.accountId || '');
    if (!channel || !accountId) return { action: 'ignored' };
    await enqueue(app.db, 'zernio_account', { storeId, channel, accountId }, { dedupeKey: `zernio_account:${accountId}`, maxAttempts: 2 });
    return { action: 'connect_queued' };
  }
  const accountId = String(body?.account?.accountId || body?.account?.id || '').toLowerCase();
  const channel = channelOfPlatform(body?.account?.platform || body?.message?.platform);
  if (!accountId || !channel) return { action: 'ignored' };
  const a = await app.db.one<{ id: number; store_id: number; status: string }>("SELECT id, store_id, status FROM channel_accounts WHERE channel = $1 AND kind = 'zernio' AND external_id = $2 AND status <> 'off'", [channel, accountId]);
  if (!a || a.store_id !== storeId) return { action: 'unknown_account' };
  if (name === 'account.disconnected') {
    // A WhatsApp number waits to be connected again, as one of Kapso's or Meta's does (status reconnect: the store's
    // page and Today say so); a Page or an Instagram account is in error.
    const wa = channel === 'whatsapp';
    await app.db.query(`UPDATE channel_accounts SET status = '${wa ? 'reconnect' : 'error'}', meta = meta || $2::jsonb WHERE id = $1`, [a.id, J({ why: 'disconnected' })]);
    await event(app.db, storeId, `${LEDGER[channel].tag}_${wa ? 'reconnect' : 'error'}`, { accountId: a.id, why: 'disconnected', via: 'zernio' });
    await alertOperator(app, `zernio_gone:${storeId}:${channel}`, `תורן: ה${CHANNEL_HE[channel]} של חנות ${storeId} התנתק`, `Zernio אומר שה${wa ? 'מספר' : 'חשבון'} התנתק. תורן לא עונה בו עד שהחנות מחברת אותו שוב בדף הערוץ שלה.`, { storeId, everyMinutes: 24 * 60 }).catch(() => {});
    return { action: wa ? 'reconnect' : 'error' };
  }
  if (name === 'conversation.control_changed') {
    await event(app.db, storeId, `${LEDGER[channel].tag}_control`, { accountId: a.id, conversation: String(body?.conversation?.id || '').slice(0, 60) });
    return { action: 'noted' };
  }
  if (!enabledChannels(app.env).has(channel) || a.status !== 'active') return { action: 'channel_off' };
  const msg = body?.message || {};
  const conversationId = String(msg.conversationId || body?.conversation?.id || '');
  const mid = String(msg.platformMessageId || '');
  if (name === 'message.received' && channel === 'whatsapp') {
    // The sender's id is the phone without the + (or Meta's business-scoped id while the phone is hidden).
    const raw = String(msg?.sender?.id || body?.conversation?.participantId || '');
    const peer = /^\+?\d{6,}$/.test(raw) ? digits(raw) : raw;
    if (!peer || !mid) return { action: 'ignored' };
    await keepThread(app, a.id, peer, conversationId, String(msg?.sender?.name || body?.conversation?.participantName || '') || null);
    const meta = body?.metadata || {};
    // Toran keeps no WhatsApp files (policy.ts): a picture with no words is said in the inbox as one.
    const text = textOf(msg, meta) || (Array.isArray(msg?.attachments) && msg.attachments.length ? '(קובץ)' : '');
    const inbound: Inbound = { channel: 'whatsapp', from: peer, text, id: mid, account: accountId, profileName: String(msg?.sender?.name || '') || null, ...(meta?.standby ? { automated: 'standby' } : {}) };
    await enqueue(app.db, 'wa_inbound', { ...inbound, at: Date.now() }, { dedupeKey: `wa:${mid}` });
    return { action: 'queued' };
  }
  if (name === 'message.received') {
    const peer = String(msg?.sender?.id || body?.conversation?.participantId || '');
    if (!peer || !mid) return { action: 'ignored' };
    await keepThread(app, a.id, peer, conversationId, String(msg?.sender?.name || body?.conversation?.participantName || '') || null);
    const meta = body?.metadata || {};
    const files = filesOf(msg);
    // standby: another app (Page Inbox, Meta's own agent) holds this conversation, so an answer from Toran would be
    // refused; the message is kept for the owner, unanswered.
    const inbound: Inbound = { channel, from: peer, text: textOf(msg, meta), id: mid, account: accountId, profileName: String(msg?.sender?.name || '') || null, ...(files.length ? { attachments: files } : {}), ...(meta?.standby ? { automated: 'standby' } : {}) };
    await enqueue(app.db, 'dm_inbound', { ...inbound, at: Date.now() }, { dedupeKey: `dm:${mid}` });
    return { action: 'queued' };
  }
  if (name === 'message.sent' && channel === 'whatsapp') {
    const raw = String(body?.conversation?.participantId || '');
    const peer = /^\+?\d{6,}$/.test(raw) ? digits(raw) : raw;
    if (peer) await keepThread(app, a.id, peer, conversationId, String(body?.conversation?.participantName || '') || null);
    // WhatsApp says where the send came from (message.source): whatsapp_business_app is the phone (the owner, on a
    // coexistence number); cloud_api is ours or Zernio's; meta_business_agent is Meta's own agent on the number.
    const source = String(msg?.source || '');
    if (source !== 'whatsapp_business_app') return { action: source === 'meta_business_agent' ? 'meta_agent' : 'ours' };
    if (!peer || !mid) return { action: 'ignored' };
    const sentAt = Date.parse(String(msg?.sentAt || '')) || Date.now();
    await enqueue(app.db, 'zernio_echo', { channel, account: accountId, to: peer, id: mid, text: String(msg?.text || '').trim(), sentAt }, { dedupeKey: `zernio_echo:${mid}`, runAt: new Date(Date.now() + 5_000) });
    return { action: 'echo_queued' };
  }
  if (name === 'message.sent') {
    const peer = String(body?.conversation?.participantId || '');
    if (peer) await keepThread(app, a.id, peer, conversationId, String(body?.conversation?.participantName || '') || null);
    // Only what was not sent through Zernio (sentVia null: "one typed in the platform's own app") or by a person in
    // Zernio's own inbox is the owner's; ours (api) and Zernio's automations are not.
    const via = msg?.sentVia ?? null;
    if (via !== null && via !== 'human') return { action: 'ours' };
    if (!peer || !mid) return { action: 'ignored' };
    const sentAt = Date.parse(String(msg?.sentAt || '')) || Date.now();
    await enqueue(app.db, 'zernio_echo', { channel, account: accountId, to: peer, id: mid, text: String(msg?.text || '').trim(), sentAt }, { dedupeKey: `zernio_echo:${mid}`, runAt: new Date(Date.now() + 5_000) });
    return { action: 'echo_queued' };
  }
  return { action: 'ignored' };
}

/** An answer sent this soon after the customer's message is the Page's instant reply or away message, not a person. */
export const AUTO_REPLY_SECONDS = 20;

/**
 * The worker's half of an echo: an answer this soon after the customer's own message is Meta's automated reply (an
 * instant reply, an away message: Zernio gives those sentVia null too) and leaves Toran answering; any other is the
 * owner's, and Toran steps back (socialEcho).
 */
export async function zernioEcho(app: App, p: { channel: ZChannel; account: string; to: string; id: string; text: string; sentAt: number }) {
  const a = await app.db.one<{ id: number }>("SELECT id FROM channel_accounts WHERE channel = $1 AND kind = 'zernio' AND external_id = $2 AND status = 'active'", [p.channel, p.account]);
  if (!a) return { action: 'unknown_account' };
  const last = await app.db.one<{ at: string | null }>("SELECT MAX(m.at) AS at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.account_id = $1 AND c.peer = $2 AND m.role = 'customer'", [a.id, p.to]);
  const lastAt = last?.at ? Date.parse(last.at) : 0;
  if (lastAt && p.sentAt >= lastAt && p.sentAt - lastAt < AUTO_REPLY_SECONDS * 1000) {
    app.log(`[zernio] an answer ${Math.round((p.sentAt - lastAt) / 1000)}s after the customer's message, taken for the ${p.channel === 'whatsapp' ? "app's greeting or away message" : "Page's own automated reply"}: Toran keeps answering`);
    return { action: 'auto_reply' };
  }
  // The owner on the WhatsApp Business app: their answer in the inbox, and Toran steps back, as for Meta's own echo.
  if (p.channel === 'whatsapp') return ownerEcho(app, { account: p.account, to: p.to, id: p.id, text: p.text, at: p.sentAt });
  return socialEcho(app, { channel: p.channel, account: p.account, to: p.to, id: p.id, text: p.text, appId: null, at: p.sentAt });
}

/** A store template's review, from Zernio's webhook, matched by the WhatsApp account connected here through Zernio. */
async function zernioTemplateNews(app: App, body: any): Promise<{ action: string }> {
  const accountId = String(body?.account?.accountId || '').toLowerCase();
  const t = body?.template || {};
  if (!accountId || !t?.name) return { action: 'ignored' };
  const a = await app.db.one<{ id: number; store_id: number }>("SELECT id, store_id FROM channel_accounts WHERE channel = 'whatsapp' AND kind = 'zernio' AND external_id = $1 AND status <> 'off'", [accountId]);
  if (!a) return { action: 'unknown_account' };
  const status = body?.event === 'whatsapp.template.status_updated' && t.status ? String(t.status).toUpperCase() : null;
  const category = t.category || t.newCategory ? String(t.category || t.newCategory).toUpperCase() : null;
  const why = t.reason && t.reason !== 'NONE' ? String(t.reason).slice(0, 300) : null;
  const rows = await app.db.query<{ name: string }>('UPDATE wa_templates SET status = COALESCE($3, status), category = COALESCE($4, category), why = CASE WHEN $3::text IS NULL THEN why ELSE $5 END, checked_at = now() WHERE account_id = $1 AND name = $2 RETURNING name', [a.id, String(t.name), status, category, why]);
  if (rows.length) await event(app.db, a.store_id, 'wa_template_status', { name: String(t.name), status, category });
  return { action: rows.length ? 'template' : 'unknown_template' };
}

// ---- a store's WhatsApp templates through Zernio (auto/templates.ts, auto/send.ts)

/** Submit one of Toran's templates (Meta's own template body) to the store's WhatsApp account through Zernio. */
export async function zernioCreateTemplate(app: App, accountExt: string, req: Record<string, unknown>): Promise<{ id: string | null; status: string; category: string | null }> {
  const out = await api(app, 'POST', 'whatsapp/templates', { body: { accountId: accountExt, ...req } });
  const t = out?.template || {};
  return { id: String(t.id || '') || null, status: String(t.status || 'PENDING').toUpperCase(), category: t.category ? String(t.category).toUpperCase() : null };
}

/** The store's templates of this name (every language), as Zernio reads them from WhatsApp, in Meta's own shape ({data}). */
export async function zernioTemplatesNamed(app: App, accountExt: string, name: string): Promise<{ data: any[] }> {
  const out = await api(app, 'GET', `whatsapp/templates?${new URLSearchParams({ accountId: accountExt, name }).toString()}`);
  return { data: Array.isArray(out?.templates) ? out.templates : [] };
}

/**
 * One of the store's approved templates to a customer's phone (POST /v1/inbox/conversations: it opens the thread when
 * there is none, and goes into it when there is). The template's variables in their order: the body's, then the
 * button's link (Zernio: "text header, body and dynamic URL buttons, in that order").
 */
export async function zernioTemplateSend(app: App, account: { id: number; external_id: string }, phone: string, name: string, params: string[], buttonParam?: string | null): Promise<{ id: string }> {
  const out = await api(app, 'POST', 'inbox/conversations', {
    body: { accountId: account.external_id, participantId: digits(phone), templateName: name, templateLanguage: 'he', templateParams: [...params, ...(buttonParam ? [buttonParam] : [])] },
  });
  if (out?.success === false) throw new GraphError(`Zernio did not send the template: ${String(out?.error || out?.message || '').slice(0, 200)}`, 200, null);
  const conversationId = String(out?.data?.conversationId || '');
  if (conversationId) await keepThread(app, account.id, digits(phone), conversationId, null);
  return { id: String(out?.data?.messageId || '') };
}

// ---- one connected Page or Instagram account, as a channel adapter

export type ZernioAccount = { id: number; channel: ZChannel; external_id: string };

const CHANNEL_HE: Record<ZChannel, string> = { messenger: 'מסנג׳ר', instagram: 'אינסטגרם', whatsapp: 'וואטסאפ' };

export function zernioAdapter(app: App, account: ZernioAccount): ChannelAdapter & { profile(peer: string): Promise<string | null> } {
  return {
    channel: account.channel,
    kind: 'zernio',
    limits: LIMITS[account.channel],
    inboundUsd: 0,
    parse: () => null, // the one webhook is /zernio/webhook (zernioWebhook), not an adapter's
    async fetchFile(_inbound, file, max) {
      return file.ref ? download(app.graph, file.ref, max) : null;
    },
    async send(to: string, text: string, _inReplyTo: Inbound, ctx?: SendCtx): Promise<Sent> {
      const t = await app.db.one<{ conversation_id: string }>('SELECT conversation_id FROM zernio_threads WHERE account_id = $1 AND peer = $2', [account.id, to]);
      if (!t) throw new GraphError(`no Zernio conversation for this customer of account ${account.id}`, 0, null);
      // HUMAN_AGENT is Messenger's and Instagram's; WhatsApp has no tag (past its 24 hours only a template goes).
      const body = { accountId: account.external_id, message: text, ...(ctx?.tag && account.channel !== 'whatsapp' ? { messagingType: 'MESSAGE_TAG', messageTag: ctx.tag } : {}) };
      const out = await api(app, 'POST', `inbox/conversations/${encodeURIComponent(t.conversation_id)}/messages`, { body });
      if (out?.success === false) throw new GraphError(`Zernio did not send: ${String(out?.error || out?.message || '').slice(0, 200)}`, 200, null);
      return { id: String(out?.data?.messageId || ''), usd: 0 };
    },
    /** The customer's name as Zernio gave it (participantName), for the inbox. */
    async profile(peer: string): Promise<string | null> {
      const t = await app.db.one<{ name: string | null }>('SELECT name FROM zernio_threads WHERE account_id = $1 AND peer = $2', [account.id, peer]);
      return t?.name ? String(t.name).slice(0, 80) : null;
    },
    ack: () => ({ type: 'text/plain; charset=utf-8', body: 'ok' }),
  };
}
