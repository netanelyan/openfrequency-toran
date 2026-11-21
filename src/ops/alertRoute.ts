import type { App } from '../app.ts';
import type { Out, Req, Route } from '../web/server.ts';
import { internalRefusal } from './api.ts';
import { alertOperator } from './alert.ts';

// POST /internal/ops/alert: Teder hands Toran one of its operator alerts (its src/notify/operator.js), so it reaches the
// owner's WhatsApp the way Toran's own do (alert.ts): one operator_alert template from our number to TORAN_ALERT_WA, under
// the same limits (its key once in its window, as teder:<key>; one key once an hour on the phone; none for an hour after
// Meta refuses one; at most ten an hour over every source). Toran runs no command for it: Teder runs its own.
//
// על הקו (alhakav), the service whose WhatsApp conversations Toran answers from POST /internal/company/answer
// (channels/external.ts), hands its own alerts the same way, with "product": "alhakav": someone new wrote, someone wants
// to join, a handoff, a transfer's screenshot came. Its keys are alhakav:<key>, its title goes as it wrote it, and no
// command runs for it either. Left out, product is "teder", as every alert was before it.
//
// Under the checks of api.ts internalRefusal (503 not_configured, 403 forbidden from anywhere but this machine or
// through Caddy, 401 bad_token), then 405 for a GET and 400 bad_alert, and the answer, once the alert is said:
//
//   { "key": "nothing-drafted:demo", "title": "Teder: ...", "body": "...", "everyMinutes": 1200, "product": "teder" }
//   200 { ok: true, due }     due: said now; false when the same key was said inside its everyMinutes
//
// Teder and Toran alone share its example: test/fixtures/ops-alert.json, the same file in Teder, which both sides'
// tests read, and which has no product (Teder sends none). It is not one of accounts' contracts.

export const ALERT_PATH = '/internal/ops/alert';
const PATH = /^\/internal\/ops\/alert$/;
const BODY_LIMIT = 8192;
const KEY = /^[A-Za-z0-9_.:@-]{1,120}$/;
/** The longest window a key may ask for: 30 days. */
const MAX_MINUTES = 30 * 24 * 60;

/** Who may hand Toran an alert here: its key is kept as <product>:<key>, and the phone reads its title as written. */
export const ALERT_PRODUCTS = ['teder', 'alhakav'] as const;
export type AlertProduct = (typeof ALERT_PRODUCTS)[number];

export type HandedAlert = { key: string; title: string; body: string; everyMinutes: number; product: AlertProduct };

/**
 * The alert in a request's body, or null when it is not one. `body` may be left out (none), `everyMinutes` too (60),
 * and `product` (Teder's).
 */
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
  const { key, title, body = '', everyMinutes = 60, product = 'teder' } = b;
  if (typeof key !== 'string' || !KEY.test(key)) return null;
  if (typeof title !== 'string' || !title.trim() || title.length > 500) return null;
  if (typeof body !== 'string' || body.length > 4000) return null;
  if (!Number.isSafeInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > MAX_MINUTES) return null;
  if (!(ALERT_PRODUCTS as readonly unknown[]).includes(product)) return null;
  return { key, title, body, everyMinutes, product };
}

export function alertRoutes(app: App): Route<Req>[] {
  return [
    ['POST', PATH, async (r): Promise<Out> => {
      const no = internalRefusal(app, r);
      if (no) return no;
      const a = readAlert(r.raw);
      if (!a) return { status: 400, json: { error: 'bad_alert' } };
      const due = await alertOperator(app, `${a.product}:${a.key}`, a.title, a.body, { everyMinutes: a.everyMinutes, from: a.product });
      return { json: { ok: true, due }, headers: { 'cache-control': 'no-store' } };
    }],
    // Another method: refused after the same checks, so a GET from outside learns nothing more.
    ['GET', PATH, async (r): Promise<Out> => internalRefusal(app, r) || { status: 405, json: { error: 'method_not_allowed' } }],
  ];
}
