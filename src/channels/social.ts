import { secretsReady, open } from '../core/secrets.ts';
import { enabledChannels } from './config.ts';
import { download } from './files.ts';
import { GraphError, metaSettings, type GraphFetch } from './meta.ts';
import { LIMITS } from './policy.ts';
import type { ChannelAdapter, Inbound, Sent, SendCtx } from './types.ts';

// Messenger and Instagram, through the same Meta app as WhatsApp (meta.ts), behind the TORAN_CHANNELS flag.
// docs/connecting-channels.md has the setup at Meta.
//
//   connecting   the store presses "לחבר", and is sent to Meta's login (authorizeUrl), which comes back to
//                /meta/oauth/<channel> with a code. Messenger is Facebook Login: the code becomes the person's token,
//                that a long-lived one, and that the token of each Page they manage (pages()); the store picks its
//                Page, and the Page is subscribed to our app (subscribePage). Instagram is the Instagram API with
//                Instagram Login (an Instagram professional account, no Facebook Page needed): the code becomes a
//                60-day token (instagramToken), refreshed by the worker before it ends (refreshInstagram).
//   receiving    the one webhook, /meta/webhook, for every store and channel: X-Hub-Signature-256 as for WhatsApp.
//                parseSocial() reads object "page" (Messenger) and "instagram": the customers' messages, and the
//                owner's own answers from the Page's inbox or the Instagram app (echoes).
//   sending      dmAdapter() is the channel adapter of one connected Page or account: Meta's Send API with the
//                account's token, inside the 24 hours (policy.ts); past them only the owner's answer, tagged
//                HUMAN_AGENT, once Meta approved it.
//
// Meta charges nothing for these messages, so usage records $0.

type Env = Record<string, string | undefined>;
export type Social = 'messenger' | 'instagram';
export const SOCIAL: readonly Social[] = ['messenger', 'instagram'];
export const isSocial = (c: unknown): c is Social => c === 'messenger' || c === 'instagram';

/** What Messenger's login asks for: the Pages, messaging on them, and subscribing them to our webhook. */
export const MESSENGER_SCOPES = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata'];
export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];

export const socialSettings = (env: Env) => ({
  ...metaSettings(env),
  /** Facebook Login for Business: the configuration made for Messenger (its permissions are set there, not in scope). */
  fbConfigId: String(env.META_FB_CONFIG_ID || '').trim(),
  /** The Instagram app's own id and secret (the app's Instagram, "API setup with Instagram login"). */
  igAppId: String(env.META_IG_APP_ID || '').trim(),
  igAppSecret: String(env.META_IG_APP_SECRET || '').trim(),
  base: String(env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
});

/** May a store connect this channel now? Its code on, the app's settings, our public address, and the key that seals tokens. */
export function socialReady(env: Env, channel: Social): boolean {
  const m = socialSettings(env);
  if (!enabledChannels(env).has(channel) || !secretsReady(env)) return false;
  if (!m.appId || !m.appSecret || !m.verifyToken || !/^https?:\/\//.test(m.base)) return false;
  return channel === 'messenger' || Boolean(m.igAppId && m.igAppSecret);
}

export const redirectUri = (env: Env, channel: Social) => `${socialSettings(env).base}/meta/oauth/${channel}`;

/** Where the store is sent to log in; Meta sends it back to redirectUri() with the code and our state. */
export function authorizeUrl(env: Env, channel: Social, state: string): string {
  const m = socialSettings(env);
  if (channel === 'instagram') {
    const u = new URL('https://www.instagram.com/oauth/authorize');
    u.search = new URLSearchParams({ client_id: m.igAppId, redirect_uri: redirectUri(env, channel), response_type: 'code', scope: INSTAGRAM_SCOPES.join(','), state }).toString();
    return u.toString();
  }
  const u = new URL(`https://www.facebook.com/${m.version}/dialog/oauth`);
  u.search = new URLSearchParams({ client_id: m.appId, redirect_uri: redirectUri(env, channel), response_type: 'code', state, ...(m.fbConfigId ? { config_id: m.fbConfigId } : { scope: MESSENGER_SCOPES.join(',') }) }).toString();
  return u.toString();
}

// ---- Meta's APIs: graph.facebook.com for Messenger, graph.instagram.com and api.instagram.com for Instagram

type Call = { token?: string; query?: Record<string, string>; body?: unknown; form?: Record<string, string> };

async function call(f: GraphFetch, method: 'GET' | 'POST' | 'DELETE', url: string, { token, query = {}, body, form }: Call = {}): Promise<any> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const headers: Record<string, string> = { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload: string | undefined;
  if (body) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  } else if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  }
  const res = await f(u.toString(), { method, headers, ...(payload ? { body: payload } : {}), signal: AbortSignal.timeout(15_000) });
  const out: any = await res.json().catch(() => ({}));
  // The path only: a token in the query never reaches a log line.
  if (!res.ok || out?.error) throw new GraphError(`Meta refused ${method} ${u.host}${u.pathname} (${res.status}${out?.error?.code ? `, code ${out.error.code}` : ''}): ${String(out?.error?.message || out?.error_message || '').slice(0, 200)}`, res.status, out?.error?.code ?? out?.code ?? null);
  return out;
}

const fb = (env: Env, path: string) => `https://graph.facebook.com/${metaSettings(env).version}/${path.replace(/^\//, '')}`;
const ig = (env: Env, path: string) => `https://graph.instagram.com/${metaSettings(env).version}/${path.replace(/^\//, '')}`;

export type Page = { id: string; name: string; token: string };

/** Messenger's login code, for the Pages the person manages, each with its own token (one that does not expire). */
export async function messengerPages(env: Env, f: GraphFetch, code: string): Promise<{ user: string | null; pages: Page[] }> {
  const m = socialSettings(env);
  const short = await call(f, 'GET', fb(env, 'oauth/access_token'), { query: { client_id: m.appId, client_secret: m.appSecret, redirect_uri: redirectUri(env, 'messenger'), code } });
  if (!short?.access_token) throw new GraphError('Meta gave no access token for the code', 200, null);
  const long = await call(f, 'GET', fb(env, 'oauth/access_token'), { query: { grant_type: 'fb_exchange_token', client_id: m.appId, client_secret: m.appSecret, fb_exchange_token: String(short.access_token) } });
  const token = String(long?.access_token || short.access_token);
  const me = await call(f, 'GET', fb(env, 'me'), { token, query: { fields: 'id' } }).catch(() => null);
  const out = await call(f, 'GET', fb(env, 'me/accounts'), { token, query: { fields: 'id,name,access_token,tasks', limit: '100' } });
  // A Page they can answer messages on: its token, and a task that includes messaging.
  const pages = (Array.isArray(out?.data) ? out.data : [])
    .filter((p: any) => p?.id && p?.access_token && (!Array.isArray(p.tasks) || p.tasks.some((t: string) => ['MANAGE', 'MODERATE', 'MESSAGING'].includes(t))))
    .map((p: any) => ({ id: String(p.id), name: String(p.name || p.id), token: String(p.access_token) }));
  return { user: me?.id ? String(me.id) : null, pages };
}

/** Ask Meta to send this Page's messages, and the owner's own answers on it, to our webhook. */
export const subscribePage = (env: Env, f: GraphFetch, pageId: string, token: string) => call(f, 'POST', fb(env, `${pageId}/subscribed_apps`), { token, query: { subscribed_fields: 'messages,messaging_postbacks,message_echoes' } });
export const unsubscribePage = (env: Env, f: GraphFetch, pageId: string, token: string) => call(f, 'DELETE', fb(env, `${pageId}/subscribed_apps`), { token });

export type IgAccount = { id: string; username: string | null; name: string | null; token: string; expiresAt: string | null };

const expiry = (seconds: unknown) => (Number(seconds) > 0 ? new Date(Date.now() + Number(seconds) * 1000).toISOString() : null);

/** Instagram's login code, for the account's long-lived token (60 days) and who the account is. */
export async function instagramAccount(env: Env, f: GraphFetch, code: string): Promise<IgAccount> {
  const m = socialSettings(env);
  const short = await call(f, 'POST', 'https://api.instagram.com/oauth/access_token', { form: { client_id: m.igAppId, client_secret: m.igAppSecret, grant_type: 'authorization_code', redirect_uri: redirectUri(env, 'instagram'), code } });
  const first = Array.isArray(short?.data) ? short.data[0] : short;
  if (!first?.access_token) throw new GraphError('Instagram gave no access token for the code', 200, null);
  const long = await call(f, 'GET', 'https://graph.instagram.com/access_token', { query: { grant_type: 'ig_exchange_token', client_secret: m.igAppSecret, access_token: String(first.access_token) } });
  const token = String(long?.access_token || first.access_token);
  // user_id is the professional account's id, the one Meta's webhooks name as the account written to.
  const me = await call(f, 'GET', ig(env, 'me'), { query: { fields: 'user_id,username,name', access_token: token } });
  const id = String(me?.user_id || first.user_id || '');
  if (!id) throw new GraphError('Instagram did not say which account this is', 200, null);
  return { id, username: me?.username ? String(me.username) : null, name: me?.name ? String(me.name) : null, token, expiresAt: expiry(long?.expires_in) };
}

/** Ask Meta to send this Instagram account's messages to our webhook. */
export const subscribeInstagram = (env: Env, f: GraphFetch, token: string) => call(f, 'POST', ig(env, 'me/subscribed_apps'), { query: { subscribed_fields: 'messages,messaging_postbacks', access_token: token } });
export const unsubscribeInstagram = (env: Env, f: GraphFetch, token: string) => call(f, 'DELETE', ig(env, 'me/subscribed_apps'), { query: { access_token: token } });

/** A fresh 60 days for an Instagram token (it has to be at least a day old and still valid). */
export async function refreshInstagramToken(f: GraphFetch, token: string): Promise<{ token: string; expiresAt: string | null }> {
  const out = await call(f, 'GET', 'https://graph.instagram.com/refresh_access_token', { query: { grant_type: 'ig_refresh_token', access_token: token } });
  if (!out?.access_token) throw new GraphError('Instagram gave no refreshed token', 200, null);
  return { token: String(out.access_token), expiresAt: expiry(out.expires_in) };
}

// ---- the webhook

/** An answer someone sent from the store's own Page inbox or Instagram app (or our own send, coming back as an echo). */
export type DmEcho = { channel: Social; account: string; to: string; id: string; text: string; appId: string | null; at: number };

const textOf = (msg: any) => String(msg?.text || '').trim();
// A photo or a file the customer sent: Meta gives its kind and a link to it on its CDN (ref), which needs no token.
const filesOf = (msg: any) => (Array.isArray(msg?.attachments) ? msg.attachments : []).map((a: any) => ({ name: String(a?.payload?.title || a?.type || 'file'), type: String(a?.type || 'file'), size: 0, ...(/^https:\/\//.test(String(a?.payload?.url || '')) ? { ref: String(a.payload.url) } : {}) }));

/** Everything one webhook call for Messenger or Instagram carries. Anything else (WhatsApp's) is meta.ts's. */
export function parseSocial(body: any): { channel: Social | null; messages: Inbound[]; echoes: DmEcho[] } {
  const channel: Social | null = body?.object === 'page' ? 'messenger' : body?.object === 'instagram' ? 'instagram' : null;
  const messages: Inbound[] = [];
  const echoes: DmEcho[] = [];
  if (!channel) return { channel, messages, echoes };
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    const account = String(entry?.id || '');
    if (!account) continue;
    // Real deliveries come as entry.messaging; the app dashboard's test sends come as changes with field "messages".
    const events = [...(Array.isArray(entry.messaging) ? entry.messaging : []), ...(Array.isArray(entry.changes) ? entry.changes.filter((c: any) => c?.field === 'messages').map((c: any) => c.value) : [])];
    for (const ev of events) {
      const sender = String(ev?.sender?.id || '');
      const recipient = String(ev?.recipient?.id || '');
      const at = Number(ev?.timestamp) > 1e12 ? Number(ev.timestamp) : Number(ev?.timestamp) > 0 ? Number(ev.timestamp) * 1000 : Date.now();
      const msg = ev?.message;
      if (msg?.is_echo) {
        if (recipient && msg.mid) echoes.push({ channel, account, to: recipient, id: String(msg.mid), text: textOf(msg), appId: msg.app_id ? String(msg.app_id) : null, at });
        continue;
      }
      if (!sender || sender === account) continue;
      if (msg?.mid && !msg.is_deleted && !msg.is_unsupported) {
        const files = filesOf(msg);
        messages.push({ channel, from: sender, text: textOf(msg), id: String(msg.mid), account, ...(files.length ? { attachments: files } : {}) });
      } else if (ev?.postback) {
        // A button the customer tapped (the "Get started" one): its title is what they said.
        messages.push({ channel, from: sender, text: String(ev.postback.title || ev.postback.payload || '').trim(), id: String(ev.postback.mid || `postback:${sender}:${at}`), account });
      }
    }
  }
  return { channel, messages, echoes };
}

// ---- one connected Page or Instagram account, as a channel adapter

export type SocialAccount = { id: number; channel: Social; external_id: string; secret: string | null; meta: any };

export function dmAdapter(env: Env, f: GraphFetch, account: SocialAccount): ChannelAdapter & { profile(peer: string): Promise<string | null> } {
  const token = () => {
    if (!account.secret) throw new Error(`the ${account.channel} account ${account.id} has no token: it was disconnected`);
    return open(env, account.secret);
  };
  const messenger = account.channel === 'messenger';
  return {
    channel: account.channel,
    kind: 'meta',
    limits: LIMITS[account.channel],
    inboundUsd: 0,
    parse: () => null, // the one webhook is /meta/webhook (parseSocial), not an adapter's
    async fetchFile(_inbound, file, max) {
      return file.ref ? download(f, file.ref, max) : null;
    },
    async send(to: string, text: string, _inReplyTo: Inbound, ctx?: SendCtx): Promise<Sent> {
      const tagged = ctx?.tag ? { messaging_type: 'MESSAGE_TAG', tag: ctx.tag } : { messaging_type: 'RESPONSE' };
      const body = { recipient: { id: to }, ...tagged, message: { text } };
      const out = messenger
        ? await call(f, 'POST', fb(env, `${account.external_id}/messages`), { token: token(), body })
        : await call(f, 'POST', ig(env, `${account.external_id}/messages`), { query: { access_token: token() }, body });
      return { id: String(out?.message_id || ''), usd: 0 };
    },
    /** The customer's name as Meta gives it to the store, for the inbox; null when Meta does not say. */
    async profile(peer: string): Promise<string | null> {
      try {
        if (messenger) {
          const p = await call(f, 'GET', fb(env, peer), { token: token(), query: { fields: 'first_name,last_name' } });
          return [p?.first_name, p?.last_name].filter(Boolean).join(' ').trim() || null;
        }
        const p = await call(f, 'GET', ig(env, peer), { query: { fields: 'name,username', access_token: token() } });
        return String(p?.name || (p?.username ? `@${p.username}` : '')).trim() || null;
      } catch {
        return null;
      }
    },
    ack: () => ({ type: 'text/plain; charset=utf-8', body: 'ok' }),
  };
}
