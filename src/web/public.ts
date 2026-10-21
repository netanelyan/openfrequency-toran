import { randomBytes } from 'node:crypto';
import type { App } from '../app.ts';
import { pitchData, pitchPage, themeCss } from '../pitch/page.ts';
import { recordBeacon, recordOpen } from '../pitch/track.ts';
import { enqueue } from '../jobs/queue.ts';
import { cookies, sessionFrom, sessionSecret, sessionUser } from './auth.ts';
import type { Out, Req, Route } from './server.ts';

// The public routes, answered without a session:
//
//   GET  /s/<slug>             a store's pitch page (noindex)
//   GET  /s/<slug>/theme.css   its colours
//   POST /t                    the page's beacon (scroll depth, demo taps), rate-limited
//   POST /wa/twilio            Twilio's webhook: signature checked, acknowledged at once,
//                              the message handled by the worker
//   POST /wa/sim               the simulator's webhook (development only)
//
// Pitch pages get their own CSP: the store's logo and product photo load from its CDN
// (https), and the dashboard may frame the page for its preview.

const PITCH_CSP = "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
const pitchHeaders = (extra: Record<string, string | string[]> = {}) => ({ 'content-security-policy': PITCH_CSP, 'x-robots-tag': 'noindex, nofollow, noarchive', 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'strict-origin-when-cross-origin', ...extra });

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

export function publicRoutes(app: App): Route<Req>[] {
  const secret = sessionSecret(app.env);
  const beaconOk = limiter(120, 3_600_000);
  const hookOk = limiter(600, 60_000);
  const owner = (r: Req) => Boolean(sessionUser(sessionFrom(r.req), secret));

  const pitch = async (r: Req, m: RegExpExecArray): Promise<Out> => {
    const d = await pitchData(app, m[1]);
    if (!d) return { status: 404, html: notFound(), headers: pitchHeaders() };
    const preview = r.url.searchParams.get('preview') === '1' && owner(r);
    const jar = cookies(r.req);
    let visitor = /^[\w-]{16,40}$/.test(jar.tn_v || '') ? jar.tn_v : null;
    const set: string[] = [];
    if (!visitor) {
      visitor = randomBytes(12).toString('base64url');
      set.push(`tn_v=${visitor}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${r.secure ? '; Secure' : ''}`);
    }
    if (!preview && !owner(r)) await recordOpen(app, d.store.id, visitor);
    return { html: pitchPage(d, { env: app.env, preview }), headers: pitchHeaders(set.length ? { 'set-cookie': set, 'cache-control': 'no-store' } : { 'cache-control': 'no-store' }) };
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
      if (owner(r)) return { status: 204, text: '' };
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
      for (const msg of inbound) await enqueue(app.db, 'wa_inbound', msg, { dedupeKey: `wa:${msg.id}` });
      const ack = app.wa.ack();
      return { text: ack.body, type: ack.type };
    }],
  ];
}

function notFound() {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>הדף לא נמצא</title><link rel="stylesheet" href="/static/brand.css"><link rel="stylesheet" href="/static/pitch.css"></head><body><main class="page"><section class="letter"><h1>הדף הזה כבר לא כאן</h1><p class="lede">אולי הקישור ישן. אם קיבלתם אותו ממני, אפשר לכתוב לי ואשלח חדש.</p></section></main></body></html>`;
}
