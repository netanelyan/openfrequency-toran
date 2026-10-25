import { createHmac, timingSafeEqual } from 'node:crypto';
import { toIntl } from '../core/urls.ts';
import { open } from '../core/secrets.ts';
import { LIMITS } from './policy.ts';
import type { ChannelAdapter, Inbound, Sent } from './types.ts';
import type { WaOut } from './whatsapp.ts';

// Meta, directly: a store's own WhatsApp number through the WhatsApp Cloud API (Instagram and Messenger come through
// the same app later). docs/connecting-channels.md has the setup.
//
//   connecting   the store presses "לחבר וואטסאפ", Meta's Embedded Signup opens in a popup, and the store connects the
//                number it already has on the WhatsApp Business app (coexistence: the app keeps working on the
//                phone). The popup gives a code and the number's ids; exchangeCode() turns the code into the store's
//                token, subscribeApp() asks Meta to send its messages to our webhook, phoneInfo() reads its status.
//   receiving    one webhook for every store, GET /meta/webhook to verify it and POST with X-Hub-Signature-256 (an
//                HMAC-SHA256 of the raw body under the app secret). parseWebhook() reads the customers' messages,
//                the owner's own messages from the phone (coexistence echoes), delivery reports and account changes.
//   sending      waAccountAdapter() is the channel adapter of one connected number: POST /<phone id>/messages with the
//                store's token, inside the 24-hour window that send.ts checks before every send. Our own demo
//                number and owner line send the same way, when they are on Meta (lines.ts).
//   the token    debugToken() says when it ends; lastingToken() and refreshToken() keep it on (waStore.ts)
//
// Meta charges nothing for a reply inside the customer's 24 hours (a service message), so usage records $0.

type Env = Record<string, string | undefined>;
export type GraphFetch = typeof fetch;

export const metaSettings = (env: Env) => ({
  appId: String(env.META_APP_ID || '').trim(),
  appSecret: String(env.META_APP_SECRET || '').trim(),
  configId: String(env.META_WA_CONFIG_ID || '').trim(),
  verifyToken: String(env.META_WEBHOOK_VERIFY_TOKEN || '').trim(),
  version: /^v\d+\.\d+$/.test(String(env.META_GRAPH_VERSION || '').trim()) ? String(env.META_GRAPH_VERSION).trim() : 'v23.0',
});

/** May a store connect its WhatsApp now? Every Meta setting and the key that seals the token. */
export function waConnectReady(env: Env): boolean {
  const m = metaSettings(env);
  return Boolean(m.appId && m.appSecret && m.configId && m.verifyToken) && String(env.TORAN_SECRETS_KEY || '').trim().length >= 32;
}

export class GraphError extends Error {
  status: number;
  code: number | null;
  constructor(message: string, status: number, code: number | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function graph(env: Env, f: GraphFetch, method: 'GET' | 'POST' | 'DELETE', path: string, { token, query = {}, body }: { token?: string; query?: Record<string, string>; body?: unknown } = {}): Promise<any> {
  const url = new URL(`https://graph.facebook.com/${metaSettings(env).version}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await f(url.toString(), {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), accept: 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const out: any = await res.json().catch(() => ({}));
  // The subcode and Meta's own sentence for a person say what a bare code does not (a template's name already taken).
  if (!res.ok || out?.error) throw new GraphError(`Meta refused ${method} ${url.pathname} (${res.status}${out?.error?.code ? `, code ${out.error.code}${out.error.error_subcode ? `/${out.error.error_subcode}` : ''}` : ''}): ${String(out?.error?.error_user_msg || out?.error?.message || '').slice(0, 200)}`, res.status, out?.error?.code ?? null);
  return out;
}

/** Embedded Signup's code, for the business token of the store that connected (valid for this app only). */
export async function exchangeCode(env: Env, f: GraphFetch, code: string): Promise<string> {
  const m = metaSettings(env);
  const out = await graph(env, f, 'GET', 'oauth/access_token', { query: { client_id: m.appId, client_secret: m.appSecret, code } });
  if (!out?.access_token) throw new GraphError('Meta gave no access token for the code', 200, null);
  return String(out.access_token);
}

// ---- the store's token, and how long it lasts
//
// Embedded Signup's code becomes a business integration system user token. How long it lasts is the configuration's
// (META_WA_CONFIG_ID) choice: Meta's template "WhatsApp Embedded Signup Configuration With 60 Expiration Token" gives
// one that ends after 60 days; a configuration made by hand (login variation "WhatsApp Embedded Signup", a
// system-user access token) can choose "Never". debug_token says which one a store has, and when it ends.
//
// Before a 60-day token ends there are two ways to keep the number on, both tried by the worker (waStore.ts):
//   lasting      POST /<the store's business>/system_user_access_tokens, Meta's call for a new token from the one we
//                hold, which never expires unless asked to. It takes business_management, which the token has only
//                when the configuration asked for it, and the store's business id
//   refresh      GET /oauth/access_token with grant_type fb_exchange_token and set_token_expires_in_60_days, Meta's
//                refresh of an expiring system user token: another 60 days, while the old one is still valid
// When neither works, the store connects again (the dashboard asks from 10 days before the end).

export type TokenInfo = {
  valid: boolean;
  issuedAt: string | null;
  expiresAt: string | null; // null: it never expires
  dataAccessUntil: string | null;
  scopes: string[];
  business: string | null; // the business that business_management covers, when it does
};

const secondsToIso = (s: unknown) => (Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null);

/** What Meta says about a token: debug_token, asked with the app's own token. */
export async function debugToken(env: Env, f: GraphFetch, token: string): Promise<TokenInfo> {
  const m = metaSettings(env);
  const out = await graph(env, f, 'GET', 'debug_token', { token: `${m.appId}|${m.appSecret}`, query: { input_token: token } });
  const d = out?.data || {};
  const granular = Array.isArray(d.granular_scopes) ? d.granular_scopes : [];
  const bm = granular.find((g: any) => g?.scope === 'business_management');
  return {
    valid: d.is_valid === true,
    issuedAt: secondsToIso(d.issued_at),
    // 0 is Meta's word for never.
    expiresAt: secondsToIso(d.expires_at),
    dataAccessUntil: secondsToIso(d.data_access_expires_at),
    scopes: Array.isArray(d.scopes) ? d.scopes.map(String) : [],
    business: bm?.target_ids?.[0] ? String(bm.target_ids[0]) : null,
  };
}

/** appsecret_proof: the token's HMAC-SHA256 under the app secret, which some calls about a client's business ask for. */
export const appSecretProof = (appSecret: string, token: string) => createHmac('sha256', appSecret).update(token).digest('hex');

/** A token that never expires, made from the one we hold, for the store's own business (see above). */
export async function lastingToken(env: Env, f: GraphFetch, businessId: string, token: string): Promise<string> {
  const out = await graph(env, f, 'POST', `${businessId}/system_user_access_tokens`, { token, query: { appsecret_proof: appSecretProof(metaSettings(env).appSecret, token) } });
  if (!out?.access_token) throw new GraphError('Meta gave no token for the business', 200, null);
  return String(out.access_token);
}

/** Another 60 days for an expiring system user token, while it is still valid. */
export async function refreshToken(env: Env, f: GraphFetch, token: string): Promise<string> {
  const m = metaSettings(env);
  const out = await graph(env, f, 'GET', 'oauth/access_token', { query: { grant_type: 'fb_exchange_token', client_id: m.appId, client_secret: m.appSecret, set_token_expires_in_60_days: 'true', fb_exchange_token: token } });
  if (!out?.access_token) throw new GraphError('Meta gave no refreshed token', 200, null);
  return String(out.access_token);
}

/** Meta's code for a token that no longer works: expired, revoked, or the password changed. */
export const TOKEN_GONE = 190;

/** Ask Meta to send this business account's messages to our app's webhook. */
export const subscribeApp = (env: Env, f: GraphFetch, wabaId: string, token: string) => graph(env, f, 'POST', `${wabaId}/subscribed_apps`, { token });
export const unsubscribeApp = (env: Env, f: GraphFetch, wabaId: string, token: string) => graph(env, f, 'DELETE', `${wabaId}/subscribed_apps`, { token });

/** A message template submitted for review on a store's WhatsApp account (auto/templates.ts): Meta's id, status and category. */
export const createTemplate = (env: Env, f: GraphFetch, wabaId: string, token: string, body: unknown): Promise<{ id?: string; status?: string; category?: string }> => graph(env, f, 'POST', `${wabaId}/message_templates`, { token, body });

/** The account's templates of this name, with their status, category and why one was rejected. */
export const templatesNamed = (env: Env, f: GraphFetch, wabaId: string, token: string, name: string): Promise<{ data?: any[] }> =>
  graph(env, f, 'GET', `${wabaId}/message_templates`, { token, query: { name, fields: 'id,name,status,category,language,rejected_reason' } });

export type PhoneInfo = { display_phone_number?: string; verified_name?: string; status?: string; platform_type?: string; name_status?: string; quality_rating?: string; code_verification_status?: string; is_on_biz_app?: boolean };

export const phoneInfo = (env: Env, f: GraphFetch, phoneId: string, token: string): Promise<PhoneInfo> =>
  graph(env, f, 'GET', phoneId, { token, query: { fields: 'display_phone_number,verified_name,status,platform_type,name_status,quality_rating,code_verification_status,is_on_biz_app' } });

/** Where a connected number stands, from Meta's own word for it. */
export function accountState(info: PhoneInfo): { status: 'active' | 'pending' | 'error'; why: string | null } {
  const s = String(info.status || '').toUpperCase();
  if (s === 'CONNECTED') return { status: 'active', why: null };
  if (['BANNED', 'RESTRICTED', 'FLAGGED', 'DISCONNECTED', 'DELETED', 'MIGRATED'].includes(s)) return { status: 'error', why: s };
  return { status: 'pending', why: s || null };
}

// ---- the webhook

/** X-Hub-Signature-256: "sha256=" + hex HMAC-SHA256 of the raw body under the app secret. */
export function signatureOk(appSecret: string, raw: string, header: unknown): boolean {
  if (!appSecret) return false;
  const given = String(header || '');
  const want = `sha256=${createHmac('sha256', appSecret).update(Buffer.from(raw, 'utf8')).digest('hex')}`;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const signBody = (appSecret: string, raw: string) => `sha256=${createHmac('sha256', appSecret).update(Buffer.from(raw, 'utf8')).digest('hex')}`;

/** A message the owner sent from the WhatsApp Business app on their phone (coexistence), to a customer. */
export type Echo = { account: string; to: string; id: string; text: string; at: number };
export type Status = { account: string; id: string; status: string; to: string | null; error: string | null };

const textOf = (m: any): string => {
  switch (m?.type) {
    case 'text':
      return String(m.text?.body || '');
    case 'button':
      return String(m.button?.text || '');
    case 'interactive':
      return String(m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '');
    default:
      return String(m?.[m?.type]?.caption || '');
  }
};
const FILE_TYPES = new Set(['image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts']);

/** Meta's word on one of a store's templates (auto/templates.ts): its status, or the category it moved it to. */
export type TemplateNews = { waba: string; name: string; status: string | null; category: string | null; reason: string | null };

/** Everything one webhook call carries, per kind. Messages from numbers no store has are kept: the router decides. */
export function parseWebhook(body: any): { messages: Inbound[]; echoes: Echo[]; statuses: Status[]; accounts: string[]; templates: TemplateNews[] } {
  const messages: Inbound[] = [];
  const echoes: Echo[] = [];
  const statuses: Status[] = [];
  const templates: TemplateNews[] = [];
  const accounts = new Set<string>();
  if (body?.object !== 'whatsapp_business_account') return { messages, echoes, statuses, accounts: [], templates };
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = ch?.value || {};
      const phoneId = String(v.metadata?.phone_number_id || '');
      if (ch?.field === 'messages' && phoneId) {
        const names = new Map((v.contacts || []).map((c: any) => [String(c.wa_id), c.profile?.name || null]));
        // The number it was written to, as Twilio's webhook says it: our own numbers are routed by it (lines.ts).
        const to = toIntl(String(v.metadata?.display_phone_number || '')) || null;
        for (const m of Array.isArray(v.messages) ? v.messages : []) {
          const from = toIntl(String(m?.from || ''));
          if (!from || !m?.id || ['reaction', 'unsupported', 'system', 'request_welcome'].includes(m.type)) continue;
          messages.push({
            channel: 'whatsapp',
            from,
            text: textOf(m).trim(),
            id: String(m.id),
            profileName: (names.get(String(m.from)) as string) || null,
            account: phoneId,
            to,
            ...(FILE_TYPES.has(m.type) ? { attachments: [{ name: m[m.type]?.filename || m.type, type: m[m.type]?.mime_type || m.type, size: 0 }] } : {}),
          });
        }
        for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
          statuses.push({ account: phoneId, id: String(s?.id || ''), status: String(s?.status || ''), to: s?.recipient_id ? String(s.recipient_id) : null, error: s?.errors?.[0] ? `${s.errors[0].code}: ${String(s.errors[0].title || s.errors[0].message || '').slice(0, 120)}` : null });
        }
      } else if (ch?.field === 'smb_message_echoes' && phoneId) {
        for (const m of Array.isArray(v.message_echoes) ? v.message_echoes : []) {
          const to = toIntl(String(m?.to || ''));
          if (!to || !m?.id) continue;
          echoes.push({ account: phoneId, to, id: String(m.id), text: textOf(m).trim(), at: Number(m.timestamp) ? Number(m.timestamp) * 1000 : Date.now() });
        }
      } else if ((ch?.field === 'message_template_status_update' || ch?.field === 'template_category_update') && entry?.id && v.message_template_name) {
        templates.push({
          waba: String(entry.id),
          name: String(v.message_template_name),
          status: ch.field === 'message_template_status_update' && v.event ? String(v.event) : null,
          category: ch.field === 'template_category_update' && v.new_category ? String(v.new_category) : null,
          reason: v.reason ? String(v.reason) : null,
        });
      } else if (entry?.id) {
        // An account change (its status, its quality, its name): the number's state is read again.
        accounts.add(String(entry.id));
      }
    }
  }
  return { messages, echoes, statuses, accounts: [...accounts], templates };
}

// ---- sending through the Cloud API

/**
 * The Cloud API's body for one message: text, an image with its caption, or an approved template (Hebrew, its body's
 * variables in order). A template is named by the name Meta approved, which WaOut carries in `sid` (Twilio's word).
 */
export function outBody(to: string, msg: WaOut): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  if (msg.template) {
    const vars = msg.template.vars.map((text) => ({ type: 'text', text }));
    return { ...base, type: 'template', template: { name: msg.template.sid, language: { code: 'he' }, ...(vars.length ? { components: [{ type: 'body', parameters: vars }] } : {}) } };
  }
  if (msg.mediaUrl) return { ...base, type: 'image', image: { link: msg.mediaUrl, ...(msg.text ? { caption: msg.text } : {}) } };
  return { ...base, type: 'text', text: { body: msg.text || '', preview_url: false } };
}

/**
 * One message out of a number on the Cloud API. A reply inside the 24 hours costs nothing; a template is billed by
 * Meta to the number's own WhatsApp account, at Meta's rate, which the ledger does not know, so it records $0.
 */
export async function cloudSend(env: Env, f: GraphFetch, phoneId: string, token: string, to: string, msg: WaOut): Promise<Sent> {
  const out = await graph(env, f, 'POST', `${phoneId}/messages`, { token, body: outBody(to, msg) });
  return { id: String(out?.messages?.[0]?.id || ''), usd: 0 };
}

// ---- one connected number, as a channel adapter

export type WaAccount = { id: number; external_id: string; secret: string | null; meta: any };

export function waAccountAdapter(env: Env, f: GraphFetch, account: WaAccount): ChannelAdapter {
  const token = () => {
    if (!account.secret) throw new Error(`the WhatsApp account ${account.id} has no token: it was disconnected`);
    return open(env, account.secret);
  };
  return {
    channel: 'whatsapp',
    kind: 'meta',
    limits: LIMITS.whatsapp,
    inboundUsd: 0,
    parse: () => null, // the one webhook is /meta/webhook (parseWebhook), not an adapter's
    send: (to: string, text: string): Promise<Sent> => cloudSend(env, f, account.external_id, token(), to, { text }),
    ack: () => ({ type: 'text/plain; charset=utf-8', body: 'ok' }),
  };
}
