import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { BRAND_DIR, brandCss, ICON_FILES, MANIFEST } from '../brand.ts';
import type { App } from '../app.ts';
import { audit } from '../db/log.ts';
import { clientIp, cookies, csrfFor, csrfOk, isHttps, sessionSecret } from './auth.ts';
import { accountsClient, accountsLinks, ADMIN, refusal, sessionIdFrom, type AccountsClient, type Session } from './accounts.ts';
import { ownsConversation, ownsJob, ownsStore, scopeOf, type Scope } from './workspace.ts';
import type { PageCtx } from './ui.ts';
import { notFoundPage, refusalPage } from './pages/basic.ts';
import { dashboardRoutes, headerCounts, storesCss } from './routes.ts';
import { publicRoutes } from './public.ts';
import { demoArt } from './demoArt.ts';
import { boundaryOf, parseMultipart, type Upload } from './multipart.ts';
import { MAX_BYTES } from '../channels/files.ts';

// The website: the owner's dashboard, the public pitch pages, and the WhatsApp webhook,
// in one process. It listens on 127.0.0.1 (or the container's interface behind Caddy).
//
// THE CHECKS, IN ORDER, ON EVERY REQUEST (Teder's):
//   - the Host header is ours (defeats DNS rebinding)
//   - a request under the public name came over HTTPS, which only the proxy can say
//   - public routes (static files, /healthz, /s/<slug>, the beacon, the webhook) answer
//     here with their own checks; everything else needs a session
//   - the session is openfrequency-accounts' (accounts.ts): no session goes to its login,
//     a closed workspace or a plan without Toran gets a page saying so, and a check that
//     fails (accounts down, a wrong token) lets nobody in
//   - every dashboard POST asks accounts afresh, carries the CSRF token derived from the
//     session, and an Origin that is ours; a read-only session (view-as) posts nothing; a form with a file is
//     taken only as the owner's answer in a conversation, and no bigger than one file (channels/files.ts)
//   - a page or action about one store, chat or job answers only inside its workspace
//     (workspace.ts); the whole server's settings are the operator's

export type Out = { status?: number; message?: string; html?: string; json?: unknown; text?: string; type?: string; redirect?: string; headers?: Record<string, string | string[]>; body?: Buffer };
export type Req = { req: IncomingMessage; url: URL; path: string; form: Record<string, string>; ip: string; secure: boolean; raw?: string };
export type DashReq = Req & { user: { id: number; name: string; role: string }; scope: Scope; ctx: PageCtx; ajax: boolean; files?: Upload[] };

/**
 * The operator's alone (the superadmin outside view-as): the whole server's settings, adding stores, and selling to
 * them (a lead's page, its pitch and its outreach, the review queue, the follow-ups, the plan a store is on). A
 * customer's dashboard is pages/customer.ts; their own store's answers, policies, channels and chats stay theirs.
 */
const OPERATOR_ONLY = /^\/(settings\/(offer|discover|dev|channels)|leads\/add|review\/approve-all|ops\/.*|lead\/\d+\/(build|approve|unapprove|takedown|sent|followup-sent|skip|status|notes|sample|brand|plan))$/;
/** The operator's pages. A customer who reaches one goes to their own: a store's page to what Toran knows about it. */
const OPERATOR_PAGES = /^\/(leads|review|followups|brand|job\/\d+|lead\/\d+(\/review)?)$/;
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

// The operator's dashboard lives on accounts' /admin (docs/operator.md): accounts proxies /admin/toran/... here with
// X-OF-Admin-Prefix, and Toran answers as if the prefix were its root, then puts it back on every path it hands the
// browser (links, forms, redirects, its CSS's fonts, the script's base). Toran's own name shows the product only:
// the operator is sent to /admin/toran there.
const BASE = new WeakMap<IncomingMessage, string>();

/** A body served under the admin prefix, its root-relative paths moved under it. */
export function underBase(text: string, type: string, base: string): string {
  if (/html/.test(type)) return text.replace(/(\s(?:href|action|src|formaction)=["'])\/(?!\/)/g, `$1${base}/`).replace(/<html(\s|>)/, `<html data-base="${base}"$1`);
  if (/json/.test(type)) return text.replace(/("redirect":")\/(?!\/)/g, `$1${base}/`);
  if (/css/.test(type)) return text.replace(/url\((['"]?)\/(?!\/)/g, `url($1${base}/`);
  return text;
}
const atBase = (req: IncomingMessage, location: string) => {
  const base = BASE.get(req);
  return base && location.startsWith('/') && !location.startsWith('//') ? `${base}${location}` : location;
};

/** Where a plain form goes back to: the page it was posted from, when that page is ours (under /admin, without the prefix). */
function refererPath(referer: string | undefined, origin: string | null, viaAdmin: boolean): string | null {
  if (!referer || !origin) return null;
  try {
    const u = new URL(referer);
    if (u.host !== new URL(origin).host) return null;
    if (!viaAdmin) return u.pathname + u.search;
    return u.pathname === ADMIN || u.pathname.startsWith(`${ADMIN}/`) ? (u.pathname.slice(ADMIN.length) || '/') + u.search : null;
  } catch {
    return null;
  }
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string | string[]> = {}) {
  const headers: Record<string, string | string[]> = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'content-security-policy': DASH_CSP, 'x-frame-options': 'DENY', ...extra };
  const base = BASE.get(req);
  if (base && /html|json|css/.test(type)) body = underBase(Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? ''), type, base);
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
    res.writeHead(o.status || 303, { location: atBase(req, o.redirect), 'cache-control': 'no-store', ...headers });
    return res.end();
  }
  if (o.json !== undefined) return send(req, res, o.status || 200, JSON.stringify(o.json), 'application/json; charset=utf-8', headers);
  if (o.body) return send(req, res, o.status || 200, o.body, o.type || 'application/octet-stream', headers);
  if (o.text !== undefined) return send(req, res, o.status || 200, o.text, o.type || 'text/plain; charset=utf-8', headers);
  return send(req, res, o.status || 200, o.html || '', o.type || 'text/html; charset=utf-8', headers);
}

async function readBytes(req: IncomingMessage, limit: number, tooBig = 'body too large'): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new ActionError(tooBig, 413);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}
const readBody = async (req: IncomingMessage, limit = 300_000) => (await readBytes(req, limit)).toString('utf8');

/** The one form that may carry a file: the owner's answer in a conversation, with room for one file and its text. */
const UPLOAD = /^\/chat\/\d+\/reply$/;

const flashCookie = (msg: string) => `tn_flash=${encodeURIComponent(String(msg).slice(0, 200))}; Path=/; Max-Age=20; SameSite=Strict`;

const STATIC_FILES: Record<string, { file: string; type: string; cache: string }> = {
  '/static/style.css': { file: path.join(STATIC, 'style.css'), type: 'text/css; charset=utf-8', cache: 'public, max-age=3600' },
  '/static/app.js': { file: path.join(STATIC, 'app.js'), type: 'text/javascript; charset=utf-8', cache: 'public, max-age=3600' },
  '/static/pitch.css': { file: path.join(STATIC, 'pitch.css'), type: 'text/css; charset=utf-8', cache: 'public, max-age=3600' },
  '/static/pitch.js': { file: path.join(STATIC, 'pitch.js'), type: 'text/javascript; charset=utf-8', cache: 'public, max-age=3600' },
  '/static/wa-connect.js': { file: path.join(STATIC, 'wa-connect.js'), type: 'text/javascript; charset=utf-8', cache: 'public, max-age=3600' },
  // Heebo (OFL, fonts/HEEBO-LICENSE.txt), served from here so a pitch page never calls Google Fonts.
  '/static/fonts/heebo-hebrew.woff2': { file: path.join(STATIC, 'fonts/heebo-hebrew.woff2'), type: 'font/woff2', cache: 'public, max-age=31536000, immutable' },
  '/static/fonts/heebo-latin.woff2': { file: path.join(STATIC, 'fonts/heebo-latin.woff2'), type: 'font/woff2', cache: 'public, max-age=31536000, immutable' },
};

export function createHandler(app: App, { port, accounts = accountsClient({ env: app.env, log: app.log }) }: { port: number; accounts?: AccountsClient }) {
  const env = app.env;
  const secret = sessionSecret(env);
  const links = accountsLinks(env);
  const publicHost = String(env.PUBLIC_HOST || '').trim().toLowerCase() || null;
  const pitchHost = (() => {
    try {
      return env.PUBLIC_BASE_URL ? new URL(String(env.PUBLIC_BASE_URL)).host.toLowerCase() : null;
    } catch {
      return null;
    }
  })();
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(publicHost ? [publicHost] : []), ...(pitchHost ? [pitchHost] : [])]);
  // accounts' own origin: its /admin/toran pages post from there.
  const adminOrigin = (() => {
    try {
      return new URL(links.home).origin;
    } catch {
      return null;
    }
  })();
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(publicHost ? [`https://${publicHost}`] : []), ...(pitchHost ? [`https://${pitchHost}`] : []), ...(adminOrigin ? [adminOrigin] : [])]);
  const dash = dashboardRoutes(app);
  const pub = publicRoutes(app, accounts);

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    try {
      const host = String(req.headers.host || '').toLowerCase();
      if (!hosts.has(host) && !(env.TORAN_ANY_HOST === '1')) return send(req, res, 421, 'wrong host', 'text/plain; charset=utf-8');
      const secure = isHttps(req);
      if ((host === publicHost || host === pitchHost) && !secure && env.TORAN_ENV === 'prod') return send(req, res, 403, 'HTTPS only', 'text/plain; charset=utf-8');
      let url = new URL(req.url || '/', `http://${host}`);
      // Under accounts' /admin (its proxy, from this machine): the prefix comes off, and goes back on the way out.
      const viaAdmin = req.headers['x-of-admin-prefix'] === ADMIN && (url.pathname === ADMIN || url.pathname.startsWith(`${ADMIN}/`)) && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(req.socket?.remoteAddress));
      if (viaAdmin) {
        BASE.set(req, ADMIN);
        url = new URL(`${url.pathname.slice(ADMIN.length) || '/'}${url.search}`, url);
      }
      let p: string;
      try {
        p = decodeURIComponent(url.pathname);
      } catch {
        return send(req, res, 400, 'bad path', 'text/plain; charset=utf-8');
      }
      const method = req.method === 'HEAD' ? 'GET' : (req.method as 'GET' | 'POST');
      // Never the machine-to-machine routes or the providers' webhooks under the admin prefix.
      if (viaAdmin && /^\/(internal|wa|mail|meta)\//.test(p)) return send(req, res, 404, 'not found', 'text/plain; charset=utf-8');

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
        const art = /^\/static\/demo\/([\w-]{1,60})\.svg$/.exec(p);
        if (art) return send(req, res, 200, demoArt(art[1]), 'image/svg+xml', { 'cache-control': 'public, max-age=86400' });
        if (p === '/robots.txt') return send(req, res, 200, 'User-agent: *\nDisallow: /\n', 'text/plain; charset=utf-8');
      }

      // ---- public routes: pitch pages, the beacon, the WhatsApp webhook
      for (const [m, re, fn] of pub) {
        if (m !== method) continue;
        const mm = re.exec(p);
        if (!mm) continue;
        const raw = method === 'POST' ? await readBody(req, 256_000) : '';
        const form = /application\/x-www-form-urlencoded/.test(String(req.headers['content-type'] || '')) ? Object.fromEntries(new URLSearchParams(raw)) : {};
        return reply(req, res, await fn({ req, url, path: p, form, ip: clientIp(req), secure, raw }, mm));
      }

      // ---- everything else needs a session, and openfrequency-accounts says whose (accounts.ts)
      const jar = cookies(req);
      const ajax = req.headers['x-tn-ajax'] === '1';
      const json = (status: number, body: unknown) => send(req, res, status, JSON.stringify(body), 'application/json; charset=utf-8');
      const sid = sessionIdFrom(jar, { https: secure });
      const who = await accounts.whoIs(sid, { live: method !== 'GET' });
      if (who.status !== 200 || !sid) {
        const kind = refusal(who.status, String(who.body?.error || ''));
        const here = viaAdmin && adminOrigin ? `${adminOrigin}${method === 'GET' ? req.url || ADMIN : ADMIN}` : `${secure ? 'https' : 'http'}://${host}${method === 'GET' ? req.url || '/' : '/'}`;
        if (kind === 'login') {
          // A POST is refused, never carried out: the browser signs in again and comes back to the page.
          if (method !== 'GET') return ajax ? json(401, { ok: false, message: 'צריך להיכנס שוב.', redirect: links.login(here) }) : reply(req, res, { redirect: links.login(here) });
          return reply(req, res, { redirect: links.login(here) });
        }
        const href = kind === 'closed' ? links.logout : kind === 'not_in_plan' ? links.home : here;
        const status = kind === 'error' ? 503 : 403;
        if (method !== 'GET' && ajax) return json(status, { ok: false, message: kind === 'error' ? 'אי אפשר לבדוק את הכניסה כרגע, אז שום דבר לא נשמר.' : 'החשבון הזה לא יכול להשתמש בתורן.' });
        return send(req, res, status, refusalPage(kind, href), 'text/html; charset=utf-8');
      }
      const session = who.body as Session;
      const scope = scopeOf(session);
      // /admin/toran is the operator's alone; Toran's own name shows the product, so the operator is sent to /admin.
      if (viaAdmin && !scope.operator) return send(req, res, 404, 'not found', 'text/plain; charset=utf-8');
      if (!viaAdmin && scope.operator && publicHost && host === publicHost && adminOrigin) {
        const there = `${adminOrigin}${ADMIN}${p === '/' ? '/' : p}${url.search}`;
        if (method === 'GET') return reply(req, res, { redirect: there });
        return ajax ? json(409, { ok: false, message: 'הניהול של תורן עבר ל־/admin.', redirect: there }) : send(req, res, 409, 'the operator manages Toran at /admin/toran', 'text/plain; charset=utf-8');
      }
      const user = { id: session.user.id, name: String(session.user.name || session.user.email), role: session.role };
      const csrf = csrfFor(sid, secret);
      const setCookies: string[] = [];
      const flash = jar.tn_flash || null;
      if (flash) setCookies.push('tn_flash=; Path=/; Max-Age=0; SameSite=Strict');
      const viewAs = session.viewAs ? { name: String(session.workspace?.name || session.workspace?.slug || ''), admin: links.admin } : null;
      const ctx: PageCtx = { title: '', csrf, side: jar.tn_side === 'mini' ? 'mini' : null, v: V, flash, dev: jar.tn_dev === '1' && scope.operator, user, operator: scope.operator, readOnly: scope.readOnly, viewAs, logout: links.logout, ...(await headerCounts(app, scope)) };
      const notFound = () => (method === 'GET' ? send(req, res, 404, notFoundPage({ ...ctx, title: 'לא נמצא' }), 'text/html; charset=utf-8') : ajax ? json(404, { ok: false, message: 'לא נמצא' }) : send(req, res, 404, 'not found', 'text/plain; charset=utf-8'));

      // One store, chat or job: only inside its workspace. Another workspace's is "not found", as one that never was.
      const idOf = (re: RegExp) => Number(re.exec(p)?.[1] || 0);
      const leadId = idOf(/^\/lead\/(\d+)(?:\/|$)/);
      if (leadId && !(await ownsStore(app.db, scope, leadId))) return notFound();
      const chatId = idOf(/^\/chat\/(\d+)(?:\/|$)/);
      if (chatId && !(await ownsConversation(app.db, scope, chatId))) return notFound();
      const jobId = idOf(/^\/jobs?\/(\d+)(?:\.json)?$/);
      if (jobId && !(await ownsJob(app.db, scope, jobId))) return notFound();

      if (method === 'GET' && !scope.operator && OPERATOR_PAGES.test(p)) return reply(req, res, { redirect: leadId && /^\/lead\/\d+$/.test(p) ? `/lead/${leadId}/knowledge` : '/' });

      let form: Record<string, string> = {};
      let files: Upload[] = [];
      if (method === 'POST') {
        const origin = req.headers.origin;
        if (origin && !origins.has(origin)) return json(403, { ok: false, message: 'בקשה מאתר אחר נחסמה.' });
        if (scope.readOnly) return ajax ? json(403, { ok: false, message: 'במצב צפייה אי אפשר לשנות כלום.' }) : send(req, res, 403, 'read-only: view-as changes nothing', 'text/plain; charset=utf-8');
        if (OPERATOR_ONLY.test(p) && !scope.operator) return ajax ? json(403, { ok: false, message: 'את זה משנים רק אנחנו, ב־OpenFrequency.' }) : send(req, res, 403, 'only the operator changes this', 'text/plain; charset=utf-8');
        const type = String(req.headers['content-type'] || '');
        if (/^multipart\/form-data/i.test(type)) {
          const boundary = boundaryOf(type);
          if (!UPLOAD.test(p) || !boundary) return send(req, res, 415, 'a file goes only with an answer in a conversation', 'text/plain; charset=utf-8');
          const parsed = parseMultipart(await readBytes(req, MAX_BYTES + 100_000, `הקובץ גדול מדי. אפשר לצרף עד ${MAX_BYTES / 1024 / 1024}MB.`), boundary);
          form = parsed.fields;
          files = parsed.files;
        } else form = Object.fromEntries(new URLSearchParams(await readBody(req)));
        if (!csrfOk(form._csrf, sid, secret)) return ajax ? json(403, { ok: false, message: 'הדף ישן. צריך לרענן אותו.' }) : send(req, res, 403, 'stale page, reload it', 'text/plain; charset=utf-8');
        if (p === '/settings/dev') {
          const on = form.on === '1';
          const c = `tn_dev=${on ? '1' : ''}; Path=/; Max-Age=${on ? 31536000 : 0}; SameSite=Strict; HttpOnly${secure ? '; Secure' : ''}`;
          if (on) await audit(app.db, { actor: user.name, action: 'dev_mode' });
          return reply(req, res, { redirect: on ? '/settings#dev' : '/settings' }, { 'set-cookie': [c, flashCookie(on ? 'מצב מפתח פתוח' : 'מצב מפתח כבוי')] });
        }
      }
      if (method === 'GET' && p === '/static/stores.css') return send(req, res, 200, await storesCss(app, scope), 'text/css; charset=utf-8', { 'cache-control': 'private, max-age=60' });

      const r: DashReq = { req, url, path: p, form, ip: clientIp(req), secure, user, scope, ctx, ajax, files };
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
            const back = out.redirect || refererPath(req.headers.referer, viaAdmin ? adminOrigin : `http://${host}`, viaAdmin) || '/';
            const own = out.headers?.['set-cookie'];
            return reply(req, res, { redirect: back }, { 'set-cookie': [...setCookies, ...(own ? [own].flat() : []), ...(msg ? [flashCookie(msg)] : [])] });
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
