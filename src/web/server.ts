import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { BRAND_DIR, brandCss, ICON_FILES, MANIFEST } from '../brand.ts';
import type { App } from '../app.ts';
import { audit } from '../db/log.ts';
import { bootstrapOwner, checkPassword, clientIp, cookies, createLimiter, csrfFor, csrfOk, isHttps, makeSession, sessionCookie, sessionFrom, sessionSecret, sessionUser } from './auth.ts';
import type { PageCtx } from './ui.ts';
import { loginPage, notFoundPage } from './pages/basic.ts';
import { dashboardRoutes, headerCounts, storesCss } from './routes.ts';
import { publicRoutes } from './public.ts';

// The website: the owner's dashboard, the public pitch pages, and the WhatsApp webhook,
// in one process. It listens on 127.0.0.1 (or the container's interface behind Caddy).
//
// THE CHECKS, IN ORDER, ON EVERY REQUEST (Teder's):
//   - the Host header is ours (defeats DNS rebinding)
//   - a request under the public name came over HTTPS, which only the proxy can say
//   - public routes (static files, /s/<slug>, the beacon, the webhook) answer here with
//     their own checks; everything else needs a session
//   - every dashboard POST carries the CSRF token derived from its session, and an
//     Origin that is ours

export type Out = { status?: number; message?: string; html?: string; json?: unknown; text?: string; type?: string; redirect?: string; headers?: Record<string, string | string[]>; body?: Buffer };
export type Req = { req: IncomingMessage; url: URL; path: string; form: Record<string, string>; ip: string; secure: boolean; raw?: string };
export type DashReq = Req & { user: { id: number; name: string; role: string }; ctx: PageCtx; ajax: boolean };
export type Route<R> = [method: 'GET' | 'POST', re: RegExp, fn: (r: R, m: RegExpExecArray) => Promise<Out> | Out];

export class ActionError extends Error {
  status: number;
  problems: string[];
  constructor(message: string, status = 400, problems: string[] = []) {
    super(message);
    this.status = status;
    this.problems = problems;
  }
}

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const V = Date.now().toString(36);
export const DASH_CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function send(req: IncomingMessage, res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string | string[]> = {}) {
  const headers: Record<string, string | string[]> = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'content-security-policy': DASH_CSP, 'x-frame-options': 'DENY', ...extra };
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  if (buf.length > 1024 && /gzip/.test(String(req.headers['accept-encoding'] || '')) && /text|json|javascript|svg/.test(type)) {
    buf = gzipSync(buf);
    headers['content-encoding'] = 'gzip';
    headers.vary = 'accept-encoding';
  }
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function reply(req: IncomingMessage, res: ServerResponse, o: Out, extra: Record<string, string | string[]> = {}) {
  const headers = { ...extra, ...(o.headers || {}) };
  if (o.redirect) {
    res.writeHead(o.status || 303, { location: o.redirect, 'cache-control': 'no-store', ...headers });
    return res.end();
  }
  if (o.json !== undefined) return send(req, res, o.status || 200, JSON.stringify(o.json), 'application/json; charset=utf-8', headers);
  if (o.body) return send(req, res, o.status || 200, o.body, o.type || 'application/octet-stream', headers);
  if (o.text !== undefined) return send(req, res, o.status || 200, o.text, o.type || 'text/plain; charset=utf-8', headers);
  return send(req, res, o.status || 200, o.html || '', o.type || 'text/html; charset=utf-8', headers);
}

async function readBody(req: IncomingMessage, limit = 300_000): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new ActionError('body too large', 413);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const flashCookie = (msg: string) => `tn_flash=${encodeURIComponent(String(msg).slice(0, 200))}; Path=/; Max-Age=20; SameSite=Strict`;

const STATIC_FILES: Record<string, { file: string; type: string; cache: string }> = {
  '/static/style.css': { file: path.join(STATIC, 'style.css'), type: 'text/css; charset=utf-8', cache: 'public, max-age=3600' },
  '/static/app.js': { file: path.join(STATIC, 'app.js'), type: 'text/javascript; charset=utf-8', cache: 'public, max-age=3600' },
  '/static/pitch.css': { file: path.join(STATIC, 'pitch.css'), type: 'text/css; charset=utf-8', cache: 'public, max-age=3600' },
  '/static/pitch.js': { file: path.join(STATIC, 'pitch.js'), type: 'text/javascript; charset=utf-8', cache: 'public, max-age=3600' },
};

export function createHandler(app: App, { port, limiter = createLimiter(), failDelayMs = 400 }: { port: number; limiter?: ReturnType<typeof createLimiter>; failDelayMs?: number }) {
  const env = app.env;
  const secret = sessionSecret(env);
  const publicHost = String(env.PUBLIC_HOST || '').trim().toLowerCase() || null;
  const pitchHost = (() => {
    try {
      return env.PUBLIC_BASE_URL ? new URL(String(env.PUBLIC_BASE_URL)).host.toLowerCase() : null;
    } catch {
      return null;
    }
  })();
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(publicHost ? [publicHost] : []), ...(pitchHost ? [pitchHost] : [])]);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(publicHost ? [`https://${publicHost}`] : []), ...(pitchHost ? [`https://${pitchHost}`] : [])]);
  const ready = bootstrapOwner(app.db, env).catch((e) => app.log(`[web] could not create the owner: ${e.message}`));
  const dash = dashboardRoutes(app);
  const pub = publicRoutes(app);

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    try {
      await ready;
      const host = String(req.headers.host || '').toLowerCase();
      if (!hosts.has(host) && !(env.TORAN_ANY_HOST === '1')) return send(req, res, 421, 'wrong host', 'text/plain; charset=utf-8');
      const secure = isHttps(req);
      if ((host === publicHost || host === pitchHost) && !secure && env.TORAN_ENV === 'prod') return send(req, res, 403, 'HTTPS only', 'text/plain; charset=utf-8');
      const url = new URL(req.url || '/', `http://${host}`);
      let p: string;
      try {
        p = decodeURIComponent(url.pathname);
      } catch {
        return send(req, res, 400, 'bad path', 'text/plain; charset=utf-8');
      }
      const method = req.method === 'HEAD' ? 'GET' : (req.method as 'GET' | 'POST');

      // ---- static files and brand assets, no session
      if (method === 'GET') {
        const sf = STATIC_FILES[p];
        if (sf) return send(req, res, 200, readFileSync(sf.file), sf.type, { 'cache-control': sf.cache });
        const icon = ICON_FILES[p];
        if (icon) return send(req, res, 200, readFileSync(path.join(BRAND_DIR, icon.file)), icon.type, { 'cache-control': 'public, max-age=86400' });
        if (p === '/static/brand.css') return send(req, res, 200, brandCss(), 'text/css; charset=utf-8', { 'cache-control': 'public, max-age=3600' });
        if (p === '/static/manifest.webmanifest') return send(req, res, 200, JSON.stringify(MANIFEST), 'application/manifest+json; charset=utf-8', { 'cache-control': 'public, max-age=86400' });
        if (p === '/favicon.ico') return send(req, res, 200, readFileSync(path.join(BRAND_DIR, 'svg/toran.svg')), 'image/svg+xml', { 'cache-control': 'public, max-age=86400' });
        if (p === '/healthz') return send(req, res, 200, 'ok', 'text/plain; charset=utf-8');
        if (p === '/robots.txt') return send(req, res, 200, 'User-agent: *\nDisallow: /\n', 'text/plain; charset=utf-8');
      }

      // ---- public routes: pitch pages, the beacon, the WhatsApp webhook
      for (const [m, re, fn] of pub) {
        if (m !== method) continue;
        const mm = re.exec(p);
        if (!mm) continue;
        const raw = method === 'POST' ? await readBody(req, 64_000) : '';
        const form = /application\/x-www-form-urlencoded/.test(String(req.headers['content-type'] || '')) ? Object.fromEntries(new URLSearchParams(raw)) : {};
        return reply(req, res, await fn({ req, url, path: p, form, ip: clientIp(req), secure, raw }, mm));
      }

      // ---- login
      const jar = cookies(req);
      if (p === '/login') {
        if (method === 'POST') {
          const ip = clientIp(req);
          const wait = limiter.check(ip);
          if (wait) return send(req, res, 429, loginPage({ error: `יותר מדי ניסיונות. אפשר לנסות שוב בעוד ${Math.ceil(wait / 60)} דקות.` }), 'text/html; charset=utf-8', { 'retry-after': String(wait) });
          const origin = req.headers.origin;
          if (origin && !origins.has(origin)) return send(req, res, 403, 'cross-origin', 'text/plain; charset=utf-8');
          const form = Object.fromEntries(new URLSearchParams(await readBody(req, 4000)));
          const user = await app.db.one<{ id: number; name: string; password_hash: string }>('SELECT id, name, password_hash FROM users WHERE name = $1', [String(form.user || '').trim()]);
          if (user && checkPassword(form.password || '', user.password_hash)) {
            limiter.succeed(ip);
            await app.db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
            await audit(app.db, { actor: user.name, action: 'login' });
            res.writeHead(303, { location: '/', 'set-cookie': sessionCookie(makeSession(user.id, secret), { secure }) });
            return res.end();
          }
          limiter.fail(ip);
          await new Promise((r) => setTimeout(r, failDelayMs));
          const none = !(await app.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM users'))?.n;
          return send(req, res, 401, loginPage({ error: none ? 'עוד אין משתמש. צריך להגדיר TORAN_ADMIN_PASSWORD בקובץ private/.env ולהפעיל מחדש, או להריץ npm run user:add.' : 'שם המשתמש או הסיסמה לא נכונים.' }), 'text/html; charset=utf-8');
        }
        return send(req, res, 200, loginPage({}), 'text/html; charset=utf-8');
      }

      // ---- everything else needs a session
      const session = sessionFrom(req);
      const uid = sessionUser(session, secret);
      const user = uid ? await app.db.one<{ id: number; name: string; role: string }>('SELECT id, name, role FROM users WHERE id = $1', [uid]) : null;
      if (!user || !session) {
        if (method !== 'GET') return send(req, res, 401, JSON.stringify({ ok: false, message: 'צריך להיכנס שוב.' }), 'application/json; charset=utf-8');
        res.writeHead(303, { location: '/login' });
        return res.end();
      }
      const csrf = csrfFor(session, secret);
      const ajax = req.headers['x-tn-ajax'] === '1';
      const setCookies: string[] = [];
      const flash = jar.tn_flash || null;
      if (flash) setCookies.push('tn_flash=; Path=/; Max-Age=0; SameSite=Strict');
      const ctx: PageCtx = { title: '', csrf, side: jar.tn_side === 'mini' ? 'mini' : null, v: V, flash, dev: jar.tn_dev === '1' && user.role === 'owner', user, ...(await headerCounts(app)) };

      let form: Record<string, string> = {};
      if (method === 'POST') {
        const origin = req.headers.origin;
        if (origin && !origins.has(origin)) return send(req, res, 403, JSON.stringify({ ok: false, message: 'בקשה מאתר אחר נחסמה.' }), 'application/json; charset=utf-8');
        form = Object.fromEntries(new URLSearchParams(await readBody(req)));
        if (!csrfOk(form._csrf, session, secret)) return ajax ? send(req, res, 403, JSON.stringify({ ok: false, message: 'הדף ישן. צריך לרענן אותו.' }), 'application/json; charset=utf-8') : send(req, res, 403, 'stale page, reload it', 'text/plain; charset=utf-8');
        if (p === '/logout') {
          res.writeHead(303, { location: '/login', 'set-cookie': sessionCookie('', { secure, clear: true }) });
          return res.end();
        }
        if (p === '/settings/dev') {
          if (user.role !== 'owner') return reply(req, res, { redirect: '/settings' });
          const on = form.on === '1';
          const c = `tn_dev=${on ? '1' : ''}; Path=/; Max-Age=${on ? 31536000 : 0}; SameSite=Strict; HttpOnly${secure ? '; Secure' : ''}`;
          if (on) await audit(app.db, { actor: user.name, action: 'dev_mode' });
          return reply(req, res, { redirect: on ? '/settings#dev' : '/settings' }, { 'set-cookie': [c, flashCookie(on ? 'מצב מפתח פתוח' : 'מצב מפתח כבוי')] });
        }
      }
      if (method === 'GET' && p === '/static/stores.css') return send(req, res, 200, await storesCss(app), 'text/css; charset=utf-8', { 'cache-control': 'private, max-age=60' });

      const r: DashReq = { req, url, path: p, form, ip: clientIp(req), secure, user, ctx, ajax };
      for (const [m, re, fn] of dash) {
        if (m !== method) continue;
        const mm = re.exec(p);
        if (!mm) continue;
        try {
          const out = await fn(r, mm);
          if (method === 'POST' && out.json === undefined && !out.html) {
            // An action: JSON for the script, a redirect and a flash for a plain form.
            const msg = out.message;
            if (ajax) return reply(req, res, { json: { ok: true, message: msg, redirect: out.redirect } });
            const back = out.redirect || (req.headers.referer && new URL(req.headers.referer).host === host ? new URL(req.headers.referer).pathname + new URL(req.headers.referer).search : '/');
            return reply(req, res, { redirect: back }, { 'set-cookie': [...setCookies, ...(msg ? [flashCookie(msg)] : [])] });
          }
          return reply(req, res, out, setCookies.length ? { 'set-cookie': setCookies } : {});
        } catch (e) {
          if (!(e instanceof ActionError)) throw e;
          if (ajax || method === 'GET') return reply(req, res, { status: e.status, json: { ok: false, message: e.message, problems: e.problems } });
          return reply(req, res, { redirect: req.headers.referer ? new URL(req.headers.referer).pathname : '/' }, { 'set-cookie': flashCookie(e.problems.length ? `${e.message} ${e.problems.join(' ')}` : e.message) });
        }
      }
      return send(req, res, 404, notFoundPage({ ...ctx, title: 'לא נמצא' }), 'text/html; charset=utf-8');
    } catch (e: any) {
      // The stack goes to the log, never to the page.
      app.log(`[web] ${req.method} ${req.url}: ${e?.stack || e?.message || e}`);
      const status = e?.status || 500;
      return send(req, res, status, status === 500 ? 'משהו השתבש. הפרטים ביומן.' : String(e.message), 'text/plain; charset=utf-8');
    }
  };
}

export function listen(app: App, { port = Number(app.env.PORT) || 4710, host = app.env.TORAN_LISTEN || '127.0.0.1' }: { port?: number; host?: string } = {}): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  let inner: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  const server = createServer((req, res) => inner!(req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = (server.address() as { port: number }).port;
      inner = createHandler(app, { port: actual });
      resolve({ server, port: actual });
    });
  });
}
