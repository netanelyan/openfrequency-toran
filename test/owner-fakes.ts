import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verify } from '../src/owners/teder.ts';
import { INTERNAL_TOKEN } from './helpers.ts';

// Stand-ins for the two services the owner line talks to, each speaking its side of docs/owner-line.md: accounts'
// owner-phone routes (the bearer token checked) and Teder's /internal/assistant (every request's signature checked,
// a bad one refused as Teder would). Both keep what they were asked, for the tests to look at.

export const SECRET = 'test-assistant-secret-0000000000000000000';

const listen = async (server: http.Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};
const body = (req: http.IncomingMessage) => new Promise<string>((resolve) => {
  let s = '';
  req.on('data', (c) => (s += c));
  req.on('end', () => resolve(s));
});
const out = (res: http.ServerResponse, status: number, b: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(b));
};

export type FakeOwner = { phone: string; workspace: number; products?: string[]; optIn?: string | null; optOut?: string | null; disabled?: boolean; name?: string };

export async function fakeOwnerAccounts() {
  const owners = new Map<string, FakeOwner>();
  const codes = new Map<string, { workspace: number; products: string[]; optIn: boolean; used?: boolean }>();
  const calls: { method: string; path: string; body: any }[] = [];
  let down = false;
  const shape = (o: FakeOwner) => ({
    phone: o.phone,
    verifiedAt: '2026-10-20T09:00:00.000Z',
    user: { id: 100 + o.workspace, name: o.name || 'דנה', email: `owner${o.workspace}@example.test` },
    workspace: { id: o.workspace, slug: `ws${o.workspace}`, name: o.name || `עסק ${o.workspace}`, disabled: Boolean(o.disabled) },
    role: 'client_owner',
    products: o.products || ['teder'],
    optIn: o.optIn ? { at: o.optIn, source: 'accounts' } : null,
    optOut: o.optOut ? { at: o.optOut, source: 'whatsapp' } : null,
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://internal');
    const raw = req.method === 'POST' ? await body(req) : '';
    const b = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method || '', path: url.pathname + url.search, body: b });
    if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`) return out(res, 401, { error: 'bad_token' });
    if (down) return out(res, 500, { error: 'server_error' });
    if (url.pathname === '/internal/owner-phone') {
      const o = owners.get(url.searchParams.get('phone') || '');
      return o ? out(res, 200, shape(o)) : out(res, 404, { error: 'not_linked' });
    }
    if (url.pathname === '/internal/owner-phones') {
      const ws = Number(url.searchParams.get('workspace'));
      return out(res, 200, { phones: [...owners.values()].filter((o) => o.workspace === ws).map(shape) });
    }
    if (url.pathname === '/internal/owner-phone/claim') {
      const c = codes.get(String(b?.code || ''));
      if (!c) return out(res, 404, { error: 'unknown_code' });
      if (c.used) return out(res, 409, { error: 'used' });
      const had = owners.get(b.phone);
      if (had && had.workspace !== c.workspace) return out(res, 409, { error: 'phone_taken' });
      c.used = true;
      const o: FakeOwner = { phone: b.phone, workspace: c.workspace, products: c.products, optIn: c.optIn ? new Date().toISOString() : null };
      owners.set(b.phone, o);
      return out(res, 200, shape(o));
    }
    if (url.pathname === '/internal/owner-phone/consent') {
      const o = owners.get(String(b?.phone || ''));
      if (!o) return out(res, 404, { error: 'not_linked' });
      const at = new Date(Date.now() + 1).toISOString();
      if (b.optIn) Object.assign(o, { optIn: at, optOut: null });
      else Object.assign(o, { optOut: at });
      return out(res, 200, shape(o));
    }
    return out(res, 404, { error: 'not_found' });
  });
  const port = await listen(server);
  return {
    env: { OF_INTERNAL_TOKEN: INTERNAL_TOKEN, OF_ACCOUNTS_INTERNAL: `http://127.0.0.1:${port}`, OF_ACCOUNTS_URL: 'https://accounts.test' },
    owners,
    calls,
    link: (o: FakeOwner) => owners.set(o.phone, { products: ['teder'], optIn: new Date(Date.now() - 86_400_000).toISOString(), ...o }),
    code: (code: string, c: { workspace: number; products?: string[]; optIn?: boolean }) => codes.set(code, { products: ['teder'], optIn: true, ...c }),
    set down(v: boolean) {
      down = v;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakePost = { id: number | string; workspace: number; status: string; hook: string; slides?: string[][]; caption?: string };

/**
 * Teder's assistant API as its docs/assistant-api.md gives it: /internal/assistant/customers/<ws>/..., every request's
 * X-OF-Signature checked in the direction toran->teder (a bad one refused, as Teder does), the posts' shapes, the
 * refusals (wrong_state, not_approved, not_editable, too_long, refused) and the redo a rejection writes.
 */
export async function fakeTeder() {
  const posts = new Map<string, FakePost>();
  const calls: { method: string; path: string; body: any }[] = [];
  const refused: string[] = [];
  let down = false;
  let redosLeft = 5;
  const img = (p: FakePost, n: number, v = '') => `https://teder.test/m/${p.id}/instagram/${n}${v}?e=1&s=x`;
  const server = http.createServer(async (req, res) => {
    const raw = req.method === 'POST' ? await body(req) : '';
    const why = verify(SECRET, req.headers, req.method || '', req.url || '', raw, Math.floor(Date.now() / 1000), 'toran->teder');
    if (why) {
      refused.push(why);
      return out(res, 401, { ok: false, error: why });
    }
    const url = new URL(req.url || '/', 'http://internal');
    const b = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method || '', path: url.pathname, body: b });
    if (down) return out(res, 500, { ok: false, error: 'server_error' });
    const m = /^\/internal\/assistant\/customers\/(\d+)\/(.+)$/.exec(url.pathname);
    if (!m) return out(res, 404, { ok: false, error: 'not_found' });
    const ws = Number(m[1]);
    const rest = m[2];
    const view = (p: FakePost) => ({ id: String(p.id), status: p.status, account: { id: 'acc', name: 'חשבון', handle: 'acc' }, coverLine: p.hook, slotAt: null, caption: p.caption || '', slides: (p.slides || []).map((l, i) => ({ n: i + 1, kind: i === 0 ? 'cover' : 'item', title: l[0] || '', body: l[1] || '', image: img(p, i + 1) })) });
    const mine = [...posts.values()].filter((p) => p.workspace === ws);
    if (rest === 'status') return out(res, 200, { ok: true, customer: ws, accounts: [{ account: { id: 'acc', name: 'חשבון' }, quota: { month: '2026-10', suggestions: { used: 12, held: 0, limit: 40, left: 28 }, redos: { used: 3, held: 0, limit: 10, left: 7 } }, next: [], week: { from: '', to: '', published: 2, views: 1500, best: null } }] });
    if (rest === 'posts/pending') return out(res, 200, { ok: true, customer: ws, posts: mine.filter((p) => p.status === 'queued').map(view) });
    const pm = /^posts\/([\w-]+)\/(approve|reject|edit|bundle)$/.exec(rest);
    const p = pm ? posts.get(pm[1]) : null;
    if (!pm || !p || p.workspace !== ws) return out(res, 404, { ok: false, error: 'not_found' });
    if (pm[2] === 'bundle') {
      if (!['approved', 'publishing', 'published'].includes(p.status)) return out(res, 409, { ok: false, error: 'not_approved' });
      return out(res, 200, { ok: true, post: { ...view(p), platforms: { instagram: { images: (p.slides || []).map((_, i) => img(p, i + 1)), caption: p.caption || '', hashtags: ['#תדר'], text: p.caption || '' } } } });
    }
    if (p.status !== 'queued') return out(res, 409, { ok: false, error: 'wrong_state', message: 'הפוסט לא מחכה לאישור' });
    if (pm[2] === 'approve') {
      p.status = 'approved';
      return out(res, 200, { ok: true, message: 'אושר', post: { id: String(p.id), status: 'approved' } });
    }
    if (pm[2] === 'reject') {
      p.status = 'rejected';
      const redo = redosLeft > 0 ? 'writing' : 'none';
      if (redosLeft > 0) redosLeft--;
      return out(res, 200, { ok: true, message: 'נדחה', post: { id: String(p.id), status: 'rejected' }, redo });
    }
    const slide = p.slides?.[b.slide - 1];
    if (!slide || b.slide === (p.slides || []).length && (p.slides || []).length > 2) return out(res, 422, { ok: false, error: 'not_editable' });
    if (String(b.newText).length > 40) return out(res, 422, { ok: false, error: 'too_long', max: 40 });
    if (String(b.newText).includes('הכי טוב בעולם')) return out(res, 422, { ok: false, error: 'refused', message: 'בדיקת העובדות עצרה את השינוי: אין מקור לטענה.', problems: ['superlative'] });
    slide[b.field === 'hook' || b.field === 'title' ? 0 : 1] = b.newText;
    const v = view(p);
    v.slides = v.slides.map((x) => (x.n === b.slide ? { ...x, image: img(p, x.n, '-v2') } : x));
    return out(res, 200, { ok: true, message: 'נשמר', post: v });
  });
  const port = await listen(server);
  return {
    env: { OF_ASSISTANT_SECRET: SECRET, TEDER_INTERNAL: `http://127.0.0.1:${port}` },
    posts: { get: (id: number | string) => posts.get(String(id)) },
    calls,
    refused,
    add: (p: Omit<FakePost, 'status'> & { status?: string }) => posts.set(String(p.id), { status: 'queued', slides: [['כותרת', 'שורה'], ['שקופית שתיים', 'עוד שורה']], caption: `הכיתוב של ${p.id} #תדר`, ...p }),
    set down(v: boolean) {
      down = v;
    },
    set redos(n: number) {
      redosLeft = n;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
