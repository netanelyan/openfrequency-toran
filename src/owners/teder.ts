import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';

// Teder, for the owner line (docs/owner-line.md section 2): its internal assistant API, and the signature on every
// request either way. One secret, OF_ASSISTANT_SECRET, the same in both services' .env:
//
//   X-OF-Timestamp: <unix seconds>
//   X-OF-Signature: v1=<hex HMAC-SHA256(secret, "v1\n" ts "\n" METHOD "\n" pathWithQuery "\n" sha256hex(body))>
//
// A timestamp more than 300 seconds off is refused, so a captured request cannot be played back later.
//
// What Teder answers is all the line ever says about a post. Covers, slides and captions go to the owner as Teder
// gave them, by code, never rewritten by the model.

const MIN_SECRET = 32;
export const SKEW_S = 300;

export const secretOf = (env: Record<string, string | undefined>) => {
  const s = String(env.OF_ASSISTANT_SECRET || '').trim();
  return s.length >= MIN_SECRET ? s : null;
};

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function signature(secret: string, ts: number, method: string, pathQuery: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`v1\n${ts}\n${method.toUpperCase()}\n${pathQuery}\n${sha256(body)}`, 'utf8').digest('hex')}`;
}

export function signedHeaders(secret: string, method: string, pathQuery: string, body: string, nowS = Math.floor(Date.now() / 1000)) {
  return { 'x-of-timestamp': String(nowS), 'x-of-signature': signature(secret, nowS, method, pathQuery, body) };
}

/** Why a signed request is refused, or null when it checks out. */
export function verify(secret: string | null, headers: Record<string, string | string[] | undefined>, method: string, pathQuery: string, body: string, nowS = Math.floor(Date.now() / 1000)): 'not_configured' | 'stale' | 'bad_signature' | null {
  if (!secret) return 'not_configured';
  const ts = Number(headers['x-of-timestamp']);
  if (!Number.isInteger(ts) || Math.abs(nowS - ts) > SKEW_S) return 'stale';
  const got = Buffer.from(String(headers['x-of-signature'] || ''));
  const want = Buffer.from(signature(secret, ts, method, pathQuery, body));
  return got.length === want.length && timingSafeEqual(got, want) ? null : 'bad_signature';
}

// ---- the shapes Teder answers with

export type TederPost = { id: number; account?: { id: string; name: string }; status: string; hook: string; slotAt?: string | null; slides?: number; cover?: { url: string } | null };
export type TederSlide = { idx: number; kind?: string; lines: string[]; image?: { url: string } | null };
export type TederStatus = {
  workspace: number;
  accounts: { id: string; name: string; mode?: string; status?: string }[];
  pending: number;
  approvedThisWeek?: number;
  publishedThisWeek?: number;
  quota?: { month: string; suggested: { used: number; limit: number }; redos: { used: number; limit: number } };
  quiet: { now: boolean; until: string | null; reason: string | null };
  quietHours?: { start: string; end: string } | null;
  shabbat?: boolean;
};

export type TederAnswer<T> = { ok: true; status: number; body: T } | { ok: false; status: number; error: string; body: any };

export function tederClient(app: App, workspaceId: number, actor: string) {
  const base = String(app.env.TEDER_INTERNAL || 'http://127.0.0.1:4701').trim().replace(/\/+$/, '');
  const secret = secretOf(app.env);

  async function call<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<TederAnswer<T>> {
    if (!secret) return { ok: false, status: 503, error: 'not_configured', body: null };
    const pathQuery = method === 'GET' ? `${path}${path.includes('?') ? '&' : '?'}workspace=${workspaceId}` : path;
    const raw = method === 'POST' ? JSON.stringify({ workspace: workspaceId, actor, ...body }) : '';
    let r: Response;
    try {
      r = await fetch(`${base}${pathQuery}`, {
        method,
        headers: { accept: 'application/json', ...(raw ? { 'content-type': 'application/json' } : {}), ...signedHeaders(secret, method, pathQuery, raw) },
        body: raw || undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(method === 'POST' ? 30_000 : 8000),
      });
    } catch (e: any) {
      app.log(`[teder] unreachable at ${base}: ${e?.name === 'TimeoutError' ? 'timed out' : e?.message}`);
      return { ok: false, status: 503, error: 'unavailable', body: null };
    }
    let out: any = null;
    try {
      out = await r.json();
    } catch {
      /* not JSON */
    }
    if (r.ok && out && typeof out === 'object') return { ok: true, status: r.status, body: out as T };
    const error = typeof out?.error === 'string' ? out.error : `http_${r.status}`;
    if (r.status >= 500 || r.status === 401 || r.status === 403) app.log(`[teder] ${method} ${path}: ${r.status} ${error}`);
    return { ok: false, status: r.status, error, body: out };
  }

  const P = '/internal/assistant';
  return {
    status: () => call<TederStatus>('GET', `${P}/status`),
    pending: () => call<{ posts: TederPost[] }>('GET', `${P}/posts?status=queued`),
    post: (id: number) => call<{ post: TederPost & { caption?: string; hashtags?: string[]; slideList?: TederSlide[] } }>('GET', `${P}/posts/${id}`),
    approve: (id: number) => call<{ post: { id: number; status: string } }>('POST', `${P}/posts/${id}/approve`),
    reject: (id: number, reason: string, note: string) => call<{ post: { id: number; status: string }; replacement: { id: number; status: string } | null; redosLeft?: number }>('POST', `${P}/posts/${id}/reject`, { reason, note }),
    edit: (id: number, slide: number, line: number, text: string) => call<{ post: TederPost; slide: TederSlide }>('POST', `${P}/posts/${id}/edit`, { slide, line, text }),
    bundle: (id: number) => call<{ post: { id: number; hook: string }; images: { url: string }[]; caption: string }>('GET', `${P}/posts/${id}/bundle`),
  };
}
export type TederClient = ReturnType<typeof tederClient>;
