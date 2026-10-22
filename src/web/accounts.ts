import { createHash } from 'node:crypto';

// Who is signed in: openfrequency-accounts answers, Toran has no login of its own. Ported from Teder's accounts.js.
//
// The browser carries one session cookie for every *.openfrequency.co.il site; Toran sends its value to accounts'
// GET /internal/session (on this machine only, with OF_INTERNAL_TOKEN) and gets back the user, the workspace, the
// role and whether the session may change anything. The format is in
// openfrequency-accounts/docs/internal-session.md.
//
// A page (GET, HEAD) may use an answer up to 60 seconds old, so browsing does not ask on every request. A change
// (every POST) always asks afresh, so an approve, a send or a setting never acts on a session that has since signed
// out, lost its membership or turned read-only; that answer replaces the cached one, and a refusal removes it. Only
// "signed in" is ever cached, keyed by the SHA-256 of the session id, never the id itself.
//
// Anything that is not a well-formed answer (a timeout, a refused connection, a 5xx, an unexpected shape) means not
// signed in. Fail closed.

type Env = Record<string, string | undefined>;

export const PRODUCT = 'toran';
export const COOKIE = { https: '__Secure-of_session', http: 'of_session' };
export const CACHE_MS = 60_000;
const MAX_CACHED = 2000;
const MIN_TOKEN = 32;

export type Session = {
  user: { id: number; email: string; name?: string | null; superadmin: boolean };
  workspace: { id: number; slug?: string; name?: string; disabled?: boolean } | null;
  role: 'client_owner' | 'client_member' | 'superadmin';
  products: string[];
  readOnly: boolean;
  viewAs: { by: { id: number; email: string }; since: string } | null;
  expiresAt?: string;
};
export type Answer = { status: number; body: any; cached: boolean };
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The session id the browser sent. Over HTTPS only the __Secure- cookie counts: a sibling subdomain can plant a plain
 * of_session for the whole domain, never a __Secure- one, so the plain name is read on plain HTTP alone (a laptop,
 * where accounts sets of_session).
 */
export function sessionIdFrom(jar: Record<string, string>, { https }: { https: boolean }): string | null {
  const v = https ? jar[COOKIE.https] : jar[COOKIE.http];
  return /^[A-Za-z0-9_-]{16,256}$/.test(String(v || '')) ? v : null;
}

/** Where the browser goes: the login (with where it was going), the sign-out page, the operator's console. */
export function accountsLinks(env: Env = process.env) {
  const base = String(env.OF_ACCOUNTS_URL || 'https://accounts.openfrequency.co.il').trim().replace(/\/+$/, '');
  return {
    home: base,
    login: (next: string) => `${base}/login?next=${encodeURIComponent(next)}`,
    logout: `${base}/logout`,
    admin: `${base}/admin`,
  };
}

const hashOf = (sid: string) => createHash('sha256').update(sid).digest('hex');

/** A 200 is believed only in the shape the contract gives it. */
function wellFormed(b: any): b is Session {
  if (!b || typeof b !== 'object') return false;
  if (!b.user || !Number.isInteger(b.user.id) || typeof b.user.email !== 'string') return false;
  if (!['client_owner', 'client_member', 'superadmin'].includes(b.role)) return false;
  if (b.role !== 'superadmin' && !b.workspace) return false;
  if (b.workspace && !Number.isInteger(b.workspace.id)) return false;
  if (!Array.isArray(b.products) || !b.products.includes(PRODUCT)) return false;
  if (typeof b.readOnly !== 'boolean') return false;
  // View-as is always read-only (the contract says so); a session that says otherwise is not believed.
  if (b.viewAs && !b.readOnly) return false;
  return true;
}

/**
 * The client. `fetchImpl` and `clock` replace the network and the time for the tests.
 * whoIs(sid, { live }) returns { status, body, cached }: 200 with the contract's body, or an error status with
 * { error }. `live` skips the cache (every POST).
 */
export function accountsClient({ env = process.env, fetchImpl = fetch as FetchLike, clock = Date.now, ttlMs = CACHE_MS, timeoutMs = 2000, log = (_: string) => {} }: { env?: Env; fetchImpl?: FetchLike; clock?: () => number; ttlMs?: number; timeoutMs?: number; log?: (line: string) => void } = {}) {
  const base = String(env.OF_ACCOUNTS_INTERNAL || 'http://127.0.0.1:4741').trim().replace(/\/+$/, '');
  const token = String(env.OF_INTERNAL_TOKEN || '').trim();
  const cache = new Map<string, { at: number; answer: { status: number; body: any } }>();

  async function ask(sid: string): Promise<{ status: number; body: any }> {
    if (token.length < MIN_TOKEN) {
      log('[accounts] OF_INTERNAL_TOKEN is not set (32 characters or more): nobody can sign in');
      return { status: 503, body: { error: 'not_configured' } };
    }
    let r: Response;
    try {
      r = await fetchImpl(`${base}/internal/session?product=${PRODUCT}`, {
        headers: { authorization: `Bearer ${token}`, 'x-of-session': sid, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) {
      log(`[accounts] unreachable at ${base}: ${e?.name === 'TimeoutError' ? 'timed out' : e?.message}`);
      return { status: 503, body: { error: 'accounts_unreachable' } };
    }
    let body: any = null;
    try {
      body = await r.json();
    } catch {
      /* not JSON: handled below */
    }
    if (r.status === 200) {
      if (wellFormed(body)) return { status: 200, body };
      log('[accounts] a 200 that does not match docs/internal-session.md: refused');
      return { status: 502, body: { error: 'bad_answer' } };
    }
    const error = typeof body?.error === 'string' ? body.error : `http_${r.status}`;
    if (['bad_token', 'not_configured', 'not_local', 'bad_host', 'bad_product'].includes(error) || r.status >= 500) log(`[accounts] ${r.status} ${error}`);
    return { status: r.status >= 500 ? 503 : r.status, body: { error } };
  }

  function remember(key: string, answer: { status: number; body: any }, t: number) {
    if (cache.size >= MAX_CACHED) {
      for (const [k, v] of cache) if (t - v.at >= ttlMs) cache.delete(k);
      // Still full of fresh answers: drop the oldest. They are asked again on their next page.
      while (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
    }
    cache.set(key, { at: t, answer });
  }

  return {
    async whoIs(sid: string | null, { live = false }: { live?: boolean } = {}): Promise<Answer> {
      if (!sid) return { status: 401, body: { error: 'no_session' }, cached: false };
      const key = hashOf(sid);
      const t = clock();
      const hit = cache.get(key);
      if (!live && hit && t - hit.at < ttlMs) return { ...hit.answer, cached: true };
      const answer = await ask(sid);
      if (answer.status === 200) remember(key, answer, t);
      else cache.delete(key);
      return { ...answer, cached: false };
    },
    get size() {
      return cache.size;
    },
  };
}
export type AccountsClient = ReturnType<typeof accountsClient>;

/**
 * What the browser gets for an answer that is not 200: off to the login (with where it was going), a page that says
 * the workspace is closed or Toran is not in its plan, or a page that says the check itself failed. The last one is
 * not a redirect: accounts would see a good session and send the browser straight back, round and round.
 */
export function refusal(status: number, error: string): 'login' | 'closed' | 'not_in_plan' | 'error' {
  if ((status === 401 && error === 'no_session') || status === 409 || (status === 403 && error === 'no_membership')) return 'login';
  if (status === 403 && error === 'workspace_disabled') return 'closed';
  if (status === 403 && error === 'product_disabled') return 'not_in_plan';
  return 'error';
}
