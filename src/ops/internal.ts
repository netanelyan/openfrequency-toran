import { timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import type { Out, Req } from '../web/server.ts';

// The check every /internal route of Toran's makes, alone in its module so a route can import it without the dashboard
// (ops/api.ts imports ops/queue.ts, which imports channels/waStore.ts; a route that waStore.ts imports, billing/remind.ts,
// read it through api.ts and made a cycle that left api.ts reading queue.ts before it was initialized).

/** The caller is accounts (or Teder) on this machine: the shared token, a loopback socket, and not through Caddy. */
export function local(app: App, r: Req): boolean {
  const token = String(app.env.OF_INTERNAL_TOKEN || '').trim();
  if (token.length < 32 || r.req.headers['x-forwarded-for']) return false;
  if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(r.req.socket.remoteAddress || '')) return false;
  const got = Buffer.from(String(r.req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Why an internal call from accounts is refused, as accounts' contracts say it (test/fixtures/contracts: setup.json,
 * toran-ops.json, workspaces-delete.json; Teder answers the same): 503 not_configured when OF_INTERNAL_TOKEN is not set
 * here, 403 forbidden when the call is not from this machine or came through Caddy, 401 bad_token when the bearer is
 * missing or wrong. Null when it may go on.
 */
export function internalRefusal(app: App, r: Req): Out | null {
  const token = String(app.env.OF_INTERNAL_TOKEN || '').trim();
  if (token.length < 32) return { status: 503, json: { error: 'not_configured' } };
  if (r.req.headers['x-forwarded-for'] || !/^(127.0.0.1|::1|::ffff:127.0.0.1)$/.test(r.req.socket.remoteAddress || '')) return { status: 403, json: { error: 'forbidden' } };
  const got = Buffer.from(String(r.req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${token}`);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { status: 401, json: { error: 'bad_token' } };
  return null;
}
