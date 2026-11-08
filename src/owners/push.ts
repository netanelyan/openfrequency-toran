import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import type { App } from '../app.ts';
import type { Db } from '../db/index.ts';
import { J } from '../db/index.ts';

// Telling the owner's browser now, as Teder's src/notify (TORAN-READINESS.md P1-11): every notification is kept (the
// `notifications` table, migration 062), and each browser that asked for them in Settings gets a Web Push, an empty one
// signed with the server's VAPID key. It carries no words, so nothing about a customer's message leaves the server: the
// service worker (static/sw.js) wakes, asks GET /notifications/latest.json behind the owner's session, and shows it.
//
// A browser is subscribed in one workspace (the session's when it asked) and woken only for its stores; one subscribed
// with no workspace is the operator's, woken for every store. The endpoint is the browser's own push service: only
// the push services browsers use are written to (PUSH_HOSTS), never an address a request names (SSRF).

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The push services the browsers name: Chrome and Edge (FCM), Firefox (Mozilla), Safari (Apple), Windows. */
export const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];
export const pushHostOk = (endpoint: string) => {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
};

type Vapid = { jwk: any; publicKey: string };

/** The server's VAPID key pair, made once and kept: { publicKey (the browser's applicationServerKey), jwk }. */
export async function vapid(db: Db): Promise<Vapid> {
  const kept = (await db.one<{ value: Vapid }>("SELECT value FROM settings WHERE key = 'push:vapid'"))?.value;
  if (kept?.publicKey) return kept;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as any;
  const k = { jwk, publicKey: b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])) };
  // Two first asks at once keep one key: the second insert does nothing, and both read what is there.
  await db.query("INSERT INTO settings (key, value) VALUES ('push:vapid', $1::jsonb) ON CONFLICT (key) DO NOTHING", [J(k)]);
  return (await db.one<{ value: Vapid }>("SELECT value FROM settings WHERE key = 'push:vapid'"))!.value;
}

/** The Authorization header for one push service: a VAPID JWT for its origin, signed ES256. */
export async function vapidAuth(db: Db, endpoint: string, env: Record<string, string | undefined>, t = Date.now()): Promise<string> {
  const k = await vapid(db);
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const contact = String(env.OF_PUSH_CONTACT || '').trim() || 'mailto:accounts@openfrequency.co.il';
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(t / 1000) + 12 * 3600, sub: contact }));
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key: createPrivateKey({ key: k.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64url(sig)}, k=${k.publicKey}`;
}

/** A browser's subscription, kept by its endpoint, in the session's workspace. */
export async function subscribe(db: Db, endpoint: string, who: { userId: number | null; workspaceId: number | null }): Promise<{ ok: true } | { problem: string }> {
  if (!pushHostOk(endpoint)) return { problem: 'not a push endpoint' };
  // The same browser asking again from another session moves to that session's workspace.
  await db.query('INSERT INTO push_subs (endpoint, user_id, workspace_id) VALUES ($1, $2, $3) ON CONFLICT (endpoint) DO UPDATE SET failed = 0, user_id = EXCLUDED.user_id, workspace_id = EXCLUDED.workspace_id', [new URL(endpoint).href, who.userId, who.workspaceId]);
  return { ok: true };
}

/** A browser that turned notifications off, in the session's workspace (null: the operator, any). */
export async function unsubscribe(db: Db, endpoint: string, workspaceId: number | null): Promise<number> {
  const rows = workspaceId == null
    ? await db.query<{ id: number }>('DELETE FROM push_subs WHERE endpoint = $1 RETURNING id', [String(endpoint)])
    : await db.query<{ id: number }>('DELETE FROM push_subs WHERE endpoint = $1 AND workspace_id = $2 RETURNING id', [String(endpoint), workspaceId]);
  return rows.length;
}

export type Sender = (endpoint: string, headers: Record<string, string>) => Promise<{ status: number }>;
const sendPush: Sender = async (endpoint, headers) => {
  const r = await fetch(endpoint, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  return { status: r.status };
};

/**
 * Tell the store's people: kept, then an empty push to every browser of its workspace and the operator's. A push that
 * fails is counted (five and it is left alone), a browser that is gone (404, 410) is forgotten. Returns the id.
 */
export async function notify(app: Pick<App, 'db' | 'env' | 'log'>, n: { storeId: number; kind: string; title: string; body: string; url: string }, send: Sender = sendPush): Promise<number> {
  const { db } = app;
  const ws = (await db.one<{ workspace_id: number | null }>('SELECT workspace_id FROM stores WHERE id = $1', [n.storeId]))?.workspace_id ?? null;
  const id = (await db.one<{ id: number }>('INSERT INTO notifications (workspace_id, store_id, kind, title, body, url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [ws, n.storeId, n.kind, n.title.slice(0, 120), n.body.slice(0, 300), n.url]))!.id;
  const subs = await db.query<{ id: number; endpoint: string }>(ws == null ? 'SELECT id, endpoint FROM push_subs WHERE failed < 5 AND workspace_id IS NULL' : 'SELECT id, endpoint FROM push_subs WHERE failed < 5 AND (workspace_id IS NULL OR workspace_id = $1)', ws == null ? [] : [ws]);
  let pushed = 0;
  for (const s of subs) {
    if (!pushHostOk(s.endpoint)) continue;
    try {
      const r = await send(s.endpoint, { authorization: await vapidAuth(db, s.endpoint, app.env), ttl: '86400', urgency: 'high', 'content-length': '0' });
      if (r.status === 404 || r.status === 410) await db.query('DELETE FROM push_subs WHERE id = $1', [s.id]);
      else if (r.status >= 200 && r.status < 300) pushed++;
      else await db.query('UPDATE push_subs SET failed = failed + 1 WHERE id = $1', [s.id]);
    } catch (e: any) {
      await db.query('UPDATE push_subs SET failed = failed + 1 WHERE id = $1', [s.id]);
      app.log?.(`[push] ${e?.message || e}`);
    }
  }
  if (pushed) await db.query('UPDATE notifications SET pushed = $2 WHERE id = $1', [id, pushed]);
  return id;
}

/** The newest notification for the service worker: of this workspace, or any (null, the operator). */
export async function latestNotification(db: Db, workspaceId: number | null) {
  return workspaceId == null
    ? db.one<{ id: number; title: string; body: string; url: string }>('SELECT id, title, body, url FROM notifications ORDER BY id DESC LIMIT 1')
    : db.one<{ id: number; title: string; body: string; url: string }>('SELECT id, title, body, url FROM notifications WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1', [workspaceId]);
}
