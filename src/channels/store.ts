import type { App } from '../app.ts';
import { cleanLine } from '../core/hebrew.ts';
import { J } from '../db/index.ts';
import { event } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { runTurn } from '../agent/loop.ts';
import type { RouteResult } from './demo.ts';
import { hold, isPaused } from './owner.ts';
import { LEDGER, reply } from './send.ts';
import type { ChannelAdapter, Inbound } from './types.ts';

// A message to a store's own account (its email address now; its Page and Instagram account next): the store is the
// account's, so there is no code and no binding. The agent answers as the store, with no demo footer, unless the mail
// was automated, the owner has taken the conversation (owner.ts), or the customer reached today's limit; then the
// message is kept for the owner and nothing is sent.

const DAILY_REPLIES = 20; // the agent's answers to one customer of one account in a day; past it, the owner's turn

export type Account = { id: number; store_id: number; channel: string; external_id: string };

export async function accountFor(app: App, channel: string, externalId: string): Promise<Account | null> {
  return app.db.one<Account>("SELECT id, store_id, channel, external_id FROM channel_accounts WHERE channel = $1 AND external_id = $2 AND status = 'active'", [channel, externalId.toLowerCase()]);
}

const bareSubject = (s: string | undefined) => String(s || '').replace(/^\s*((re|fwd?|תשובה|השב|הועבר)\s*:\s*)+/i, '').trim().toLowerCase();

/** The conversation an email belongs to: one this sender's thread already holds an id of, else the same subject within 30 days, else a new one. */
async function threadFor(app: App, account: Account, inbound: Inbound): Promise<number> {
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

/** A note for the owner in the conversation, counted as a handoff (shown on Today and in the inbox). */
async function handOver(app: App, storeId: number, conversationId: number, reason: string, summary: string, text: string) {
  await app.db.query('INSERT INTO messages (conversation_id, role, text, handoff) VALUES ($1, $2, $3, $4::jsonb)', [conversationId, 'system', text, J({ reason, summary })]);
  await app.db.query('UPDATE conversations SET handoffs = handoffs + 1, last_at = now() WHERE id = $1', [conversationId]);
  await event(app.db, storeId, 'handoff', { conversationId, reason, summary });
}

export async function storeChannel(app: App, adapter: ChannelAdapter, inbound: Inbound, account: Account): Promise<RouteResult> {
  const { db } = app;
  const { tag } = LEDGER[adapter.channel];
  const store = await db.one<any>('SELECT id, name, domain, brand, brand_override FROM stores WHERE id = $1', [account.store_id]);
  if (!store) return { action: 'unknown_account' };
  const conv = await threadFor(app, account, inbound);
  await remember(app, conv, inbound);
  const text = String(inbound.text || '').trim();
  const files = inbound.attachments || [];

  if (inbound.automated) {
    await hold(app, conv, inbound, { automated: inbound.automated });
    await event(db, store.id, `${tag}_automated`, { conversationId: conv, why: inbound.automated });
    return { action: 'automated', storeId: store.id };
  }
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
  const context = files.length ? `The customer attached ${files.length} file(s) you cannot open (${files.map((f) => cleanLine(f.name, 40)).join(', ')}). If the question depends on them, say someone from the store will look at them, and call handoff.` : undefined;
  const o = await runTurn(app, { storeId: store.id, conversationId: conv, text, extId: inbound.id, footer: false, channel: adapter.channel, context });
  if (files.length) await db.query('UPDATE messages SET attachments = $2::jsonb WHERE ext_id = $1', [inbound.id, J(files)]);
  const storeName = displayName(store.brand_override?.name, store.brand?.name, store.name) || store.domain;
  const d = await reply(app, adapter, inbound, o.reply, store.id, conv, { who: 'agent', storeName });
  if (d.ok && o.agentMessageId) await db.query('UPDATE messages SET delivery = $2::jsonb WHERE id = $1', [o.agentMessageId, J(d.ids)]);
  return { action: 'answered', storeId: store.id, reply: o.reply };
}
