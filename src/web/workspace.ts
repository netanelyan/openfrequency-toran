import type { Db } from '../db/index.ts';
import type { Session } from './accounts.ts';

// One workspace's Toran. Accounts (openfrequency-accounts) says which workspace a session is in; every store here
// belongs to one workspace (stores.workspace_id), and everything else hangs off a store: its products, policies, FAQs,
// pitch page, demo chats, events and spend.
//
// A store with no workspace (NULL) is the operator's: a lead Toran found and is still selling to. Only the operator
// (the superadmin outside view-as) sees those, and every workspace's stores too. A customer's session sees its
// workspace's stores and nothing else; a store, chat or job of another workspace is "not found", as one that never was.
//
// The SQL pieces below put the workspace id in the text. It is an integer the accounts answer was checked to carry
// (accounts.ts, wellFormed), so it cannot carry SQL, and the queries keep their own $1..$n numbering.

export type Scope = {
  /** null: the operator, every store. A number: that workspace's stores only. */
  workspaceId: number | null;
  /** The superadmin outside view-as: the whole server's settings (the offer, lead discovery, developer mode). */
  operator: boolean;
  /** View-as: every POST is refused. */
  readOnly: boolean;
};

export function scopeOf(s: Session): Scope {
  const workspaceId = s.workspace ? s.workspace.id : null;
  if (workspaceId != null && !Number.isInteger(workspaceId)) throw new Error('a workspace id is an integer');
  // The contract gives a null workspace only to the superadmin; anyone else without one sees nothing (-1 matches no store).
  if (workspaceId == null && s.role !== 'superadmin') return { workspaceId: -1, operator: false, readOnly: true };
  return { workspaceId, operator: workspaceId == null && s.role === 'superadmin' && !s.readOnly, readOnly: s.readOnly };
}

/** A condition on stores (alias optional): TRUE for the operator, the workspace's stores for anyone else. */
export const storesOf = (sc: Scope, alias = '') => (sc.workspaceId == null ? 'TRUE' : `${alias ? `${alias}.` : ''}workspace_id = ${Number(sc.workspaceId)}`);

/**
 * A condition on stores: a lead the operator is selling to, so no workspace's. The review queue, the pages ready to
 * send, the reminders and the outreach (ops/queue.ts) read through it, so a customer's own store, added from /start
 * or given by the operator, never comes up there as someone to write to. The lists of every store (/leads) do not.
 */
export const selling = (alias = '') => `${alias ? `${alias}.` : ''}workspace_id IS NULL`;

/** A condition on a row that carries a store id (conversations, usage, events): its store is the scope's. */
export const storeIdIn = (sc: Scope, column: string) => (sc.workspaceId == null ? 'TRUE' : `${column} IN (SELECT id FROM stores WHERE workspace_id = ${Number(sc.workspaceId)})`);

/** May this scope see this store? */
export async function ownsStore(db: Db, sc: Scope, storeId: number): Promise<boolean> {
  if (!Number.isInteger(storeId) || storeId <= 0) return false;
  return Boolean(await db.one(`SELECT 1 FROM stores WHERE id = $1 AND ${storesOf(sc)}`, [storeId]));
}

/** The store a conversation belongs to, if the scope may see it. */
export async function ownsConversation(db: Db, sc: Scope, conversationId: number): Promise<boolean> {
  return Boolean(await db.one(`SELECT 1 FROM conversations c JOIN stores s ON s.id = c.store_id WHERE c.id = $1 AND ${storesOf(sc, 's')}`, [conversationId]));
}

/**
 * A job is the operator's, unless it is about a store of the scope's (an ingest of its store), or it is the scope's
 * own store being added from /start, before there is a store (add_store with its workspaceId).
 */
export async function ownsJob(db: Db, sc: Scope, jobId: number): Promise<boolean> {
  if (sc.workspaceId == null) return true;
  const j = await db.one<{ payload: any; result: any }>('SELECT payload, result FROM jobs WHERE id = $1', [jobId]);
  if (sc.workspaceId > 0 && Number(j?.payload?.workspaceId) === sc.workspaceId) return true;
  const storeId = Number(j?.payload?.storeId || j?.result?.storeId || 0);
  return Boolean(storeId) && ownsStore(db, sc, storeId);
}
