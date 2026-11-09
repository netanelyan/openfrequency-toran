import { randomBytes, randomUUID } from 'node:crypto';
import type { App } from '../app.ts';
import { J } from '../db/index.ts';
import { audit } from '../db/log.ts';
import { botName } from '../agent/intro.ts';
import { displayName } from '../ingest/brand.ts';
import { lookOf, type Look, type LookChoice } from '../ingest/palette.ts';
import { LIMITS } from './policy.ts';
import type { ChannelAdapter } from './types.ts';

// Toran in a chat on the store's own website (the owner, 2026-11-06, docs/todo.md: "Toran answering inside the store's
// own site, as a chat button in the corner"). The channel 'web', one more of the store's own channels: the same agent,
// the same inbox, the same plan.
//
//   the account   one channel_accounts row a store, channel 'web', turned on by the owner in Settings. Its external_id
//                 is the store's public key ("w" and 20 hex digits): it is in the store's page source, so it names
//                 the store and opens nothing else. meta.domains are the sites allowed to show the chat (the frame's
//                 CSP frame-ancestors): the store's own domain and its www, and the ones the owner adds.
//   a visitor     a random id the chat makes in the visitor's browser (16 bytes, base64url), kept in that frame's own
//                 storage, never a cookie. It is the conversation's peer, so a visitor reads only their own
//                 conversation: there is nothing to ask for but the id, and 128 random bits are not guessed.
//   a message     the frame posts it (web/widget.ts), it is queued as web_inbound and answered like any other
//                 (channels/route.ts, store.ts); "sending" an answer is keeping it, and the frame reads it back.
//
// Nothing here talks to anyone outside: the adapter's send records nothing new (the answer is already a message row,
// written by the agent's turn or the owner's reply) and costs nothing.

export const isKey = (k: string) => /^w[0-9a-f]{20}$/.test(k);
export const isVisitor = (v: string) => /^[A-Za-z0-9_-]{22}$/.test(v);
const newKey = () => `w${randomBytes(10).toString('hex')}`;

export function webAdapter(): ChannelAdapter {
  return {
    channel: 'web',
    kind: 'web',
    limits: LIMITS.web,
    inboundUsd: 0,
    parse: () => null,
    send: async () => ({ id: `web-${randomUUID()}`, usd: 0 }),
    ack: () => ({ type: 'text/plain; charset=utf-8', body: 'ok' }),
  };
}

// meta.look is the owner's own choice for how the chat looks (the chat's Settings, pages/webchat.ts): a main colour
// over the site's, and light or dark; nothing there is "as on the site", the default.
export type WebAccount = { id: number; store_id: number; external_id: string; status: string; meta: { domains?: string[]; first_seen_at?: string; look?: LookChoice } | null };

/** The store's chat account, on or off, or null when it was never turned on. */
export const webAccountOf = (app: App, storeId: number) =>
  app.db.one<WebAccount>("SELECT id, store_id, external_id, status, meta FROM channel_accounts WHERE store_id = $1 AND channel = 'web' ORDER BY id LIMIT 1", [storeId]);

/** A site address as the frame's CSP names it: https and the host, or null for anything else. */
export function siteOrigin(raw: string): string | null {
  const s = String(raw || '').trim().toLowerCase().replace(/\/+$/, '');
  const host = s.replace(/^https?:\/\//, '').split('/')[0];
  return /^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(host) ? `https://${host}` : null;
}

/** The store's own domain and its www: where the chat may show before the owner adds any other. */
export function defaultDomains(domain: string): string[] {
  const o = siteOrigin(domain);
  if (!o) return [];
  const host = o.slice('https://'.length);
  return [...new Set([o, host.startsWith('www.') ? `https://${host.slice(4)}` : `https://www.${host}`])];
}

/** The owner turns the chat on: a key made once, the domains the store's and the ones given. */
export async function turnOn(app: App, storeId: number, by: string, extra: string[] = []) {
  const s = await app.db.one<{ domain: string }>('SELECT domain FROM stores WHERE id = $1', [storeId]);
  const domains = [...new Set([...defaultDomains(s?.domain || ''), ...extra.map(siteOrigin).filter((x): x is string => Boolean(x))])].slice(0, 10);
  const had = await webAccountOf(app, storeId);
  if (had) await app.db.query("UPDATE channel_accounts SET status = 'active', meta = $2::jsonb WHERE id = $1", [had.id, J({ ...(had.meta || {}), domains })]);
  else await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name, status, meta) VALUES ($1, 'web', 'web', $2, 'צ׳אט באתר', 'active', $3::jsonb)", [storeId, newKey(), J({ domains })]);
  await audit(app.db, { actor: by, action: 'web_chat_on', storeId, detail: { domains } });
  return webAccountOf(app, storeId);
}

/** Off: the chat on the site disappears at once (its script answers nothing); the key stays for when it comes back. */
export async function turnOff(app: App, storeId: number, by: string) {
  await app.db.query("UPDATE channel_accounts SET status = 'off' WHERE store_id = $1 AND channel = 'web'", [storeId]);
  await audit(app.db, { actor: by, action: 'web_chat_off', storeId });
}

// `look` is the chat's colours, corners and type (ingest/palette.ts lookOf); `color` and `ink` are its main colour and
// the text on it, as the reviews block and older pages name them. `icon` is the square mark the chat's header shows:
// the site's apple-touch-icon or favicon, else its logo when that is its mark, else the store's initial. `bot` is the
// name the owner gave the bot, or null (agent/intro.ts): the header says who answers, never a promise of how fast.
export type Site = { account: WebAccount; name: string; color: string; ink: string; logo: string | null; domains: string[]; whatsapp: string | null; look: Look; bot: string | null };

/**
 * A store's chat look: the owner's choice for the chat over the site's own look, over the brand's colour (the
 * operator's correction of it first, brand_override, as everywhere the store's colour shows).
 */
export function storeLook(s: { brand?: any; brand_override?: any } | null | undefined, choice?: LookChoice | null): Look {
  const brand = { ...(s?.brand || {}), ...(s?.brand_override || {}) };
  const fixed = s?.brand_override?.colors?.[0] || null;
  return lookOf({ palette: fixed ? { ...(s?.brand?.palette || {}), primary: fixed, onPrimary: null } : s?.brand?.palette, colors: brand.colors, choice });
}

/** What the chat shows for a key, or null when the key is not one of an active chat. */
export async function siteOf(app: App, key: string): Promise<Site | null> {
  if (!isKey(key)) return null;
  const account = await app.db.one<WebAccount>("SELECT id, store_id, external_id, status, meta FROM channel_accounts WHERE channel = 'web' AND external_id = $1 AND status = 'active'", [key]);
  if (!account) return null;
  const s = await app.db.one<any>('SELECT name, domain, brand, brand_override, platform, agent_name FROM stores WHERE id = $1', [account.store_id]);
  const brand = { ...(s?.brand || {}), ...(s?.brand_override || {}) };
  const look = storeLook(s, account.meta?.look);
  // "Continue on WhatsApp": the store's own number, once it answers there, however it is connected (Meta, Kapso, Zernio).
  const wa = await app.db.one<{ meta: any }>("SELECT meta FROM channel_accounts WHERE store_id = $1 AND channel = 'whatsapp' AND status = 'active' AND kind IN ('meta', 'kapso', 'zernio') ORDER BY id DESC LIMIT 1", [account.store_id]);
  const number = String(wa?.meta?.display_phone_number || '').replace(/\D/g, '');
  const icon = String(s?.brand?.palette?.icon || '');
  return {
    account,
    name: displayName(s?.brand_override?.name, s?.brand?.name, s?.name) || s?.domain || '',
    color: look.primary,
    ink: look.onPrimary,
    logo: /^https:\/\//.test(icon) ? icon : brand.logoIsMark && /^https:\/\//.test(String(brand.logo || '')) ? String(brand.logo) : null,
    domains: (account.meta?.domains || []).filter((d) => siteOrigin(d) === d),
    whatsapp: number.length >= 8 ? number : null,
    look,
    bot: botName(s || {}),
  };
}

export type WebLine = { id: number; who: 'me' | 'store'; text: string; at: string };

/** This visitor's conversation with the store, after a message id: what they wrote, and what Toran or the owner answered. */
export async function visitorLines(app: App, account: WebAccount, visitor: string, after = 0): Promise<WebLine[]> {
  if (!isVisitor(visitor)) return [];
  const rows = await app.db.query<{ id: number; role: string; text: string; at: string }>(
    `SELECT m.id, m.role, m.text, m.at FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.account_id = $1 AND c.channel = 'web' AND c.peer = $2 AND m.id > $3 AND m.role IN ('customer', 'agent', 'owner') AND m.text <> ''
     ORDER BY m.id LIMIT 60`,
    [account.id, visitor, Math.max(0, Math.floor(after) || 0)],
  );
  return rows.map((r) => ({ id: Number(r.id), who: r.role === 'customer' ? 'me' : 'store', text: r.text, at: new Date(r.at).toISOString() }));
}
