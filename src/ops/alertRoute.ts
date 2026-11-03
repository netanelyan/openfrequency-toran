import type { App } from '../app.ts';
import type { Out, Req, Route } from '../web/server.ts';
import { internalRefusal } from './api.ts';
import { alertOperator } from './alert.ts';

// POST /internal/ops/alert: Teder hands Toran one of its operator alerts (its src/notify/operator.js), so it reaches the
// owner's WhatsApp the way Toran's own do (alert.ts): one operator_alert template from our number to TORAN_ALERT_WA, under
// the same limits (its key once in its window, as teder:<key>; one key once an hour on the phone; none for an hour after
// Meta refuses one; at most ten an hour over both products). Toran runs no command for it: Teder runs its own.
//
// Under the checks of api.ts internalRefusal (503 not_configured, 403 forbidden from anywhere but this machine or
// through Caddy, 401 bad_token), then 405 for a GET and 400 bad_alert, and the answer, once the alert is said:
//
//   { "key": "nothing-drafted:demo", "title": "Teder: ...", "body": "...", "everyMinutes": 1200 }
//   200 { ok: true, due }     due: said now; false when the same key was said inside its everyMinutes
//
// Teder and Toran alone use it, so it is not one of accounts' contracts: test/fixtures/ops-alert.json is the example,
// the same file in Teder, and both sides' tests read it.

export const ALERT_PATH = '/internal/ops/alert';
const PATH = /^\/internal\/ops\/alert$/;
const BODY_LIMIT = 8192;
const KEY = /^[A-Za-z0-9_.:@-]{1,120}$/;
/** The longest window a key may ask for: 30 days. */
const MAX_MINUTES = 30 * 24 * 60;

export type HandedAlert = { key: string; title: string; body: string; everyMinutes: number };

/** The alert in a request's body, or null when it is not one. `body` may be left out (none), `everyMinutes` too (60). */
export function readAlert(raw: string | undefined): HandedAlert | null {
  const text = raw || '';
  if (Buffer.byteLength(text, 'utf8') > BODY_LIMIT) return null;
  let b: any;
  try {
    b = JSON.parse(text);
  } catch {
    return null;
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const { key, title, body = '', everyMinutes = 60 } = b;
  if (typeof key !== 'string' || !KEY.test(key)) return null;
  if (typeof title !== 'string' || !title.trim() || title.length > 500) return null;
  if (typeof body !== 'string' || body.length > 4000) return null;
  if (!Number.isSafeInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > MAX_MINUTES) return null;
  return { key, title, body, everyMinutes };
}

export function alertRoutes(app: App): Route<Req>[] {
  return [
    ['POST', PATH, async (r): Promise<Out> => {
      const no = internalRefusal(app, r);
      if (no) return no;
      const a = readAlert(r.raw);
      if (!a) return { status: 400, json: { error: 'bad_alert' } };
      const due = await alertOperator(app, `teder:${a.key}`, a.title, a.body, { everyMinutes: a.everyMinutes, from: 'teder' });
      return { json: { ok: true, due }, headers: { 'cache-control': 'no-store' } };
    }],
    // Another method: refused after the same checks, so a GET from outside learns nothing more.
    ['GET', PATH, async (r): Promise<Out> => internalRefusal(app, r) || { status: 405, json: { error: 'method_not_allowed' } }],
  ];
}
