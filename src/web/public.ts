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
import { metaSettings, parseWebhook, signatureOk } from '../channels/meta.ts';
import { parseSocial, socialSettings, type Social } from '../channels/social.ts';
import { clearNonce, finishConnect, NONCE_COOKIE } from '../channels/socialStore.ts';
import type { Out, Req, Route } from './server.ts';
import { J } from '../db/index.ts';
import { secretOf, verify } from '../owners/teder.ts';
import { EVENT_TYPES } from '../owners/events.ts';
import { opsRoutes } from '../ops/api.ts';
import { setupRoutes } from '../setup.ts';
import { eraseRoutes } from '../erase.ts';
import { hookSecretOf, shopifyHmacOk, wooSignatureOk } from '../auto/platforms.ts';
import { unsubscribeRoutes } from './unsubscribe.ts';

// The public routes, answered without a session:
//
//   GET  /s/<slug>             a store's pitch page (noindex). Open to anyone only once it
//                              is approved and complete (pitch/ready.ts); a signed-in
//                              session whose workspace has the store (the operator: every
//                              store) sees it always, with what holds it back; a taken-down page is
//                              410 for everyone else
//   GET  /s/<slug>/theme.css   its colours
//   POST /t                    the page's beacon (scroll depth, demo taps), rate-limited
//   GET  /u/<token>            a store's customer's page of message settings, from the link in a cart reminder or
//   POST /u/<token>            a review request: stop them, or undo it; a mail client's one-click unsubscribe
//                              (RFC 8058) posts here too. noindex, rate-limited (unsubscribe.ts)
//   POST /wa/twilio            Twilio's webhook: signature checked, acknowledged at once,
//                              the message handled by the worker (channels/route.ts)
//   POST /wa/sim               the simulator's webhook (development only)
//   POST /mail/resend          Resend's webhook (email.received, email.bounced, email.complained): Svix signature
//                              checked, acknowledged at once, handled by the worker. 404 while TORAN_CHANNELS has
//                              no email
//   POST /mail/sim             the email simulator's webhook (development only)
//   POST /hooks/<platform>/<id> a store's own Shopify or WooCommerce, for the automatic messages: signed with the
//                              store's webhook secret (Shopify's X-Shopify-Hmac-Sha256, WooCommerce's
//                              X-WC-Webhook-Signature), acknowledged at once, read by the worker (auto/platforms.ts)
//   GET  /meta/webhook         Meta's check of the webhook (hub.verify_token = META_WEBHOOK_VERIFY_TOKEN)
//   POST /meta/webhook         Meta's webhook for every store's own WhatsApp number, Facebook Page and Instagram
//                              account: X-Hub-Signature-256 checked (under the app's secret, or the Instagram app's),
//                              acknowledged at once; messages, the owner's own messages from the phone, the Page's
//                              inbox or the Instagram app, delivery failures and account changes handled by the worker
//                              (channels/meta.ts, waStore.ts, social.ts, socialStore.ts). Messenger and Instagram are
//                              acknowledged and dropped while TORAN_CHANNELS does not list them
//   GET  /meta/oauth/<channel> Meta's answer to a store's login for Messenger or Instagram: the state and this
//                              browser's cookie checked, the account connected, and the store sent to its page
//                              (channels/socialStore.ts)
//   GET  /channels.json        each channel's state (off, demo, live) for the website's "בקרוב" tags; nothing about
//                              any store
//   POST /internal/lead        a demo asked for on openfrequency.co.il (openfrequency-web/server/lead.mjs): from this
//                              machine only, with OF_INTERNAL_TOKEN and no X-Forwarded-For (so never through Caddy).
//                              It is written down with its code (REQ-XXXXXX) and waits: only when the person writes
//                              to the demo number with that code is the store added (channels/request.ts).
//   GET  /internal/ops         the operator's dashboard as data, for accounts' /admin (ops/api.ts); its POSTs are
//                              the dashboard's buttons. From this machine only, with OF_INTERNAL_TOKEN
//   GET  /internal/setup       a workspace's setup steps, for accounts' /setup checklist (src/setup.ts): the same
//                              checks as /internal/ops
//   POST /internal/workspaces/<id>/delete  a workspace deleted in accounts: everything of it here (src/erase.ts), the
//                              same checks as /internal/ops
//   POST /internal/teder/events Teder's news for an owner (Teder's docs/assistant-api.md): from this machine only, no
//                              X-Forwarded-For, signed with OF_ASSISTANT_SECRET in the direction teder->toran
//                              (owners/teder.ts). Kept once by its id and handled by the worker (owners/events.ts).
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
  const stopOk = limiter(30, 60_000);
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
    ...unsubscribeRoutes(app, stopOk),
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
    // A store's own platform, for the automatic messages (auto/platforms.ts): signed with the store's own webhook
    // secret, acknowledged at once, read by the worker. A webhook is only a hint to look: what it says is kept once by
    // the platform's own ids, so a replayed or doubled one sends nothing twice.
    ['POST', /^\/hooks\/(shopify|woocommerce)\/(\d+)$/, async (r, m) => {
      if (!hookOk(r.ip)) return { status: 429, text: '' };
      const platform = m[1];
      const storeId = Number(m[2]);
      const h = r.req.headers;
      // WooCommerce checks a new webhook with an unsigned "webhook_id=<n>" before its first delivery.
      if (platform === 'woocommerce' && !h['x-wc-webhook-signature'] && /^webhook_id=\d+$/.test(String(r.raw || '').trim())) return { text: 'ok' };
      const secret = await hookSecretOf(app, storeId, platform);
      const sig = platform === 'shopify' ? h['x-shopify-hmac-sha256'] : h['x-wc-webhook-signature'];
      if (!secret || !(platform === 'shopify' ? shopifyHmacOk(secret, r.raw || '', sig) : wooSignatureOk(secret, r.raw || '', sig))) {
        app.log(`[auto] ${platform} webhook for store ${storeId}: signature failed from ${r.ip}`);
        return { status: 401, text: 'bad signature' };
      }
      let body: unknown;
      try {
        body = JSON.parse(r.raw || '');
      } catch {
        return { status: 400, text: '' };
      }
      const topic = String((platform === 'shopify' ? h['x-shopify-topic'] : h['x-wc-webhook-topic']) || '');
      const id = String((platform === 'shopify' ? h['x-shopify-webhook-id'] : h['x-wc-webhook-delivery-id']) || '');
      await app.db.query('UPDATE auto_sources SET hook_at = now() WHERE store_id = $1', [storeId]);
      await enqueue(app.db, 'auto_hook', { storeId, platform, topic, body }, { dedupeKey: id ? `auto_hook:${platform}:${storeId}:${id}` : null, maxAttempts: 3 });
      return { text: 'ok' };
    }],
    ['GET', /^\/meta\/webhook$/, async (r) => {
      const m = metaSettings(app.env);
      const q = r.url.searchParams;
      if (!m.verifyToken || q.get('hub.mode') !== 'subscribe' || q.get('hub.verify_token') !== m.verifyToken) return { status: 403, text: '' };
      return { text: String(q.get('hub.challenge') || '') };
    }],
    ['POST', /^\/meta\/webhook$/, async (r) => {
      if (!hookOk(r.ip)) return { status: 429, text: '' };
      const m = metaSettings(app.env);
      if (!m.appSecret) return { status: 404, text: '' };
      // Instagram Login's webhooks may be signed with the Instagram app's own secret; both are ours.
      const ig = socialSettings(app.env).igAppSecret;
      const sig = r.req.headers['x-hub-signature-256'];
      if (!signatureOk(m.appSecret, r.raw || '', sig) && !(ig && signatureOk(ig, r.raw || '', sig))) {
        app.log(`[meta] webhook signature failed from ${r.ip}`);
        return { status: 403, text: 'bad signature' };
      }
      let body: unknown;
      try {
        body = JSON.parse(r.raw || '');
      } catch {
        return { status: 400, text: '' };
      }
      const dm = parseSocial(body);
      if (dm.channel) {
        if (!enabledChannels(app.env).has(dm.channel)) return { text: 'ok' };
        for (const msg of dm.messages) await enqueue(app.db, 'dm_inbound', { ...msg, at: Date.now() }, { dedupeKey: `dm:${msg.id}` });
        // A few seconds later: an echo of Toran's own send is known by its id once that send is in the ledger.
        for (const e of dm.echoes) await enqueue(app.db, 'dm_echo', e, { dedupeKey: `dm_echo:${e.id}`, runAt: new Date(Date.now() + 5_000) });
        return { text: 'ok' };
      }
      const w = parseWebhook(body);
      // Stamped on arrival, as on Twilio's: the reply window is measured from here.
      for (const msg of w.messages) await enqueue(app.db, 'wa_inbound', { ...msg, at: Date.now() }, { dedupeKey: `wa:${msg.id}` });
      for (const e of w.echoes) await enqueue(app.db, 'wa_echo', e, { dedupeKey: `wa_echo:${e.id}` });
      for (const s of w.statuses.filter((x) => x.status === 'failed')) await enqueue(app.db, 'wa_status', s, { dedupeKey: `wa_status:${s.id}`, maxAttempts: 1 });
      // A store's template approved, rejected or moved to another category (auto/templates.ts).
      for (const t of w.templates) await enqueue(app.db, 'wa_template_status', t, { maxAttempts: 2 });
      for (const waba of w.accounts) {
        const rows = await app.db.query<{ id: number }>("SELECT id FROM channel_accounts WHERE channel = 'whatsapp' AND kind = 'meta' AND status <> 'off' AND meta->>'waba_id' = $1", [waba]);
        for (const a of rows) await enqueue(app.db, 'wa_check', { accountId: a.id }, { dedupeKey: `wa_check:${a.id}`, maxAttempts: 1 });
      }
      return { text: 'ok' };
    }],
    ['GET', /^\/meta\/oauth\/(messenger|instagram)$/, async (r, m) => {
      const channel = m[1] as Social;
      if (!enabledChannels(app.env).has(channel)) return { status: 404, text: '' };
      const q = r.url.searchParams;
      const out = await finishConnect(app, channel, { state: q.get('state') || '', code: q.get('code') || '', error: q.get('error') || '', nonce: cookies(r.req)[NONCE_COOKIE] || '' });
      const headers = { 'set-cookie': clearNonce(app.env, r.secure), 'referrer-policy': 'no-referrer' };
      if (!out.storeId) return { status: 400, html: '<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>תורן</title><p>הקישור הזה כבר לא עובד. חוזרים לתורן ומחברים שוב.</p></html>', headers };
      const done = out.outcome === 'pick' ? `pick=${encodeURIComponent(out.state!)}` : out.outcome === 'connected' ? 'connected=1' : `error=${out.why}`;
      return { redirect: `/lead/${out.storeId}/${channel}?${done}`, headers };
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
      // Teder names the workspace "customer" (its docs/assistant-api.md).
      const workspace = Number(ev?.customer);
      if (!/^[\w.:-]{6,100}$/.test(id) || !(EVENT_TYPES as readonly string[]).includes(ev?.type) || !Number.isInteger(workspace) || workspace <= 0 || typeof ev?.data !== 'object' || !ev.data) return { status: 400, json: { ok: false, error: 'bad' } };
      const at = ev.at && !Number.isNaN(Date.parse(ev.at)) ? new Date(ev.at).toISOString() : null;
      const fresh = await app.db.one('INSERT INTO teder_events (id, type, workspace_id, at, data) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id', [id, ev.type, workspace, at, J(ev.data)]);
      if (fresh) await enqueue(app.db, 'teder_event', { id }, { dedupeKey: `teder:${id}`, maxAttempts: 8 });
      return { json: { ok: true } };
    }],
    ...opsRoutes(app),
    ...setupRoutes(app),
    ...eraseRoutes(app),
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

