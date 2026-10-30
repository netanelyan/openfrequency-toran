import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { type App, makeApp } from '../src/app.ts';
import { openDb } from '../src/db/index.ts';
import { exampleFetcher } from '../src/demo.ts';
import { scriptedClient, type Script } from '../src/agent/llm/scripted.ts';
import { simProvider } from '../src/wa/providers.ts';

// A throwaway app for a test: an in-memory database, the fictional store as the whole
// internet, a scripted model, the simulated WhatsApp provider, and a private folder in
// the temp directory. No network, no keys, no subscription.

export async function testApp({ script }: { script?: Script } = {}): Promise<App> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'toran-test-'));
  const env = { TORAN_HOME: home, TORAN_EMBED: 'off', TORAN_LLM: 'scripted', SESSION_SECRET: 'x'.repeat(40) } as Record<string, string>;
  const db = await openDb({ memory: true });
  const app = await makeApp({ env, db, fetcher: exampleFetcher(), llm: scriptedClient(script), wa: simProvider(), quiet: true });
  app.render = async () => null;
  return app;
}

// ---- a stand-in for openfrequency-accounts' GET /internal/session (that repository's docs/internal-session.md)

export const INTERNAL_TOKEN = 'test-internal-token-000000000000000000000';

type Canned = Record<string, unknown> | { status: number; body: unknown };

/**
 * Answers each session id with what it was given ({ status, body }, or a 200 body), and anything else with 401
 * no_session; a wrong token gets 401 bad_token, as accounts does. `calls` counts the questions.
 */
export async function fakeAccounts() {
  const answers = new Map<string, Canned>();
  const entitlements = new Map<number, 'unpaid' | 'gone' | 'down'>();
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    const url = new URL(req.url || '/', 'http://internal');
    const out = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    // The paywall's question (src/billing/entitlement.ts): every workspace has paid, unless a test said otherwise.
    if (url.pathname === '/internal/entitlement') {
      if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`) return out(401, { error: 'bad_token' });
      const ws = Number(url.searchParams.get('workspace'));
      const e = entitlements.get(ws);
      if (e === 'gone') return out(404, { error: 'no_workspace' });
      if (e === 'down') return out(503, { error: 'down' });
      const allowed = e !== 'unpaid';
      return out(200, { workspace: ws, product: url.searchParams.get('product'), enabled: true, access: allowed ? 'paid' : 'unpaid', allowed, paidThrough: allowed ? LATER : null, cancelAt: null });
    }
    if (url.pathname !== '/internal/session') return out(404, { error: 'not_found' });
    if (url.searchParams.get('product') !== 'toran') return out(400, { error: 'bad_product' });
    if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`) return out(401, { error: 'bad_token' });
    const a = answers.get(String(req.headers['x-of-session'] || ''));
    if (!a) return out(401, { error: 'no_session' });
    return 'status' in a && typeof a.status === 'number' ? out(a.status, (a as any).body) : out(200, a);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  let n = 0;
  return {
    port,
    env: { OF_INTERNAL_TOKEN: INTERNAL_TOKEN, OF_ACCOUNTS_INTERNAL: `http://127.0.0.1:${port}`, OF_ACCOUNTS_URL: 'https://accounts.test' },
    get calls() {
      return calls;
    },
    /** A new session id that answers `answer`; returns { sid, cookie } (the cookie as a browser on plain HTTP sends it). */
    session(answer: Canned) {
      const sid = `s${String(++n).padStart(3, '0')}${randomBytes(24).toString('base64url')}`;
      answers.set(sid, answer);
      return { sid, cookie: `of_session=${sid}` };
    },
    /** Change what a session answers from now on (signed out: answer(sid, null)). */
    answer(sid: string, answer: Canned | null) {
      if (answer == null) answers.delete(sid);
      else answers.set(sid, answer);
    },
    /** What accounts says of a workspace's Toran from now on: paid (null, the default), unpaid, gone (404) or down (503). */
    paid(workspaceId: number, state: 'unpaid' | 'gone' | 'down' | null) {
      if (state == null) entitlements.delete(workspaceId);
      else entitlements.set(workspaceId, state);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const LATER = '2099-01-01T00:00:00.000Z';

/** A customer of one workspace, as /internal/session describes them. */
export const customer = (workspaceId: number, { products = ['toran'] }: { products?: string[] } = {}) => ({
  user: { id: 100 + workspaceId, email: `owner${workspaceId}@example.test`, name: 'owner', superadmin: false },
  workspace: { id: workspaceId, slug: `ws${workspaceId}`, name: `Workspace ${workspaceId}`, disabled: false },
  role: 'client_owner',
  products,
  readOnly: false,
  viewAs: null,
  expiresAt: LATER,
});

/** The superadmin outside view-as: Toran's operator. */
export const operator = () => ({ user: { id: 1, email: 'operator@example.test', name: 'operator', superadmin: true }, workspace: null, role: 'superadmin', products: ['teder', 'toran'], readOnly: false, viewAs: null, expiresAt: LATER });

/** The superadmin viewing one workspace as its customer sees it: read-only. */
export const viewingAs = (workspaceId: number) => ({
  user: { id: 1, email: 'operator@example.test', name: '', superadmin: true },
  workspace: { id: workspaceId, slug: `ws${workspaceId}`, name: `Workspace ${workspaceId}`, disabled: false },
  role: 'superadmin',
  products: ['toran'],
  readOnly: true,
  viewAs: { by: { id: 1, email: 'operator@example.test' }, since: '2026-10-22T10:00:00.000Z' },
  expiresAt: LATER,
});
