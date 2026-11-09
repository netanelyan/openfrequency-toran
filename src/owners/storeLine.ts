import type { App } from '../app.ts';
import type { Db } from '../db/index.ts';
import { event } from '../db/log.ts';
import { keep } from '../assistant/index.ts';
import type { Account } from '../channels/store.ts';
import type { RouteResult } from '../channels/demo.ts';
import type { ChannelAdapter, Inbound } from '../channels/types.ts';
import { ownerByPhone, ownersOf, type Owner } from './identity.ts';
import { ownerLine, ownerLineDown } from './line.ts';

// The owner's assistant on the store's own WhatsApp number (the owner, 2026-11-09: "the personal assistant should be
// the number of the business, and the owner messages it personally"). Until then the assistant lived on our number
// only (TORAN_ASSISTANT_WA, line.ts), and a message from the owner's phone to their own business number was answered
// as a customer's, opened a customer conversation in the inbox and counted as one.
//
// Now a message to a store's own WhatsApp number (Meta, Kapso or Zernio, route.ts) from a phone that accounts verified
// for that store's workspace (any role accounts links, owner or member, as on our number) is the owner talking to
// their assistant about THIS store: the same ownerLine() as on our number, with this store instead of the workspace's
// most recently active one, and the answer goes out through the store's own adapter, the way its customers' answers
// go. The owner wrote first, so WhatsApp's 24 hours are open. Nothing of it touches the store's customers: no
// conversation, no customer ids, no cart or review dropped, no handoff, no count; the chat is kept in
// assistant_messages with the owner's number, as on our number, and shows on the assistant's page.
//
// Who is the owner, without asking accounts on every customer's message:
//
//   the workspace's verified numbers (accounts' /internal/owner-phones) are kept LIST_MS per workspace, in memory, one
//   question a minute at most, however many customers write. A number not on it is a customer, asked nothing more.
//   while accounts does not answer the list, for RETRY_MS, the numbers Toran itself saw link or write for the workspace
//   (owner_numbers) stand in for it, so the owner's message does not land among the customers'
//   a number on it is asked of accounts live (ownerByPhone), as on our number before every answer: a number removed in
//   accounts a moment ago stops here, and the list is asked again. Only the store's own workspace counts: the owner of
//   another store writing here is this store's customer, like anyone else
//
// Our number stays the assistant too (the owner may have several stores, or no WhatsApp of the store's connected yet).
//
// Echoes (the owner answering a customer from the WhatsApp Business app on a coexistence number) never come through
// here: they are the provider's other event (waStore.ts ownerEcho), whose `to` is the customer. One whose `to` is the
// owner's own number (the app's greeting or away message answering the owner's message, or the owner typing to
// themselves) is not a customer conversation either: ownedEcho() says so and ownerEcho() drops it.

export const LIST_MS = 60_000;
export const RETRY_MS = 30_000;
const PHONE = /^\+?[1-9]\d{7,14}$/;

type Kept = { at: number; phones: Set<string> | null };
// One cache per database, so two test apps with the same workspace ids never share one (the entitlement's way).
const lists = new WeakMap<Db, Map<number, Kept>>();
const listsOf = (db: Db) => {
  let m = lists.get(db);
  if (!m) lists.set(db, (m = new Map()));
  return m;
};

/** The workspace's verified numbers, kept LIST_MS (RETRY_MS when accounts did not answer: null). */
async function numbersOf(app: App, workspaceId: number): Promise<Set<string> | null> {
  const m = listsOf(app.db);
  const k = m.get(workspaceId);
  const t = Date.now();
  if (k && t - k.at < (k.phones ? LIST_MS : RETRY_MS)) return k.phones;
  const owners = await ownersOf(app, workspaceId);
  const phones = owners ? new Set(owners.map((o) => o.phone)) : null;
  m.set(workspaceId, { at: t, phones });
  if (m.size > 5000) m.delete(m.keys().next().value!);
  return phones;
}

/** Forget a workspace's list: accounts just said one of its numbers is not its own any more. */
export const forgetNumbers = (app: App, workspaceId: number) => listsOf(app.db).delete(workspaceId);

const digitsOf = (p: string | null | undefined) => (PHONE.test(String(p || '')) ? String(p).replace(/\D/g, '') : null);

/** The store's workspace and its own number's digits. */
async function storeOf(app: App, account: Account): Promise<{ workspaceId: number | null; own: string | null }> {
  const s = await app.db.one<{ workspace_id: number | null }>('SELECT workspace_id FROM stores WHERE id = $1', [account.store_id]);
  // On the simulator the account's id is its number; on Meta, Kapso and Zernio it is not.
  const own = String(account.meta?.display_phone_number || account.meta?.phone || (account.kind === 'sim' ? account.external_id : '')).replace(/\D/g, '') || null;
  return { workspaceId: s?.workspace_id ?? null, own };
}

/** Is this number one of the workspace's, by the kept list (or, while accounts is silent, Toran's own record)? No live question. */
async function linkedHere(app: App, workspaceId: number, phone: string): Promise<boolean> {
  const list = await numbersOf(app, workspaceId);
  if (list) return list.has(phone);
  return Boolean(await app.db.one('SELECT 1 FROM owner_numbers WHERE phone = $1 AND workspace_id = $2', [phone, workspaceId]));
}

/**
 * Who wrote to the store's own number: its workspace's verified owner (asked live), 'down' when they look like one and
 * accounts did not answer, else null (a customer, as before).
 */
export async function storeOwner(app: App, account: Account, from: string): Promise<Owner | 'down' | null> {
  const phone = digitsOf(from);
  if (!phone || account.channel !== 'whatsapp') return null;
  const { workspaceId, own } = await storeOf(app, account);
  if (!workspaceId || phone === own) return null;
  if (!(await linkedHere(app, workspaceId, phone))) return null;
  const r = await ownerByPhone(app, phone);
  if (!r.ok) {
    if (r.reason === 'unavailable' || r.reason === 'not_configured') return 'down';
    forgetNumbers(app, workspaceId);
    return null;
  }
  if (r.owner.workspace.id !== workspaceId) {
    forgetNumbers(app, workspaceId);
    return null;
  }
  // The assistant is Toran's: a workspace whose Toran is off has no assistant on our number either (line.ts storeOf).
  return r.owner.products.includes('toran') ? r.owner : null;
}

/**
 * A message on the store's own WhatsApp number from its own owner: the assistant answers, through the store's adapter,
 * and the result says so. null: a customer's message, for storeChannel() as before. A message the provider marked as
 * held by another app (Zernio's standby) stays on the customers' way, which keeps it unanswered.
 */
export async function storeOwnerLine(app: App, adapter: ChannelAdapter, inbound: Inbound, account: Account): Promise<RouteResult | null> {
  if (adapter.channel !== 'whatsapp' || inbound.automated) return null;
  const who = await storeOwner(app, account, inbound.from);
  if (!who) return null;
  const msg = { ...inbound, from: digitsOf(inbound.from)! };
  if (who === 'down') {
    await ownerLineDown(app, adapter, msg);
    await event(app.db, account.store_id, 'owner_store_line', { phone: msg.from, down: true });
    return { action: 'held', storeId: account.store_id };
  }
  // The number's token ended (waStore.ts): nothing can go out on it, so the owner's message is kept in their chat with
  // the assistant (the page shows it, and says to connect again), never in the customers' inbox.
  if (account.status === 'reconnect') {
    await keep(app, { storeId: account.store_id, via: 'whatsapp', phone: msg.from, workspaceId: who.workspace.id }, 'owner', String(msg.text || '').trim() || '(קובץ)', msg.from);
    await event(app.db, account.store_id, 'held', { via: 'owner_store_line', why: 'reconnect' });
    return { action: 'held', storeId: account.store_id };
  }
  const r = await ownerLine(app, adapter, msg, who, { storeId: account.store_id });
  await event(app.db, account.store_id, 'owner_store_line', { phone: msg.from, action: r.action });
  return { action: r.action === 'assistant' || r.action === 'duplicate' || r.action === 'held' ? r.action : 'owner_line', storeId: account.store_id, reply: r.reply };
}

/**
 * An echo on the store's number whose `to` is the store's own owner (the WhatsApp Business app greeting the owner's
 * message, or the owner typing to their own phone): not a customer's conversation. By the kept list only, no live
 * question: an echo is never answered, so the worst a stale list does is leave one out of the inbox.
 */
export async function ownedEcho(app: App, storeId: number, to: string): Promise<boolean> {
  const phone = digitsOf(to);
  if (!phone) return false;
  const s = await app.db.one<{ workspace_id: number | null }>('SELECT workspace_id FROM stores WHERE id = $1', [storeId]);
  return Boolean(s?.workspace_id && (await linkedHere(app, Number(s.workspace_id), phone)));
}
