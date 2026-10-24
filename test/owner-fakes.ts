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

export type FakePost = { id: number; workspace: number; status: string; hook: string; slides?: string[][]; caption?: string };

export async function fakeTeder() {
  const posts = new Map<number, FakePost>();
  const calls: { method: string; path: string; body: any }[] = [];
  const refused: string[] = [];
  let quiet: { now: boolean; until: string | null; reason: string | null } = { now: false, until: null, reason: null };
  let down = false;
  let redosLeft = 5;
  let nextId = 900;
  const server = http.createServer(async (req, res) => {
    const raw = req.method === 'POST' ? await body(req) : '';
    const why = verify(SECRET, req.headers, req.method || '', req.url || '', raw);
    if (why) {
      refused.push(why);
      return out(res, 401, { error: why });
    }
    const url = new URL(req.url || '/', 'http://internal');
    const b = raw ? JSON.parse(raw) : null;
    const ws = Number(b?.workspace ?? url.searchParams.get('workspace'));
    calls.push({ method: req.method || '', path: url.pathname, body: b });
    if (down) return out(res, 500, { error: 'server_error' });
    const listed = (p: FakePost) => ({ id: p.id, number: null, account: { id: 'acc', name: 'חשבון' }, status: p.status, hook: p.hook, slotAt: null, slides: (p.slides || []).length, cover: { url: `https://teder.test/m/${p.id}-1.jpg` } });
    const P = '/internal/assistant';
    if (url.pathname === `${P}/status`) {
      const mine = [...posts.values()].filter((p) => p.workspace === ws);
      return out(res, 200, { workspace: ws, accounts: [{ id: 'acc', name: 'חשבון', mode: 'approve', status: 'active' }], pending: mine.filter((p) => p.status === 'queued').length, approvedThisWeek: mine.filter((p) => p.status === 'approved').length, publishedThisWeek: 2, quota: { month: '2026-10', suggested: { used: 31, limit: 40 }, redos: { used: 3, limit: 10 } }, quiet, quietHours: { start: '22:00', end: '08:00' }, shabbat: true });
    }
    if (url.pathname === `${P}/posts`) return out(res, 200, { posts: [...posts.values()].filter((p) => p.workspace === ws && p.status === 'queued').map(listed) });
    const m = /^\/internal\/assistant\/posts\/(\d+)(?:\/(approve|reject|edit|bundle))?$/.exec(url.pathname);
    const p = m ? posts.get(Number(m[1])) : null;
    if (!m || !p || p.workspace !== ws) return out(res, 404, { error: 'not_found' });
    if (!m[2]) return out(res, 200, { post: { ...listed(p), caption: p.caption || '', hashtags: [], slideList: (p.slides || []).map((lines, i) => ({ idx: i + 1, kind: i ? 'item' : 'cover', lines, image: { url: `https://teder.test/m/${p.id}-${i + 1}.jpg` } })) } });
    if (m[2] === 'bundle') return out(res, 200, { post: { id: p.id, hook: p.hook }, images: (p.slides || [[]]).map((_, i) => ({ url: `https://teder.test/m/${p.id}-${i + 1}.jpg` })), caption: p.caption || '' });
    if (p.status !== 'queued') return out(res, 409, { error: 'not_pending' });
    if (m[2] === 'approve') {
      p.status = 'approved';
      return out(res, 200, { post: { id: p.id, status: 'approved' } });
    }
    if (m[2] === 'reject') {
      p.status = 'rejected';
      const replacement = redosLeft > 0 ? { id: nextId++, status: 'drafting' } : null;
      if (replacement) redosLeft--;
      return out(res, 200, { post: { id: p.id, status: 'rejected' }, replacement, redosLeft });
    }
    const lines = p.slides?.[b.slide - 1];
    if (!lines || !lines[b.line - 1]) return out(res, 400, { error: 'bad_line' });
    if (String(b.text).length > 40) return out(res, 422, { error: 'failed_checks', problems: ['השורה ארוכה מ-6 מילים'] });
    lines[b.line - 1] = b.text;
    return out(res, 200, { post: listed(p), slide: { idx: b.slide, lines, image: { url: `https://teder.test/m/${p.id}-${b.slide}-v2.jpg` } } });
  });
  const port = await listen(server);
  return {
    env: { OF_ASSISTANT_SECRET: SECRET, TEDER_INTERNAL: `http://127.0.0.1:${port}` },
    posts,
    calls,
    refused,
    add: (p: Omit<FakePost, 'status'> & { status?: string }) => posts.set(p.id, { status: 'queued', slides: [['כותרת', 'שורה'], ['שקופית שתיים', 'עוד שורה']], caption: `הכיתוב של ${p.id} #תדר`, ...p }),
    set quiet(q: { now: boolean; until: string | null; reason: string | null }) {
      quiet = q;
    },
    set down(v: boolean) {
      down = v;
    },
    set redos(n: number) {
      redosLeft = n;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
