import type { App } from '../app.ts';
import type { Out, Req, Route } from '../web/server.ts';
import { internalRefusal } from '../ops/api.ts';
import { entitlementOf } from './entitlement.ts';

// POST /internal/entitlement/changed: openfrequency-accounts says a workspace's access changed (a payment recorded, comp,
// a subscription saved by hand, a cancellation or its undo, a product or the workspace turned off or on; its
// src/web/changed.js), so the answer Toran keeps from GET /internal/entitlement (entitlement.ts, 5 minutes) is marked and
// the next page, message or automatic message asks afresh. The contract is accounts' docs/contracts/entitlement-changed.json
// (test/fixtures/contracts here).
//
// Under the checks of ops/api.ts internalRefusal (503 not_configured, 403 forbidden from anywhere but this machine or
// through Caddy, 401 bad_token), then 405 for a GET and 400 bad_workspace, in the contract's order. accounts waits 2
// seconds and never sends it again, so this is one row updated, and the answer:
//
//   200 { ok: true, workspace, cleared }     cleared: an answer was kept for it (false: never asked about, or deleted)
//
// `reason` is for the log alone: every one is acted on the same way, one not known too.

export const CHANGED_PATH = '/internal/entitlement/changed';
const PATH = /^\/internal\/entitlement\/changed$/;
const BODY_LIMIT = 4096;

export function changedRoutes(app: App): Route<Req>[] {
  return [
    ['POST', PATH, async (r): Promise<Out> => {
      const no = internalRefusal(app, r);
      if (no) return no;
      let body: any = null;
      try {
        body = (r.raw || '').length <= BODY_LIMIT ? JSON.parse(r.raw || '') : null;
      } catch {
        body = null;
      }
      const workspace = body && typeof body === 'object' && !Array.isArray(body) ? body.workspace : null;
      if (!Number.isSafeInteger(workspace) || workspace <= 0) return { status: 400, json: { error: 'bad_workspace' } };
      const reason = typeof body.reason === 'string' && /^[a-z_]{1,20}$/.test(body.reason) ? body.reason : 'unknown';
      const cleared = await entitlementOf(app).changed(workspace);
      app.log(`[entitlement] workspace ${workspace}: accounts says its access changed (${reason})${cleared ? ': asked afresh on the next page or message' : '; nothing was kept for it'}`);
      return { json: { ok: true, workspace, cleared }, headers: { 'cache-control': 'no-store' } };
    }],
    // Another method: refused as the contract says, after the same checks (a GET from outside learns nothing more).
    ['GET', PATH, async (r): Promise<Out> => internalRefusal(app, r) || { status: 405, json: { error: 'method_not_allowed' } }],
  ];
}
