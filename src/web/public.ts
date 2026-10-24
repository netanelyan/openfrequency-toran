import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import { canonicalDomain, homeUrl } from '../core/urls.ts';
import { audit } from '../db/log.ts';
import { goneHtml, pitchData, pitchPage, themeCss } from '../pitch/page.ts';
import { recordBeacon, recordOpen } from '../pitch/track.ts';
import { enqueue } from '../jobs/queue.ts';
import { cookies } from './auth.ts';
import { sessionIdFrom, type AccountsClient, type Session } from './accounts.ts';
import { ownsStore, scopeOf } from './workspace.ts';
import { enabledChannels, publicChannels } from '../channels/config.ts';
import type { Out, Req, Route } from './server.ts';
import { J } from '../db/index.ts';
import { secretOf, verify } from '../owners/teder.ts';
import { EVENT_TYPES } from '../owners/events.ts';
import { opsRoutes } from '../ops/api.ts';

// The public routes, answered without a session:
//
//   GET  /s/<slug>             a store's pitch page (noindex). Open to anyone only once it
//                              is approved and complete (pitch/ready.ts); a signed-in
//                              session whose workspace has the store (the operator: every
//                              store) sees it always, with what holds it back; a taken-down page is
//                              410 for everyone else
//   GET  /s/<slug>/theme.css   its colours
//   POST /t                    the page's beacon (scroll depth, demo taps), rate-limited
//   POST /wa/twilio            Twilio's webhook: signature checked, acknowledged at once,
//                              the message handled by the worker (channels/route.ts)
//   POST /wa/sim               the simulator's webhook (development only)
//   POST /mail/resend          Resend's webhook (email.received, email.bounced, email.complained): Svix signature
//                              checked, acknowledged at once, handled by the worker. 404 while TORAN_CHANNELS has
//                              no email
//   POST /mail/sim             the email simulator's webhook (development only)
//   GET  /channels.json        each channel's state (off, demo, live) for the website's "בקרוב" tags; nothing about
//                              any store
//   POST /internal/lead        a demo asked for on openfrequency.co.il (openfrequency-web/server/lead.mjs): from this
//                              machine only, with OF_INTERNAL_TOKEN and no X-Forwarded-For (so never through Caddy).
//                              It is written down with its code (REQ-XXXXXX) and waits: only when the person writes
//                              to the demo number with that code is the store added (channels/request.ts).
//   GET  /internal/ops         the operator's dashboard as data, for accounts' /admin (ops/api.ts); its POSTs are
//                              the dashboard's buttons. From this machine only, with OF_INTERNAL_TOKEN
//   POST /internal/teder/events Teder's news for an owner (docs/owner-line.md): from this machine only, no
//                              X-Forwarded-For, signed with OF_ASSISTANT_SECRET (owners/teder.ts). Kept once by its id
//                              and handled by the worker (owners/events.ts).
//
// Pitch pages get their own CSP: the store's logo and product photo load from its CDN
// (https), and the dashboard may frame the page for its preview.

const PITCH_CSP = "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
const pitchHeaders = (extra: Record<string, string | string[]> = {}) => ({ 'content-security-policy': PITCH_CSP, 'x-robots-tag': 'noindex, nofollow, noarchive', 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'strict-origin-when-cross-origin', ...extra });

/** A socket on this machine, and a request that did not come through Caddy. */
const local = (r: Req) => !r.req.headers['x-forwarded-for'] && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(r.req.socket.remoteAddress || '');

/** The website's lead service on this machine: the shared token, and a request that did not come through Caddy. */
function fromWebsite(env: Record<string, string | undefined>, r: Req): boolean {
  const token = String(env.OF_INTERNAL_TOKEN || '').trim();
  if (token.length < 32 || r.req.headers['x-forwarded-for']) return false;
  const local = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(r.req.socket.remoteAddress || '');
  const got = Buffer.from(String(r.req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${token}`);
  return local && got.length === want.length && timingSafeEqual(got, want);
}

function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const t = Date.now();
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    list.push(t);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    return list.length <= max;
  };
}

export function publicRoutes(app: App, accounts: AccountsClient): Route<Req>[] {
  const beaconOk = limiter(120, 3_600_000);
  const hookOk = limiter(600, 60_000);
  // The owner: a session accounts vouches for, whose workspace has this store. A visitor with no cookie never asks
  // accounts, and a check that fails makes anyone a visitor, so the page stays as public as it is.
  const session = async (r: Req): Promise<Session | null> => {
    const sid = sessionIdFrom(cookies(r.req), { https: r.secure });
    if (!sid) return null;
    const who = await accounts.whoIs(sid);
    return who.status === 200 ? (who.body as Session) : null;
  };
  const owner = async (r: Req, storeId: number) => {
    const s = await session(r);
    return Boolean(s) && ownsStore(app.db, scopeOf(s!), storeId);
  };

  const pitch = async (r: Req, m: RegExpExecArray): Promise<Out> => {
    const d = await pitchData(app, m[1]);
    if (!d) return { status: 404, html: goneHtml(false), headers: pitchHeaders() };
    const isOwner = await owner(r, d.store.id);
    if (!isOwner && d.store.taken_down_at) return { status: 410, html: goneHtml(true), headers: pitchHeaders() };
    if (!isOwner && !d.public) return { status: 404, html: goneHtml(false), headers: pitchHeaders() };
    const preview = r.url.searchParams.get('preview') === '1' && isOwner;
    const jar = cookies(r.req);
    let visitor = /^[\w-]{16,40}$/.test(jar.tn_v || '') ? jar.tn_v : null;
    const set: string[] = [];
    if (!visitor) {
      visitor = randomBytes(12).toString('base64url');
      set.push(`tn_v=${visitor}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${r.secure ? '; Secure' : ''}`);
    }
    if (!isOwner) await recordOpen(app, d.store.id, visitor);
    return { html: pitchPage(d, { env: app.env, owner: isOwner, preview }), headers: pitchHeaders(set.length ? { 'set-cookie': set, 'cache-control': 'no-store' } : { 'cache-control': 'no-store' }) };
  };

  return [
    ['GET', /^\/s\/([\w-]{3,40})\/theme\.css$/, async (_r, m) => {
      const d = await pitchData(app, m[1]);
      return d ? { text: themeCss(d), type: 'text/css; charset=utf-8', headers: { 'cache-control': 'public, max-age=300' } } : { status: 404, text: '' };
    }],
    ['GET', /^\/s\/([\w-]{3,40})\/?$/, pitch],
    ['POST', /^\/t$/, async (r) => {
      if (!beaconOk(r.ip)) return { status: 429, text: '' };
      let body: any = {};
      try {
        body = JSON.parse(r.raw || '{}');
      } catch {
        return { status: 400, text: '' };
      }
      // Anyone signed in to OpenFrequency is one of us or a customer looking at a page, never a lead reading it.
      if (await session(r)) return { status: 204, text: '' };
      const visitor = cookies(r.req).tn_v || null;
      await recordBeacon(app, String(body.slug || ''), String(body.kind || ''), body.depth ?? null, visitor);
      return { status: 204, text: '' };
    }],
    ['POST', /^\/wa\/(twilio|sim)$/, async (r, m) => {
      if (!hookOk(r.ip)) return { status: 429, text: '' };
      if (m[1] !== app.wa.kind) return { status: 404, text: '' };
      if (app.wa.kind === 'sim' && app.env.TORAN_ENV === 'prod') return { status: 404, text: '' };
      const inbound = app.wa.parse({ raw: r.raw || '', form: r.form, headers: r.req.headers, url: String(app.env.TWILIO_WEBHOOK_URL || '') });
      if (inbound === null) {
        app.log(`[wa] webhook signature failed from ${r.ip}`);
        return { status: 403, text: 'bad signature' };
      }
      // Stamped on arrival: the reply window is measured from here, however long the message waits in the queue.
      for (const msg of inbound) await enqueue(app.db, 'wa_inbound', { ...msg, at: Date.now() }, { dedupeKey: `wa:${msg.id}` });
      const ack = app.wa.ack();
      return { text: ack.body, type: ack.type };
    }],
    ['POST', /^\/mail\/(resend|sim)$/, async (r, m) => {
      if (!hookOk(r.ip)) return { status: 429, text: '' };
      const mail = app.mail;
      if (!mail || !enabledChannels(app.env).has('email') || m[1] !== mail.kind) return { status: 404, text: '' };
      if (mail.kind === 'sim' && app.env.TORAN_ENV === 'prod') return { status: 404, text: '' };
      const inbound = mail.parse({ raw: r.raw || '', form: r.form, headers: r.req.headers, url: '' });
      if (inbound === null) {
        app.log(`[mail] webhook signature failed from ${r.ip}`);
        return { status: 403, text: 'bad signature' };
      }
      for (const msg of inbound) await enqueue(app.db, 'mail_inbound', { ...msg, at: Date.now() }, { dedupeKey: `mail:${msg.id}` });
      const ack = mail.ack();
      return { text: ack.body, type: ack.type };
    }],
    ['GET', /^\/channels\.json$/, async () => ({ json: await publicChannels(app.db), headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } })],
    ['POST', /^\/internal\/teder\/events$/, async (r) => {
      if (!local(r)) return { status: 403, json: { ok: false, error: 'not_local' } };
      const refused = verify(secretOf(app.env), r.req.headers, 'POST', r.req.url || r.url.pathname, r.raw || '');
      if (refused) {
        app.log(`[teder] event refused: ${refused}`);
        return { status: refused === 'not_configured' ? 503 : 401, json: { ok: false, error: refused } };
      }
      let ev: any;
      try {
        ev = JSON.parse(r.raw || '{}');
      } catch {
        return { status: 400, json: { ok: false, error: 'bad' } };
      }
      const id = String(ev?.id || '');
      if (!/^[\w.:-]{6,100}$/.test(id) || !(EVENT_TYPES as readonly string[]).includes(ev?.type) || !Number.isInteger(ev?.workspace) || ev.workspace <= 0 || typeof ev?.data !== 'object' || !ev.data) return { status: 400, json: { ok: false, error: 'bad' } };
      const at = ev.at && !Number.isNaN(Date.parse(ev.at)) ? new Date(ev.at).toISOString() : null;
      const fresh = await app.db.one('INSERT INTO teder_events (id, type, workspace_id, at, data) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id', [id, ev.type, ev.workspace, at, J(ev.data)]);
      if (fresh) await enqueue(app.db, 'teder_event', { id }, { dedupeKey: `teder:${id}`, maxAttempts: 8 });
      return { json: { ok: true } };
    }],
    ...opsRoutes(app),
    ['POST', /^\/internal\/lead$/, async (r) => {
      if (!fromWebsite(app.env, r)) return { status: 403, json: { ok: false, error: 'forbidden' } };
      let body: any = {};
      try {
        body = JSON.parse(r.raw || '{}');
      } catch {
        return { status: 400, json: { ok: false, error: 'bad' } };
      }
      const url = homeUrl(String(body.url || ''));
      const domain = url ? canonicalDomain(url) : null;
      const code = String(body.code || '').toUpperCase();
      if (!url || !domain || !/^REQ-[A-Z0-9]{6}$/.test(code)) return { status: 400, json: { ok: false, error: 'bad' } };
      // Only written down: nothing happens until the person writes to the demo number with this code.
      await app.db.query('INSERT INTO demo_requests (code, url, domain) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING', [code, url, domain]);
      await audit(app.db, { actor: 'website', action: 'demo_request', detail: { url, code } });
      return { json: { ok: true } };
    }],
  ];
}

