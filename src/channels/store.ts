import type { App } from '../app.ts';
import { cleanLine } from '../core/hebrew.ts';
import { J } from '../db/index.ts';
import { event } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { runTurn } from '../agent/loop.ts';
import type { RouteResult } from './demo.ts';
import { hold, isPaused } from './owner.ts';
import { LEDGER, reply } from './send.ts';
import { keepInbound, setAttachments } from './files.ts';
import { mailDomainOf, ownAddress, ownAddresses } from './mailDomain.ts';
import { noteCustomer } from './customers.ts';
import type { Attachment, ChannelAdapter, Inbound } from './types.ts';
import { customerWrote, OPT_OUT, optOut, optOutReply } from '../auto/consent.ts';
import { lastAuto } from '../auto/send.ts';

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
  if (account.channel !== 'email') {
    const c = await app.db.one<{ id: number }>("SELECT id FROM conversations WHERE account_id = $1 AND peer = $2 AND last_at > now() - interval '7 days' AND closed_at IS NULL ORDER BY last_at DESC LIMIT 1", [account.id, inbound.from]);
    if (c) return c.id;
    const name = adapter.profile ? await adapter.profile(inbound.from) : null;
    return (await app.db.one<{ id: number }>('INSERT INTO conversations (store_id, channel, peer, account_id, meta) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id', [account.store_id, account.channel, inbound.from, account.id, J(name ? { name } : {})]))!.id;
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

  await event(db, store.id, `${tag}_in`, { conversationId: conv, chars: text.length, preview: cleanLine(text, 60) });
  // An answer to an automatic message (auto/send.ts): the agent is told what the store sent.
  const context = [filesContext(files), await lastAuto(app, conv)].filter(Boolean).join('\n') || undefined;
  const o = await runTurn(app, { storeId: store.id, conversationId: conv, text, extId: inbound.id, footer: false, channel: adapter.channel, context });
  await setAttachments(app, inbound.id, files);
  const d = await reply(app, adapter, inbound, o.reply, store.id, conv, { who: 'agent', storeName, ...(own || {}) });
  if (d.ok && o.agentMessageId) await db.query('UPDATE messages SET delivery = $2::jsonb WHERE id = $1', [o.agentMessageId, J(d.ids)]);
  return { action: 'answered', storeId: store.id, reply: o.reply };
}
