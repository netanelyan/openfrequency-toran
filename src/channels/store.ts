import type { App } from '../app.ts';
import { cleanLine } from '../core/hebrew.ts';
import { J } from '../db/index.ts';
import { event } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { runTurn } from '../agent/loop.ts';
import type { RouteResult } from './demo.ts';
import { hold, isPaused } from './owner.ts';
import { LEDGER, partsOf, reply } from './send.ts';
import { keepInbound, setAttachments } from './files.ts';
import { mailDomainOf, ownAddress, ownAddresses } from './mailDomain.ts';
import { noteCustomer } from './customers.ts';
import type { Attachment, ChannelAdapter, Inbound } from './types.ts';
import { customerWrote, OPT_OUT, optOut, optOutReply } from '../auto/consent.ts';
import { openConversation } from './conversations.ts';
import { lastAuto } from '../auto/send.ts';
import { alertOperator } from '../ops/alert.ts';

// A message to a store's own account (its email address, WhatsApp number, Facebook Page or Instagram account): the
// store is the account's, so there is no code and no binding. The agent answers as the store, with no demo footer, unless the mail
// was automated, the owner has taken the conversation (owner.ts), or the customer reached today's limit; then the
// message is kept for the owner and nothing is sent. Before any of that, its files are kept for the owner (files.ts),
// and the addresses and numbers it gives join this customer's other conversations (customers.ts). An email answer
// goes out from the store's own address once its domain is verified (mailDomain.ts). On WhatsApp and email, "הסר" or
// "STOP" stops the store's automatic messages to the customer (auto/consent.ts) and is answered with one line, any
// other message drops a cart reminder or review request still waiting for them, and an answer to an automatic message
// reaches the agent with what the store sent.

const DAILY_REPLIES = 20; // the agent's answers to one customer of one account in a day; past it, the owner's turn
// A store's whole hour: past STORE_TURNS_PER_HOUR answers (TORAN_STORE_TURNS_PER_HOUR), or NEW_SENDERS_PER_HOUR new email
// addresses (TORAN_NEW_SENDERS_PER_HOUR), the next messages wait for the owner and the operator hears of it. A sale
// answers well under it; a flood, a mail list or two bots answering each other do not.
export const STORE_TURNS_PER_HOUR = 200;
export const NEW_SENDERS_PER_HOUR = 30;
const IN_KINDS = Object.values(LEDGER).map((l) => `${l.tag}_in`);

export type Account = { id: number; store_id: number; channel: string; external_id: string; kind: string; secret: string | null; meta: any; status: string };

/**
 * The store's account a message came to. A WhatsApp number still pending at Meta counts: a message on it means it is
 * on. So does one whose token ended (waStore.ts): the message is the owner's to answer (route.ts).
 */
export async function accountFor(app: App, channel: string, externalId: string): Promise<Account | null> {
  return app.db.one<Account>("SELECT id, store_id, channel, external_id, kind, secret, meta, status FROM channel_accounts WHERE channel = $1 AND external_id = $2 AND (status = 'active' OR (channel = 'whatsapp' AND status IN ('pending', 'reconnect')))", [channel, externalId.toLowerCase()]);
}

const bareSubject = (s: string | undefined) => String(s || '').replace(/^\s*((re|fwd?|תשובה|השב|הועבר)\s*:\s*)+/i, '').trim().toLowerCase();

/** The conversation an email belongs to: one this sender's thread already holds an id of, else the same subject within 30 days, else a new one. */
async function threadFor(app: App, adapter: ChannelAdapter, account: Account, inbound: Inbound): Promise<number> {
  // WhatsApp, Messenger and Instagram have no threads: one customer is one conversation until a week of silence, as on
  // the demo number. On Messenger and Instagram the customer's id means nothing to the owner, so a new conversation
  // keeps the name Meta gives for them.
  // The lookup and the insert are one step (conversations.ts): two messages of a new customer start one conversation.
  if (account.channel !== 'email') {
    const meta = async () => {
      const name = adapter.profile ? await adapter.profile(inbound.from) : null;
      return name ? { name } : {};
    };
    return (await openConversation(app.db, { storeId: account.store_id, channel: account.channel, peer: inbound.from, accountId: account.id, meta })).id;
  }
  const refs = [inbound.thread?.inReplyTo, ...(inbound.thread?.references || [])].filter(Boolean) as string[];
  if (refs.length) {
    const c = await app.db.one<{ id: number }>("SELECT id FROM conversations WHERE account_id = $1 AND peer = $2 AND meta->'ids' ?| $3::text[] ORDER BY last_at DESC LIMIT 1", [account.id, inbound.from, refs]);
    if (c) return c.id;
  }
  const subject = bareSubject(inbound.subject);
  if (subject) {
    const c = await app.db.one<{ id: number }>("SELECT id FROM conversations WHERE account_id = $1 AND peer = $2 AND meta->>'bare' = $3 AND last_at > now() - interval '30 days' ORDER BY last_at DESC LIMIT 1", [account.id, inbound.from, subject]);
    if (c) return c.id;
  }
  const r = await app.db.one<{ id: number }>('INSERT INTO conversations (store_id, channel, peer, account_id, meta) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id', [account.store_id, account.channel, inbound.from, account.id, J({ subject: inbound.subject || '', bare: subject, ids: [] })]);
  return r!.id;
}

/** Add this email's ids to its conversation's, so the next reply in the thread finds it. */
async function remember(app: App, conversationId: number, inbound: Inbound) {
  const add = [inbound.thread?.messageId, ...(inbound.thread?.references || [])].filter(Boolean) as string[];
  if (!add.length) return;
  const c = await app.db.one<{ meta: any }>('SELECT meta FROM conversations WHERE id = $1', [conversationId]);
  const ids = [...new Set([...(c?.meta?.ids || []), ...add])].slice(-50);
  await app.db.query('UPDATE conversations SET meta = meta || $2::jsonb WHERE id = $1', [conversationId, J({ ids })]);
}

/** The line the agent is told about the files on a message: their names and kinds; it cannot open them. */
export function filesContext(files: Attachment[]): string | undefined {
  if (!files.length) return undefined;
  const kind = (f: Attachment) => (f.type.startsWith('image/') || f.type === 'image' ? 'an image' : f.type === 'application/pdf' ? 'a PDF' : 'a file');
  return `The customer attached ${files.length} file(s): ${files.map((f) => `${cleanLine(f.name, 40)} (${kind(f)})`).join(', ')}. You cannot open them; the store's owner sees them in the inbox. If the question depends on them, say someone from the store will look at them, and call handoff.`;
}

/** The conversation a WhatsApp, Messenger or Instagram message belongs to (no threads): one per customer per account. */
export const conversationOf = (app: App, adapter: ChannelAdapter, account: Account, inbound: Inbound) => threadFor(app, adapter, account, inbound);

/** A note for the owner in the conversation, counted as a handoff (shown on Today and in the inbox). */
export async function handOver(app: App, storeId: number, conversationId: number, reason: string, summary: string, text: string) {
  await app.db.query('INSERT INTO messages (conversation_id, role, text, handoff) VALUES ($1, $2, $3, $4::jsonb)', [conversationId, 'system', text, J({ reason, summary })]);
  await app.db.query('UPDATE conversations SET handoffs = handoffs + 1, last_at = now() WHERE id = $1', [conversationId]);
  await event(app.db, storeId, 'handoff', { conversationId, reason, summary });
}

export async function storeChannel(app: App, adapter: ChannelAdapter, inbound: Inbound, account: Account): Promise<RouteResult> {
  const { db } = app;
  const { tag } = LEDGER[adapter.channel];
  const store = await db.one<any>('SELECT id, name, domain, brand, brand_override FROM stores WHERE id = $1', [account.store_id]);
  if (!store) return { action: 'unknown_account' };
  const conv = await threadFor(app, adapter, account, inbound);
  await remember(app, conv, inbound);
  const text = String(inbound.text || '').trim();
  // Mail from the store's own address is the store writing to itself (a loop through its forwarding), never a customer.
  const domain = adapter.channel === 'email' ? await mailDomainOf(app, store.id) : null;
  const automated = inbound.automated || (ownAddresses(domain).includes(String(inbound.from).toLowerCase()) ? "the store's own address" : null);

  if (automated) {
    await hold(app, conv, inbound, { automated });
    await event(db, store.id, `${tag}_automated`, { conversationId: conv, why: automated });
    return { action: 'automated', storeId: store.id };
  }
  const files = await keepInbound(app, adapter, inbound, conv);
  inbound = { ...inbound, attachments: files };
  if (text) await noteCustomer(app, store.id, conv, { channel: account.channel, value: inbound.from }, text);
  const storeName = displayName(store.brand_override?.name, store.brand?.name, store.name) || store.domain;
  const own = adapter.channel === 'email' ? await ownAddress(app, store.id) : null;
  const ch = adapter.channel === 'whatsapp' || adapter.channel === 'email' ? adapter.channel : null;
  // "הסר" or "STOP": no more automatic messages to this customer here (auto/consent.ts), said back in one line, and
  // nothing for the agent to answer. Any other message drops a cart reminder or a review request still waiting.
  if (ch && OPT_OUT.test(text)) {
    await hold(app, conv, inbound);
    await optOut(app, store.id, ch, inbound.from, text, conv);
    const line = optOutReply(storeName);
    const d = await reply(app, adapter, inbound, line, store.id, conv, { who: 'agent', storeName, ...(own || {}) });
    await db.query("INSERT INTO messages (conversation_id, role, text, author, auto, delivery) VALUES ($1, 'agent', $2, 'אוטומטי', 'opt_out', $3::jsonb)", [conv, line, J(d.ok ? d.ids : [])]);
    return { action: 'opt_out', storeId: store.id, reply: line };
  }
  if (ch) await customerWrote(app, store.id, ch, inbound.from);
  if (await isPaused(app, conv)) {
    await hold(app, conv, inbound);
    await event(db, store.id, 'held', { conversationId: conv });
    return { action: 'held', storeId: store.id };
  }
  if (!text) {
    await hold(app, conv, inbound);
    await handOver(app, store.id, conv, 'attachment', `${files.length} files, no text`, 'הלקוח שלח קבצים בלי טקסט, ותורן לא ענה. הקבצים מחכים לך.');
    return { action: 'no_text', storeId: store.id };
  }
  const today = await db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.account_id = $1 AND c.peer = $2 AND m.role = 'agent' AND m.at > now() - interval '1 day'", [account.id, inbound.from]);
  if ((today?.n || 0) >= DAILY_REPLIES) {
    await hold(app, conv, inbound);
    await handOver(app, store.id, conv, 'limit', `${DAILY_REPLIES} answers today to ${inbound.from}`, `תורן כבר ענה ללקוח הזה ${DAILY_REPLIES} פעמים היום, אז מכאן ההודעות מחכות לך.`);
    return { action: 'limit', storeId: store.id };
  }

  const busy = await busyHour(app, store.id, account, conv, inbound.from);
  if (busy) {
    await hold(app, conv, inbound);
    await handOver(app, store.id, conv, 'limit', busy.summary, busy.text);
    await alertOperator(app, `busy:${busy.kind}:${store.id}`, `עומס חריג בחנות ${store.id}`, busy.summary, { storeId: store.id });
    return { action: 'limit', storeId: store.id };
  }

  await event(db, store.id, `${tag}_in`, { conversationId: conv, chars: text.length, preview: cleanLine(text, 60) });
  // An answer to an automatic message (auto/send.ts): the agent is told what the store sent.
  const context = [filesContext(files), await lastAuto(app, conv)].filter(Boolean).join('\n') || undefined;
  const o = await runTurn(app, { storeId: store.id, conversationId: conv, text, extId: inbound.id, footer: false, channel: adapter.channel, context });
  await setAttachments(app, inbound.id, files);
  // Each part's id is written down as it goes: a job run again after a failed send sends only what did not go out.
  const delivered = (ids: string[]) => (o.agentMessageId ? db.query('UPDATE messages SET delivery = $2::jsonb WHERE id = $1', [o.agentMessageId, J(ids)]) : Promise.resolve());
  await reply(app, adapter, inbound, o.reply, store.id, conv, { who: 'agent', storeName, ...(own || {}) }, { onPart: delivered });
  return { action: 'answered', storeId: store.id, reply: o.reply };
}

/** Is the store's hour past its limits? What the owner is told, or null. */
async function busyHour(app: App, storeId: number, account: Account, conv: number, from: string): Promise<{ kind: string; summary: string; text: string } | null> {
  const turns = Number(app.env.TORAN_STORE_TURNS_PER_HOUR) || STORE_TURNS_PER_HOUR;
  const n = await app.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM events WHERE store_id = $1 AND kind = ANY($2::text[]) AND at > now() - interval '1 hour'", [storeId, IN_KINDS]);
  if ((n?.n || 0) >= turns) return { kind: 'turns', summary: `${n!.n} answers in the last hour at store ${storeId}, over ${turns}`, text: `בשעה האחרונה תורן ענה בחנות ${n!.n} פעמים, הרבה יותר מבשעה רגילה. עד שזה נרגע, הודעות חדשות מחכות לך כאן.` };
  if (account.channel !== 'email') return null;
  // A new sender: this address never wrote to the store before (this message is not written yet).
  if (await app.db.one("SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id = c.id WHERE c.store_id = $1 AND c.peer = $2 AND m.role = 'customer' LIMIT 1", [storeId, from])) return null;
  const senders = Number(app.env.TORAN_NEW_SENDERS_PER_HOUR) || NEW_SENDERS_PER_HOUR;
  const m = await app.db.one<{ n: number }>("SELECT COUNT(DISTINCT peer)::int AS n FROM conversations WHERE store_id = $1 AND channel = 'email' AND started_at > now() - interval '1 hour'", [storeId]);
  if ((m?.n || 0) > senders) return { kind: 'senders', summary: `${m!.n} new email senders in the last hour at store ${storeId}, over ${senders}`, text: `בשעה האחרונה כתבו לחנות במייל ${m!.n} כתובות חדשות, הרבה יותר מהרגיל. עד שזה נרגע, תורן לא עונה לכתובות חדשות, וההודעות שלהן מחכות לך.` };
  return null;
}

/**
 * The same message again (the job run again after its answer failed to go out): the answer Toran already wrote is sent,
 * only the parts that did not go out, with no model call; inside the reply window, as any answer (send.ts). Null when
 * there is nothing left to send, or the answer is not one of a store's own channels (the demo number keeps no
 * delivery record, and a webhook delivered twice is only that).
 */
export async function resendUndelivered(app: App, adapter: ChannelAdapter, inbound: Inbound): Promise<RouteResult | null> {
  const m = await app.db.one<{ id: number; text: string; delivery: string[] | null; conversation_id: number; store_id: number }>(
    "SELECT m.id, m.text, m.delivery, m.conversation_id, c.store_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.reply_to = $1 AND m.role = 'agent' AND c.account_id IS NOT NULL ORDER BY m.id DESC LIMIT 1",
    [inbound.id],
  );
  if (!m) return null;
  const sent = Array.isArray(m.delivery) ? m.delivery : [];
  if (sent.length >= partsOf(adapter, m.text).length) return null;
  const store = await app.db.one<any>('SELECT id, name, domain, brand, brand_override FROM stores WHERE id = $1', [m.store_id]);
  if (!store) return null;
  const storeName = displayName(store.brand_override?.name, store.brand?.name, store.name) || store.domain;
  const own = adapter.channel === 'email' ? await ownAddress(app, store.id) : null;
  const d = await reply(app, adapter, inbound, m.text, store.id, m.conversation_id, { who: 'agent', storeName, ...(own || {}) }, { skip: sent.length, onPart: (ids) => app.db.query('UPDATE messages SET delivery = $2::jsonb WHERE id = $1', [m.id, J([...sent, ...ids])]) });
  await event(app.db, store.id, 'answer_resent', { conversationId: m.conversation_id, parts: d.ok ? d.ids.length : 0, blocked: d.ok ? null : d.reason });
  return { action: 'resent', storeId: store.id, reply: m.text };
}
