import type { App } from './app.ts';
import type { Db } from './db/index.ts';
import { audit } from './db/log.ts';
import { MESSAGE_KINDS } from './jobs/queue.ts';
import { sweepFiles } from './jobs/retention.ts';
import { timingSafeEqual } from 'node:crypto';
import type { Out, Req, Route } from './web/server.ts';

// A workspace deleted in openfrequency-accounts (its src/accounts/erase.js asks every product the workspace ever had,
// before it deletes its own part):
//
//   POST /internal/workspaces/<id>/delete     Authorization: Bearer <OF_INTERNAL_TOKEN>, body {}
//   200  { ok: true, workspace, deleted: { stores, conversations, messages, files, ... } }, also when there was
//        nothing (a workspace that never had a store here, or one deleted before): accounts can ask again
//   401  { error: "bad_token" }        no token, or the wrong one
//   503  { error: "not_configured" }   OF_INTERNAL_TOKEN unset here, or shorter than 32 characters
//   403  { error: "not_local" }        not from this machine, or through Caddy (X-Forwarded-For)
//
// as accounts' contract has it (openfrequency-accounts docs/contracts/workspaces-delete.json): accounts reads only the
// status, treats anything but a 2xx (404 included) as a failure and deletes nothing, and waits 10 seconds. In one transaction: the workspace's stores and everything keyed by them (conversations, messages, files' rows,
// customers, channels, the automatic messages, knowledge, events, the store's spend), and everything keyed by the
// workspace alone (its owners' numbers, the assistant's messages, the lists and notifications of the owner line,
// Teder's events), the jobs that carry any of it (a store's id, the workspace, a channel's account, an owner's phone),
// the owner line's guard rows of those phones, and the operator's audit rows about those stores. Then, after the
// commit, the files on disk that no row names any more. The usage rows stay, without the store (what it cost us).
// Toran stops answering on the store's channels the moment their rows are gone: a message to them is recorded as an
// unknown account and not answered.

const count = async (db: Db, sql: string, params: unknown[]) => Number((await db.one<{ n: number }>(sql, params))?.n || 0);
const del = async (db: Db, sql: string, params: unknown[]) => (await db.query(sql, params)).length;

export async function eraseWorkspace(app: App, workspaceId: number) {
  const { db } = app;
  const ids = (await db.query<{ id: number }>('SELECT id FROM stores WHERE workspace_id = $1', [workspaceId])).map((r) => Number(r.id));
  const phones = (await db.query<{ phone: string }>('SELECT phone FROM owner_numbers WHERE workspace_id = $1', [workspaceId])).map((r) => r.phone);
  const accounts = (await db.query<{ external_id: string }>('SELECT external_id FROM channel_accounts WHERE store_id = ANY($1::int[])', [ids])).map((r) => r.external_id);
  const events = (await db.query<{ id: string }>('SELECT id FROM teder_events WHERE workspace_id = $1', [workspaceId])).map((r) => r.id);
  const deleted = await db.tx(async (t) => {
    const out: Record<string, number> = {
      conversations: await count(t, 'SELECT COUNT(*)::int AS n FROM conversations WHERE store_id = ANY($1::int[])', [ids]),
      messages: await count(t, 'SELECT COUNT(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.store_id = ANY($1::int[])', [ids]),
      files: await count(t, 'SELECT COUNT(*)::int AS n FROM files f JOIN conversations c ON c.id = f.conversation_id WHERE c.store_id = ANY($1::int[])', [ids]),
    };
    out.jobs = await del(
      t,
      `DELETE FROM jobs WHERE status <> 'running' AND (
         payload->>'storeId' = ANY($1::text[]) OR payload->>'workspace' = $2 OR payload->>'workspaceId' = $2
         OR (kind = ANY($3::text[]) AND (payload->>'account' = ANY($4::text[]) OR payload->>'from' = ANY($5::text[])))
         OR (kind = 'teder_event' AND payload->>'id' = ANY($6::text[]))) RETURNING id`,
      [ids.map(String), String(workspaceId), MESSAGE_KINDS, accounts, phones, events],
    );
    out.ownerInbound = await del(t, 'DELETE FROM owner_inbound WHERE phone = ANY($1::text[]) RETURNING ext_id', [phones]);
    out.ownerNotifications = await del(t, 'DELETE FROM owner_notifications WHERE workspace_id = $1 RETURNING id', [workspaceId]);
    out.ownerLists = await del(t, 'DELETE FROM owner_lists WHERE workspace_id = $1 RETURNING id', [workspaceId]);
    out.tederEvents = await del(t, 'DELETE FROM teder_events WHERE workspace_id = $1 RETURNING id', [workspaceId]);
    out.assistantMessages = await del(t, 'DELETE FROM assistant_messages WHERE workspace_id = $1 OR store_id = ANY($2::int[]) RETURNING id', [workspaceId, ids]);
    out.ownerNumbers = await del(t, 'DELETE FROM owner_numbers WHERE workspace_id = $1 RETURNING phone', [workspaceId]);
    out.demoRequests = await del(t, 'DELETE FROM demo_requests WHERE store_id = ANY($1::int[]) RETURNING id', [ids]);
    out.audit = await del(t, 'DELETE FROM audit WHERE store_id = ANY($1::int[]) RETURNING id', [ids]);
    out.stores = await del(t, 'DELETE FROM stores WHERE id = ANY($1::int[]) RETURNING id', [ids]);
    return out;
  });
  deleted.filesOnDisk = await sweepFiles(app);
  await audit(db, { actor: 'accounts', action: 'workspace_deleted', detail: { workspace: workspaceId, ...deleted } });
  app.log(`[erase] workspace ${workspaceId}: ${Object.entries(deleted).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing was there'}`);
  return deleted;
}

const MIN_TOKEN = 32;

/** Who may ask: this machine, not through Caddy, with the shared token. Null when allowed, else the answer. */
function refused(app: App, r: Req): Out | null {
  const token = String(app.env.OF_INTERNAL_TOKEN || '').trim();
  if (token.length < MIN_TOKEN) return { status: 503, json: { ok: false, error: 'not_configured' } };
  if (r.req.headers['x-forwarded-for'] || !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(r.req.socket.remoteAddress || '')) return { status: 403, json: { ok: false, error: 'not_local' } };
  const got = Buffer.from(String(r.req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${token}`);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { status: 401, json: { ok: false, error: 'bad_token' } };
  return null;
}

export function eraseRoutes(app: App): Route<Req>[] {
  return [
    ['POST', /^\/internal\/workspaces\/(\d{1,10})\/delete$/, async (r, m): Promise<Out> => {
      const no = refused(app, r);
      if (no) return no;
      const id = Number(m[1]);
      if (!Number.isSafeInteger(id) || id <= 0) return { status: 400, json: { ok: false, error: 'bad_workspace' } };
      try {
        return { json: { ok: true, workspace: id, deleted: await eraseWorkspace(app, id) }, headers: { 'cache-control': 'no-store' } };
      } catch (e: any) {
        app.log(`[erase] workspace ${id} failed: ${e?.stack || e?.message || e}`);
        return { status: 500, json: { ok: false, error: 'failed' } };
      }
    }],
  ];
}
