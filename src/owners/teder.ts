import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';

// Teder, for the owner line: its WhatsApp assistant API, as Teder defines it (openfrequency-teder's
// docs/assistant-api.md, src/assistant/). Teder owns the posts; this side owns the conversation and the numbers.
//
//   requests  Toran -> Teder  /internal/assistant/customers/<workspace>/...  on Teder's own port (TEDER_INTERNAL)
//   events    Teder -> Toran  POST /internal/teder/events                    (web/public.ts, owners/events.ts)
//
// Both directions are signed with OF_ASSISTANT_SECRET (the same in both .env files, 32 characters or more):
//
//   X-OF-Signature: t=<unix seconds>,n=<nonce>,s=<hex HMAC-SHA256>
//
// over six lines joined by \n: the direction (toran->teder for a request, teder->toran for an event, so a message
// signed one way is refused the other), t, the nonce, the METHOD, the path with its query, and the SHA-256 of the body.
// A t more than 300 seconds off is refused, and so is a nonce seen in the last ten minutes.
//
// What Teder answers is all the line ever says about a post. Covers, slides and captions go to the owner as Teder gave
// them, by code, never rewritten by the model.

const MIN_SECRET = 32;
export const SKEW_S = 300;
export const DIR = { out: 'toran->teder', in: 'teder->toran' } as const;

export const secretOf = (env: Record<string, string | undefined>) => {
  const s = String(env.OF_ASSISTANT_SECRET || '').trim();
  return s.length >= MIN_SECRET ? s : null;
};

const sha256 = (body: string) => createHash('sha256').update(body ?? '', 'utf8').digest('hex');
const hmac = (secret: string, text: string) => createHmac('sha256', secret).update(text, 'utf8').digest('hex');
const signedText = (dir: string, t: number, nonce: string, method: string, path: string, body: string) => [dir, t, nonce, method.toUpperCase(), path, sha256(body)].join('\n');

/** The X-OF-Signature header for one message. */
export function signature(secret: string, { dir, method, path, body = '', t = Math.floor(Date.now() / 1000), nonce = randomBytes(16).toString('base64url') }: { dir: string; method: string; path: string; body?: string; t?: number; nonce?: string }): string {
  return `t=${t},n=${nonce},s=${hmac(secret, signedText(dir, t, nonce, method, path, body))}`;
}

/** The headers for a request to Teder. */
export const signedHeaders = (secret: string, method: string, path: string, body: string, t?: number) => ({ 'x-of-signature': signature(secret, { dir: DIR.out, method, path, body, t }) });

// Nonces seen in the last ten minutes, in this process: an event played again within them is refused. (An event's id
// is kept too, so a replay after a restart is a duplicate, acknowledged and dropped.)
const seen = new Map<string, number>();

/** Why a signed message is refused, or null when it checks out. Events come in the direction teder->toran. */
export function verify(secret: string | null, headers: Record<string, string | string[] | undefined>, method: string, path: string, body: string, nowS = Math.floor(Date.now() / 1000), dir: string = DIR.in): 'not_configured' | 'stale' | 'bad_signature' | 'replay' | null {
  if (!secret) return 'not_configured';
  const parts = Object.fromEntries(String(headers['x-of-signature'] || '').split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
  if (!/^\d{1,12}$/.test(parts.t || '') || !/^[A-Za-z0-9_-]{16,64}$/.test(parts.n || '') || !/^[0-9a-f]{64}$/.test(parts.s || '')) return 'bad_signature';
  const t = Number(parts.t);
  if (Math.abs(nowS - t) > SKEW_S) return 'stale';
  const want = Buffer.from(hmac(secret, signedText(dir, t, parts.n, method, path, body)));
  const got = Buffer.from(parts.s);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return 'bad_signature';
  for (const [n, at] of seen) if (nowS - at > 2 * SKEW_S) seen.delete(n);
  if (seen.has(parts.n)) return 'replay';
  seen.set(parts.n, nowS);
  return null;
}

// ---- the shapes Teder answers with. A post's id is Teder's own, a string.

export type PostId = string | number;
export const isPostId = (v: unknown): v is PostId => (typeof v === 'string' && /^[\w.:-]{1,80}$/.test(v)) || (Number.isInteger(v) && (v as number) > 0);

export type TederSlide = { n: number; kind: string; title: string; body: string; image: string | null };
export type TederPost = { id: PostId; status: string; account?: { id: string; name: string; handle?: string }; coverLine: string; slotAt?: string | null; caption?: string; slides?: TederSlide[] };
export type Quota = { month: string; suggestions: { used: number; held?: number; limit: number; left: number }; redos: { used: number; held?: number; limit: number; left: number } };
export type TederStatus = {
  customer: number;
  accounts: { account: { id: string; name: string; handle?: string }; quota: Quota; next: { id: PostId; coverLine: string; slotAt: string; status: string }[]; week: { from: string; to: string; published: number; views: number | null; best?: { id: PostId; coverLine: string; views: number } | null } }[];
};
export type TederBundle = { post: TederPost & { platforms: Record<string, { images: string[]; caption: string; hashtags: string[]; text: string }> } };

/** A post's cover image: its first slide's. */
export const coverOf = (p: TederPost) => p.slides?.[0]?.image || null;

/** The slide and line an owner names, as Teder's edit takes them: on the cover the headline (hook) and the line under it (sub); on any other slide its title and its body. */
export function editField(slide: number, line: number): 'hook' | 'sub' | 'title' | 'body' | null {
  if (line !== 1 && line !== 2) return null;
  return slide === 1 ? (line === 1 ? 'hook' : 'sub') : line === 1 ? 'title' : 'body';
}

export type TederAnswer<T> = { ok: true; status: number; body: T } | { ok: false; status: number; error: string; body: any };
export type By = { name: string; userId?: number };

export function tederClient(app: App, workspaceId: number, by: By) {
  const base = String(app.env.TEDER_INTERNAL || 'http://127.0.0.1:4700').trim().replace(/\/+$/, '');
  const secret = secretOf(app.env);
  const who = { name: String(by.name || 'וואטסאפ').slice(0, 80), ...(by.userId ? { userId: by.userId } : {}) };

  async function call<T>(method: 'GET' | 'POST', rest: string, body?: Record<string, unknown>): Promise<TederAnswer<T>> {
    if (!secret) return { ok: false, status: 503, error: 'not_configured', body: null };
    const path = `/internal/assistant/customers/${workspaceId}/${rest}`;
    const raw = method === 'POST' ? JSON.stringify({ by: who, ...body }) : '';
    let r: Response;
    try {
      r = await fetch(`${base}${path}`, {
        method,
        headers: { accept: 'application/json', ...(raw ? { 'content-type': 'application/json' } : {}), ...signedHeaders(secret, method, path, raw) },
        body: raw || undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(method === 'POST' ? 60_000 : 10_000),
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
    if (r.ok && out && out.ok !== false) return { ok: true, status: r.status, body: out as T };
    const error = typeof out?.error === 'string' ? out.error : `http_${r.status}`;
    if (r.status >= 500 || r.status === 401) app.log(`[teder] ${method} ${rest}: ${r.status} ${error}`);
    return { ok: false, status: r.status, error, body: out };
  }

  const enc = (id: PostId) => encodeURIComponent(String(id));
  return {
    status: () => call<TederStatus>('GET', 'status'),
    pending: () => call<{ posts: TederPost[] }>('GET', 'posts/pending'),
    approve: (id: PostId) => call<{ message?: string; post: { id: PostId; status: string } }>('POST', `posts/${enc(id)}/approve`),
    reject: (id: PostId, reason: string, note: string) => call<{ message?: string; post: { id: PostId; status: string }; redo: 'writing' | 'none' | 'paused' | 'sample'; quota?: Quota }>('POST', `posts/${enc(id)}/reject`, { reason, freeText: note.slice(0, 300) }),
    edit: (id: PostId, slide: number, field: string, text: string) => call<{ message?: string; post: TederPost }>('POST', `posts/${enc(id)}/edit`, { slide, field, newText: text }),
    bundle: (id: PostId) => call<TederBundle>('GET', `posts/${enc(id)}/bundle`),
  };
}
export type TederClient = ReturnType<typeof tederClient>;
