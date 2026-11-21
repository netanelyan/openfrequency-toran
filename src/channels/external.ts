import { createHash, randomUUID } from 'node:crypto';
import type { App } from '../app.ts';
import type { Out, Req, Route } from '../web/server.ts';
import { internalRefusal } from '../ops/internal.ts';
import { COMPANY } from '../company.ts';
import { cleanLine } from '../core/hebrew.ts';
import { now } from '../core/clock.ts';
import { event } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { summaryHe } from '../agent/guard.ts';
import { DuplicateTurn } from '../agent/loop.ts';
import { COMPANY_REASONS } from '../agent/tools.ts';
import { openConversation } from './conversations.ts';
import { PAUSE_HOURS } from './owner.ts';
import { LIMITS } from './policy.ts';
import { storeChannel, type Account } from './store.ts';
import type { RouteResult } from './demo.ts';
import type { ChannelAdapter, Inbound } from './types.ts';

// A company store answered elsewhere: a company whose WhatsApp conversations live in its own service on this machine,
// על הקו's first (docs/company.md, "A company store answered elsewhere"). That service owns its number on Meta's Cloud
// API and its webhook; for each message it asks Toran here for the answer, and sends the answer itself, from its own
// number. Toran sends nothing to any channel for these conversations, and tells nobody of their handoffs: the service
// reads the handoff in the answer and tells its own people.
//
// The conversation is kept as any of the company store's: its store, channel 'whatsapp', the person by phone, on one
// channel account of kind 'external' (external_id "external:<domain>", made on the first message), so the operator's
// inbox shows it, and knows from the kind that the answers go out elsewhere (channels/owner.ts replyState 'elsewhere':
// where it is answered, instead of a reply box). The turn is the company store's normal one, through storeChannel with
// an adapter that keeps what it is given instead of sending it: the stop words, another bot, a person who answered in
// the last PAUSE_HOURS, the support's own limits for a business we wrote to (pitched: a thanks after our answer gets
// none, at most LEAD_REPLIES_PER_HOUR answers an hour), the day's and the store's limits, then the model with the
// company's prompt, block and tools, the guard, the bot's opening line and the spend caps (agent/loop.ts). What the
// adapter was given is the reply, word for word.
//
//   POST /internal/company/answer    under api.ts internalRefusal (503 not_configured, 403 forbidden from anywhere but
//                                    this machine or through Caddy, 401 bad_token), then 400 bad_request for a body
//                                    that is not a request and 404 no_store for a domain that is no company store here
//   { domain, phone, name, messages: [{ id, text, at }], operator: [{ text, at }], context }
//   200 { reply, handoff: null | { reason, summary, business }, conversationId, duplicate? }
//
// messages are the person's new ones since the last call, oldest first: each is kept under its id (as
// "ext:<store>:<id>"), so the same id again is never answered twice (duplicate: true). operator is what a person of
// the company answered them by hand there since the last call: each is kept as a person's answer in the inbox (role
// 'owner', once, by its time and words), and pauses Toran in the conversation for PAUSE_HOURS from when it was written,
// as an answer from the inbox does; the bot's next opening then says it is the bot again (agent/intro.ts). Whichever
// came last is what Toran answers: a person's answer after the person's last message leaves nothing to answer.
// context is the company's own line about who this is (a paying customer, a business it wrote to): it rides in the
// turn's SERVER CONTEXT for the model, and is never stored or shown.

export const EXTERNAL = 'external';
export const ANSWER_PATH = '/internal/company/answer';
const PATH = /^\/internal\/company\/answer$/;
const BODY_LIMIT = 64 * 1024;
/** At most this many of the person's messages, and as many of a person's answers, in one call. */
export const MAX_ITEMS = 20;
/** WhatsApp's own limit on one message. */
const TEXT_MAX = 4096;
const CONTEXT_MAX = 2000;
const NAME_MAX = 100;

/** What a message of the company's is kept under here: its id inside this store's, apart from every other id. */
export const ELSEWHERE_ID = 'ext:';
const keptId = (storeId: number, id: string) => `${ELSEWHERE_ID}${storeId}:${id}`;
/** A person's answer has no id of its own: its person, time and words are one, so a call made again keeps it once. */
const answerId = (storeId: number, phone: string, at: string, text: string) => `${ELSEWHERE_ID}${storeId}:op:${createHash('sha256').update(`${phone}\n${at}\n${text}`).digest('hex').slice(0, 32)}`;

export type AnswerRequest = { domain: string; phone: string; name: string | null; messages: { id: string; text: string; at: string }[]; operator: { text: string; at: string }[]; context: string | null };
export type AnswerHandoff = { reason: string; summary: string; business: string | null };
export type Answer = { reply: string | null; handoff: AnswerHandoff | null; conversationId: number; duplicate?: true };

const isoOf = (v: unknown) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
const textOf = (v: unknown) => (typeof v === 'string' && v.trim() && v.length <= TEXT_MAX ? v.trim() : null);
const listOf = (v: unknown) => (v == null ? [] : Array.isArray(v) ? v : null);
const objectOf = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * The request in a body, or null when it is not one: a domain, the person's phone in digits, 1 to MAX_ITEMS messages
 * each with an id (no spaces, at most 200 characters, once in the call), words and a time, up to MAX_ITEMS answers of a
 * person each with words and a time, and name and context strings or null (or left out).
 */
export function readAnswerRequest(raw: string | undefined): AnswerRequest | null {
  const text = raw || '';
  if (Buffer.byteLength(text, 'utf8') > BODY_LIMIT) return null;
  let b: Record<string, unknown> | null;
  try {
    b = objectOf(JSON.parse(text));
  } catch {
    return null;
  }
  if (!b) return null;
  const domain = typeof b.domain === 'string' ? b.domain.trim().toLowerCase() : '';
  if (domain.length > 253 || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  const phone = typeof b.phone === 'string' ? b.phone : '';
  if (!/^\d{8,15}$/.test(phone)) return null;
  if (b.name != null && typeof b.name !== 'string') return null;
  if (b.context != null && (typeof b.context !== 'string' || b.context.length > CONTEXT_MAX)) return null;
  const given = listOf(b.messages);
  const answers = listOf(b.operator);
  if (!given || !answers || !given.length || given.length > MAX_ITEMS || answers.length > MAX_ITEMS) return null;
  const messages: AnswerRequest['messages'] = [];
  for (const m of given.map(objectOf)) {
    const id = typeof m?.id === 'string' && /^\S{1,200}$/.test(m.id) ? m.id : null;
    const words = textOf(m?.text);
    const at = isoOf(m?.at);
    if (!id || !words || !at || messages.some((x) => x.id === id)) return null;
    messages.push({ id, text: words, at });
  }
  const operator: AnswerRequest['operator'] = [];
  for (const o of answers.map(objectOf)) {
    const words = textOf(o?.text);
    const at = isoOf(o?.at);
    if (!words || !at) return null;
    operator.push({ text: words, at });
  }
  const name = typeof b.name === 'string' ? cleanLine(b.name, NAME_MAX) || null : null;
  const context = typeof b.context === 'string' ? cleanLine(b.context, CONTEXT_MAX) || null : null;
  return { domain, phone, name, messages, operator, context };
}

/**
 * The adapter of a conversation answered elsewhere: what storeChannel would send is kept in `said`, and nothing leaves
 * this machine. No window and no cut into parts: the company sends the answer from its own number, under Meta's rules
 * there. The person's name is the one the company's service gave (their WhatsApp profile), kept on a new conversation.
 */
export function externalAdapter(name: string | null = null): ChannelAdapter & { said: string[] } {
  const said: string[] = [];
  return {
    channel: 'whatsapp',
    kind: EXTERNAL,
    limits: { ...LIMITS.whatsapp, maxChars: 100_000, window: null },
    inboundUsd: 0,
    parse: () => null,
    async send(_to, text) {
      said.push(text);
      return { id: `${EXTERNAL}:${randomUUID()}`, usd: 0 };
    },
    profile: async () => name,
    ack: () => ({ type: 'application/json', body: '{}' }),
    said,
  };
}

/** The company store's account for the conversations its own service answers: one, made on its first message. */
export async function externalAccount(app: App, store: { id: number; domain: string; name: string | null }): Promise<Account> {
  const externalId = `${EXTERNAL}:${store.domain}`;
  await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name, status) VALUES ($1, 'whatsapp', $2, $3, $4, 'active') ON CONFLICT (channel, external_id) DO NOTHING", [store.id, EXTERNAL, externalId, store.name]);
  const a = await app.db.one<Account>("SELECT id, store_id, channel, external_id, kind, secret, meta, status FROM channel_accounts WHERE channel = 'whatsapp' AND external_id = $1", [externalId]);
  if (!a || a.store_id !== store.id || a.kind !== EXTERNAL) throw new Error(`${externalId} is another store's account here`);
  return a;
}

// What the company's people read when Toran handed a message over for one of its own rules (not the model's), in
// Hebrew: the summaries kept for the inbox are written for our own support.
const HANDED_HE: Partial<Record<RouteResult['action'], string>> = {
  limit: 'תורן ענה כאן הרבה בזמן קצר, אז את ההודעה הזו הוא משאיר לכם.',
  bot: 'בצד השני עונה בוט, אז תורן הפסיק לענות לו.',
  not_live: 'תורן מושהה אצלנו, אז את ההודעה הזו הוא משאיר לכם.',
  channel_off: 'תורן מושהה אצלנו, אז את ההודעה הזו הוא משאיר לכם.',
};
const STOP_HE = 'ביקשו שלא נכתוב להם יותר.';
const REASONS = new Set<string>(COMPANY_REASONS);

/**
 * The handoff a call ends with: the one Toran kept in the conversation during it (the model's, or one of its own
 * rules'), its reason one of the company handoff's (any other is "other"), and the business's name a person gave to
 * join. None while a person of the company has the conversation (they read it there already). A stop word is a stop.
 */
function handoffOf(action: RouteResult['action'], kept: { reason?: string; summary?: string; business?: string } | null): AnswerHandoff | null {
  if (action === 'held') return null;
  if (action === 'opt_out') return { reason: 'stop', summary: STOP_HE, business: null };
  if (!kept) return null;
  const reason = REASONS.has(String(kept.reason)) ? String(kept.reason) : 'other';
  const summary = action === 'answered' ? summaryHe(String(kept.summary || '')) : HANDED_HE[action] || summaryHe(String(kept.summary || ''));
  return { reason, summary, business: kept.business ? String(kept.business) : null };
}

/** Answer the person's newest message as the company store does (the comment above), or null: no such company store. */
export async function answerElsewhere(app: App, q: AnswerRequest): Promise<Answer | null> {
  const { db } = app;
  const store = await db.one<{ id: number; name: string | null; domain: string; brand: any; brand_override: any }>('SELECT id, name, domain, brand, brand_override FROM stores WHERE domain = $1 AND platform = $2', [q.domain, COMPANY]);
  if (!store) return null;
  const account = await externalAccount(app, store);
  const storeName = displayName(store.brand_override?.name, store.brand?.name, store.name) || store.domain;
  type Item = { kind: 'customer' | 'owner'; ext: string; text: string; at: string };
  const theirs: Item[] = q.messages.map((m) => ({ kind: 'customer', ext: keptId(store.id, m.id), text: m.text, at: m.at }));
  const ours: Item[] = q.operator.map((o) => ({ kind: 'owner', ext: answerId(store.id, q.phone, o.at, o.text), text: o.text, at: o.at }));
  const known = new Set((await db.query<{ ext_id: string }>('SELECT ext_id FROM messages WHERE ext_id = ANY($1::text[])', [theirs.map((m) => m.ext)])).map((r) => r.ext_id));
  // As they were written, oldest first; a message and an answer at the same moment, the message first.
  const items = [...theirs, ...ours].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.kind === b.kind ? 0 : a.kind === 'customer' ? -1 : 1));

  // Every message already kept: the same call again. Nothing is answered twice; a person's answer in it is kept once.
  if (theirs.every((m) => known.has(m.ext))) {
    const was = await db.one<{ conversation_id: number }>('SELECT conversation_id FROM messages WHERE ext_id = $1', [theirs[theirs.length - 1].ext]);
    const conversationId = Number(was!.conversation_id);
    await keepInOrder(app, store.id, conversationId, ours, storeName);
    return { reply: null, handoff: null, conversationId, duplicate: true };
  }

  const conv = (await openConversation(db, { storeId: store.id, channel: 'whatsapp', peer: q.phone, accountId: account.id, meta: () => (q.name ? { name: q.name } : {}) })).id;
  const before = (await db.one<{ n: number }>('SELECT COALESCE(MAX(id), 0)::int AS n FROM messages WHERE conversation_id = $1', [conv]))!.n;
  const last = items[items.length - 1];
  const turn = last.kind === 'customer' && !known.has(last.ext) ? last : null;
  // Everything before the one Toran answers is kept in order: the person's messages unanswered (the model reads them
  // with the last), a person's answers as the inbox keeps one.
  await keepInOrder(app, store.id, conv, items.filter((it) => it !== turn && !known.has(it.ext)), storeName);
  if (!turn) {
    await event(db, store.id, 'answered_elsewhere', { conversationId: conv, action: 'answered_by_person' });
    return { reply: null, handoff: null, conversationId: conv };
  }

  const adapter = externalAdapter(q.name);
  const inbound: Inbound = { channel: 'whatsapp', from: q.phone, text: turn.text, id: turn.ext, at: Math.min(Date.parse(turn.at), now()), account: account.external_id, profileName: q.name };
  const context = q.context ? `From ${storeName}'s own records about this person, for you alone: go on from it, never quote it, and never say where you know it from. "${q.context}"` : undefined;
  let r: RouteResult;
  try {
    r = await storeChannel(app, adapter, inbound, account, { pitched: true, context });
  } catch (e) {
    // The same message in two calls at once: the second found it answered inside the conversation's lock (agent/loop.ts).
    if (e instanceof DuplicateTurn) return { reply: null, handoff: null, conversationId: conv, duplicate: true };
    throw e;
  }
  const kept = await db.one<{ handoff: any }>('SELECT handoff FROM messages WHERE conversation_id = $1 AND id > $2 AND handoff IS NOT NULL ORDER BY id DESC LIMIT 1', [conv, before]);
  const handoff = handoffOf(r.action, kept?.handoff ?? null);
  const reply = adapter.said.length ? adapter.said.join('\n\n') : null;
  await event(db, store.id, 'answered_elsewhere', { conversationId: conv, action: r.action, replied: Boolean(reply), handoff: handoff?.reason ?? null });
  return { reply, handoff, conversationId: conv };
}

/**
 * The person's messages Toran does not answer in this call, and what a person of the company answered by hand in its
 * own service, kept in the order they were written, each once, at the time it was written. A person's answer is kept
 * as one from the inbox is (role 'owner', the company's team as its author), and Toran steps back in the conversation
 * for PAUSE_HOURS from the last of them and says it is the bot again when it is back (channels/owner.ts ownerReply does
 * the same for an answer from the inbox).
 */
async function keepInOrder(app: App, storeId: number, conversationId: number, items: { kind: 'customer' | 'owner'; ext: string; text: string; at: string }[], storeName: string) {
  let latest: string | null = null;
  for (const it of items) {
    if (it.kind === 'customer') {
      await app.db.query("INSERT INTO messages (conversation_id, role, text, ext_id, at) VALUES ($1, 'customer', $2, $3, LEAST($4::timestamptz, now())) ON CONFLICT (ext_id) DO NOTHING", [conversationId, it.text, it.ext, it.at]);
      continue;
    }
    const row = await app.db.one("INSERT INTO messages (conversation_id, role, text, author, ext_id, at) VALUES ($1, 'owner', $2, $3, $4, LEAST($5::timestamptz, now())) ON CONFLICT (ext_id) DO NOTHING RETURNING id", [conversationId, it.text, `הצוות של ${storeName}`, it.ext, it.at]);
    if (row && (!latest || Date.parse(it.at) > Date.parse(latest))) latest = it.at;
  }
  if (items.length) await app.db.query('UPDATE conversations SET last_at = now() WHERE id = $1', [conversationId]);
  if (!latest) return;
  await app.db.query(`UPDATE conversations SET introduced_at = NULL, agent_paused_until = GREATEST(COALESCE(agent_paused_until, LEAST($2::timestamptz, now())), LEAST($2::timestamptz, now()) + interval '${PAUSE_HOURS} hours') WHERE id = $1`, [conversationId, latest]);
  await event(app.db, storeId, 'owner_reply', { conversationId, via: 'elsewhere' });
}

export function companyAnswerRoutes(app: App): Route<Req>[] {
  return [
    ['POST', PATH, async (r): Promise<Out> => {
      const no = internalRefusal(app, r);
      if (no) return no;
      const q = readAnswerRequest(r.raw);
      if (!q) return { status: 400, json: { error: 'bad_request' } };
      const a = await answerElsewhere(app, q);
      if (!a) return { status: 404, json: { error: 'no_store' } };
      return { json: a, headers: { 'cache-control': 'no-store' } };
    }],
    // Another method: refused after the same checks, so a GET from outside learns nothing more.
    ['GET', PATH, async (r): Promise<Out> => internalRefusal(app, r) || { status: 405, json: { error: 'method_not_allowed' } }],
  ];
}
