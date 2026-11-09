import { randomUUID } from 'node:crypto';
import type { App } from '../app.ts';
import { J } from '../db/index.ts';
import { enqueue } from '../jobs/queue.ts';
import { isVisitor, siteOf, visitorLines, type Site } from '../channels/web.ts';
import { approvedReviews } from '../reviews.ts';
import { lookCss, type Look } from '../ingest/palette.ts';
import { esc } from './ui.ts';
import type { Out, Req, Route } from './server.ts';

// The chat on a store's own site, its public side (channels/web.ts). The store adds one line:
//
//   <script src="https://<toran>/w/<key>.js" async></script>
//
//   GET  /w/<key>.js              the loader: a frame in the corner (data-side="right" on the script moves it), and
//                                 the reviews block in any element with data-toran-reviews. Nothing else on the
//                                 store's page is touched: no cookie, no style sheet, no listener but the frame's
//                                 own messages and the screen's size (an open sheet on a phone follows the keyboard).
//   GET  /w/<key>/frame           the chat itself, a page of ours inside the frame: the store's name and mark, the
//                                 conversation, the box, in the site's own look (ingest/palette.ts). Its CSP names the store's domains as the only pages that
//                                 may frame it (frame-ancestors), so a copied key shows nothing on anyone else's site.
//   GET  /w/<key>/theme.css       the chat's look as CSS tokens (no inline style: the CSP): the site's colours, corners
//                                 and type, the owner's choice over them, every text pair at 4.5:1 (palette.ts lookOf)
//   POST /w/<key>/say             a visitor's message (v, text): queued as web_inbound, answered as any other
//   GET  /w/<key>/lines?v=&after= the visitor's conversation after a message id
//   GET  /w/<key>/reviews         the reviews block: the store's approved reviews (reviews.ts)
//
// The frame's script talks only to this site (connect-src 'self'), so there is no CORS to open. Each visitor may say
// 12 things a minute, each address 60, and a line is at most 1,000 characters. A key that is not an active chat gets
// an empty loader and 404s, the same for every wrong one.

const SAY_MAX = 1000;

function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const t = Date.now();
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    list.push(t);
    hits.set(key, list);
    if (hits.size > 20000) hits.clear();
    return list.length <= max;
  };
}

const publicBase = (app: App) => String(app.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || `http://localhost:${app.env.PORT || 4710}`;

/** The loader the store's page runs: the frame in the corner, and the reviews block where the store asked for it. */
export function loaderJs(base: string, key: string): string {
  const b = JSON.stringify(base);
  const k = JSON.stringify(key);
  return `/* Toran: the store's chat. ${base}/w/${key}.js */
(function () {
  if (window.__toranChat) return;
  window.__toranChat = 1;
  var d = document, s = d.currentScript, B = ${b}, K = ${k};
  var side = s && s.getAttribute('data-side') === 'right' ? 'right' : 'left';
  var isOpen = false, vv = window.visualViewport;
  // Closed, an 84px square: the 56px button and room for its shadow. Open on a desk, the panel and a 12px margin for its
  // shadow (the frame draws nothing there). Open on a phone, a sheet over the whole visible screen: the visual viewport,
  // so the box stays above the keyboard, inside the notch and the home bar (env(), when the page draws under them).
  function sized(f, open) {
    var phone = Math.min(window.innerWidth, window.innerHeight) < 520 || window.innerWidth < 520;
    var full = open && phone, st = f.style;
    st.position = 'fixed'; st.border = '0'; st.zIndex = '2147483000'; st.background = 'transparent'; st.colorScheme = 'normal';
    st[side === 'left' ? 'right' : 'left'] = 'auto';
    st[side] = full ? '0' : '4px';
    st.bottom = full ? 'auto' : '4px';
    st.width = open ? (phone ? '100vw' : 'min(416px, calc(100vw - 8px))') : '84px';
    // A browser that does not take env() keeps the plain value set just before it.
    var h = vv ? vv.height + 'px' : '100%';
    st.top = full ? (vv ? vv.offsetTop : 0) + 'px' : 'auto';
    if (full) st.top = 'calc(' + st.top + ' + env(safe-area-inset-top, 0px))';
    st.height = open ? (phone ? h : 'min(684px, calc(100vh - 8px))') : '84px';
    if (full) st.height = 'calc(' + h + ' - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))';
    st.maxHeight = full ? 'none' : '100vh';
    // The frame cannot see the page's size: it is told whether it is a sheet over the whole screen or a panel.
    if (f.contentWindow) f.contentWindow.postMessage({ t: 'toran:full', full: full }, B);
  }
  function start() {
    var f = d.createElement('iframe');
    f.src = B + '/w/' + K + '/frame?side=' + side;
    f.title = '\\u05e6\\u05f3\\u05d0\\u05d8 \\u05e2\\u05dd \\u05d4\\u05d7\\u05e0\\u05d5\\u05ea';
    f.setAttribute('allow', 'clipboard-write');
    sized(f, false);
    d.body.appendChild(f);
    var blocks = d.querySelectorAll('[data-toran-reviews]');
    var frames = [];
    for (var i = 0; i < blocks.length; i++) {
      var r = d.createElement('iframe');
      r.src = B + '/w/' + K + '/reviews';
      r.title = '\\u05d1\\u05d9\\u05e7\\u05d5\\u05e8\\u05d5\\u05ea';
      r.loading = 'lazy';
      r.style.width = '100%'; r.style.border = '0'; r.style.height = '240px'; r.style.background = 'transparent';
      blocks[i].appendChild(r);
      frames.push(r);
    }
    window.addEventListener('message', function (e) {
      if (e.origin !== B || !e.data) return;
      if (e.source === f.contentWindow && e.data.t === 'toran:open') { isOpen = Boolean(e.data.open); sized(f, isOpen); }
      for (var j = 0; j < frames.length; j++) if (e.source === frames[j].contentWindow && e.data.t === 'toran:reviews') frames[j].style.height = Math.max(0, Math.min(4000, Number(e.data.h) || 0)) + 'px';
    });
    // The keyboard opening on a phone shrinks the visible screen: the open sheet follows it.
    var again = function () { if (isOpen) sized(f, true); };
    if (vv) { vv.addEventListener('resize', again); vv.addEventListener('scroll', again); }
    window.addEventListener('resize', again);
  }
  if (d.body) start(); else d.addEventListener('DOMContentLoaded', start);
})();
`;
}

/** The frame's CSP: only this site, and framed only by the store's own domains. */
const frameCsp = (domains: string[]) =>
  `default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors ${domains.length ? domains.join(' ') : "'none'"}; base-uri 'none'; form-action 'none'`;

const frameHeaders = (domains: string[]) => ({ 'content-security-policy': frameCsp(domains), 'x-frame-options': '', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' });

const initialOf = (name: string) => (name.trim().match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();

// The static files' version: a new deploy's chat.css and chat.js are fetched at once, not after the hour they are kept.
const CV = Date.now().toString(36);

/** What the chat shows inside its header and around the conversation; the frame and the Settings preview share it. */
type Face = { name: string; logo: string | null; whatsapp: string | null; bot: string | null };

const ICON_CHAT = '<svg class="c-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4c4.7 0 8.5 3.1 8.5 7s-3.8 7-8.5 7c-.9 0-1.8-.1-2.6-.3L5 19.5l1.1-3.4C4.5 14.8 3.5 13 3.5 11c0-3.9 3.8-7 8.5-7z"/><circle class="c-dot" cx="8.6" cy="11" r="1.15"/><circle class="c-dot" cx="12" cy="11" r="1.15"/><circle class="c-dot" cx="15.4" cy="11" r="1.15"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
const ICON_WA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19l1-3.3A7.5 7.5 0 1 1 8.6 18z"/></svg>';

// The questions a visitor can tap before writing anything: what most people ask a shop first. Each one is sent as the
// visitor's own message, answered like any other; they go once the visitor has said something.
const STARTERS = ['כמה זמן לוקח משלוח?', 'איך מחזירים מוצר?', 'איפה ההזמנה שלי?'];

/** The header's second line: who answers. True only: the bot, by the name the owner gave it, never how fast. */
const whoAnswers = (bot: string | null) => (bot ? `${bot}, הבוט של החנות` : 'הבוט של החנות');

function panel(face: Face, { preview = false }: { preview?: boolean } = {}): string {
  const mark = face.logo ? `<img class="c-logo" src="${esc(face.logo)}" alt="" referrerpolicy="no-referrer">` : `<span class="c-initial" aria-hidden="true">${esc(initialOf(face.name))}</span>`;
  const wa = face.whatsapp ? `<a class="c-wa" href="https://wa.me/${esc(face.whatsapp)}" target="_blank" rel="noopener">${ICON_WA}להמשיך בוואטסאפ</a>` : '';
  const sample = preview
    ? `<p class="c-line c-me">היי, יש לכם את זה במידה M?</p><p class="c-line c-store">כן, יש במידה M בשני צבעים. לשלוח לכם קישור?</p><p class="c-line c-me">כן, תודה</p>`
    : '';
  return `<section class="c-panel" id="c-panel" role="dialog" aria-modal="true" aria-labelledby="c-name" aria-describedby="c-sub"${preview ? '' : ' hidden'}>
  <header class="c-head"><span class="c-avatar">${mark}</span><div class="c-who"><h2 id="c-name"><bdi>${esc(face.name)}</bdi></h2><p id="c-sub">${esc(whoAnswers(face.bot))}</p></div>
    <button class="c-close" type="button" aria-label="לסגור את הצ׳אט">${ICON_CLOSE}</button></header>
  <div class="c-lines" role="log" aria-live="polite" aria-relevant="additions" aria-label="השיחה" tabindex="-1">
    <p class="c-line c-store c-hello">היי, אפשר לשאול אותי על מוצרים, מלאי, משלוחים והזמנות.</p>${sample}
  </div>
  ${preview ? '' : `<div class="c-chips" role="group" aria-label="שאלות שאפשר לשאול">${STARTERS.map((q) => `<button class="c-chip" type="button">${esc(q)}</button>`).join('')}</div>`}
  <div class="c-typing" hidden><span class="c-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="c-sr">כותבים תשובה</span></div>
  <p class="c-error" role="alert" hidden></p>
  <form class="c-box">
    <div class="c-field">
      <label class="c-sr" for="c-text">ההודעה שלכם</label>
      <textarea id="c-text" rows="1" maxlength="${SAY_MAX}" dir="auto" placeholder="כתבו הודעה" required${preview ? ' tabindex="-1"' : ''}></textarea>
      <button class="c-send" type="submit" aria-label="לשלוח"${preview ? ' tabindex="-1"' : ''}>${ICON_SEND}</button>
    </div>
  </form>
  <footer class="c-foot">${wa}<span class="c-by">עם תורן</span></footer>
</section>`;
}

/** The chat, as the frame shows it: the button when closed, the conversation when open. The script is static/chat.js. */
export function framePage(site: Site, key: string, side: 'left' | 'right'): string {
  return `<!doctype html>
<html lang="he" dir="rtl" class="side-${side}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>צ׳אט עם ${esc(site.name)}</title>
<link rel="stylesheet" href="/static/chat.css?v=${CV}">
<link rel="stylesheet" href="/w/${esc(key)}/theme.css?v=${lookTag(site.look)}">
</head>
<body data-key="${esc(key)}" data-sites="${esc(site.domains.join(' '))}">
<button class="c-open" type="button" aria-expanded="false" aria-controls="c-panel" aria-label="צ׳אט עם ${esc(site.name)}" data-label="צ׳אט עם ${esc(site.name)}">
  ${ICON_CHAT}<span class="c-badge" hidden></span>
</button>
${panel(site)}
<script src="/static/chat.js?v=${CV}" defer></script>
</body>
</html>`;
}

/**
 * The chat as the owner sees it on Settings, before any customer does (pages/webchat.ts): open, with a short sample
 * conversation, its button beside it, on the store's own background. Its script only puts the store's initial in place
 * of a logo that does not load; `css` is the look being tried.
 */
export function previewPage(face: Face, css: string, side: 'left' | 'right' = 'left'): string {
  return `<!doctype html>
<html lang="he" dir="rtl" class="pv side-${side}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>איך הצ׳אט נראה</title>
<link rel="stylesheet" href="/static/chat.css?v=${CV}">
<link rel="stylesheet" href="${esc(css)}">
</head>
<body class="pv-body">
<div class="pv-stage" aria-hidden="true" inert>
${panel(face, { preview: true })}
<span class="c-open pv-open">${ICON_CHAT}</span>
</div>
<script src="/static/chat.js?v=${CV}" defer></script>
</body>
</html>`;
}

/** A short tag of a look, so a changed colour is a new theme.css URL and no browser keeps the old one. */
const lookTag = (l: Look) => {
  let h = 0;
  for (const ch of JSON.stringify(l)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
};

/** The reviews block's page: the store's approved reviews, a card each, in its colour. */
export function reviewsPage(site: Site, reviews: { rating: number; text: string; name: string; at: string }[]): string {
  const stars = (n: number) => `<span class="r-stars" aria-label="${n} מתוך 5">${'★'.repeat(n)}<span class="r-off">${'★'.repeat(5 - n)}</span></span>`;
  const avg = reviews.length ? (reviews.reduce((a, r) => a + r.rating, 0) / reviews.length).toFixed(1) : null;
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>ביקורות על ${esc(site.name)}</title>
<link rel="stylesheet" href="/static/chat.css?v=${CV}">
<link rel="stylesheet" href="/w/${esc(site.account.external_id)}/theme.css?v=${lookTag(site.look)}">
</head>
<body class="r-body" data-reviews>
${reviews.length ? `<header class="r-head"><b>מה הלקוחות אומרים</b>${avg ? `<span>${avg} · ${reviews.length === 1 ? 'ביקורת אחת' : `${reviews.length} ביקורות`}</span>` : ''}</header>
<ul class="r-list">${reviews.map((r) => `<li class="r-card">${stars(r.rating)}<p dir="auto">${esc(r.text)}</p><small><bdi>${esc(r.name)}</bdi></small></li>`).join('')}</ul>` : ''}
<script src="/static/chat.js?v=${CV}" defer></script>
</body>
</html>`;
}

/**
 * The first time the chat opens on one of the store's own pages, kept on its account (meta.first_seen_at): the setup
 * checklist's "the chat is on the site" (src/setup.ts). Switching the chat on in Settings is not yet having it on the
 * site; this is. A page elsewhere (a test, a copy) does not count.
 */
async function firstSeen(app: App, site: Site, referer: string) {
  if (site.account.meta?.first_seen_at) return;
  let origin = '';
  try {
    origin = new URL(referer).origin;
  } catch {
    return;
  }
  if (!site.domains.includes(origin)) return;
  await app.db.query("UPDATE channel_accounts SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb WHERE id = $1 AND NOT (COALESCE(meta, '{}'::jsonb) ? 'first_seen_at')", [site.account.id, J({ first_seen_at: new Date().toISOString() })]);
}

export function widgetRoutes(app: App): Route<Req>[] {
  const visitorOk = limiter(12, 60_000);
  const addressOk = limiter(60, 60_000);
  const readOk = limiter(240, 60_000);
  const none: Out = { status: 404, text: '', type: 'text/plain; charset=utf-8', headers: { 'cache-control': 'no-store' } };
  return [
    ['GET', /^\/w\/([a-z0-9]{1,40})\.js$/, async (_r, m) => {
      const site = await siteOf(app, m[1]);
      // An empty loader for a key that is not an active chat: the store's page loads nothing, and nothing breaks.
      const js = site ? loaderJs(publicBase(app), site.account.external_id) : '/* Toran: this chat is off. */\n';
      return { text: js, type: 'text/javascript; charset=utf-8', headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' } };
    }],
    ['GET', /^\/w\/([a-z0-9]{1,40})\/frame$/, async (r, m) => {
      const site = await siteOf(app, m[1]);
      if (!site) return { ...none, status: 404 };
      const side = r.url.searchParams.get('side') === 'right' ? 'right' : 'left';
      await firstSeen(app, site, String(r.req.headers.referer || ''));
      return { html: framePage(site, site.account.external_id, side), headers: frameHeaders(site.domains) };
    }],
    ['GET', /^\/w\/([a-z0-9]{1,40})\/theme\.css$/, async (_r, m) => {
      const site = await siteOf(app, m[1]);
      if (!site) return { status: 404, text: '', type: 'text/css; charset=utf-8' };
      return { text: lookCss(site.look), type: 'text/css; charset=utf-8', headers: { 'cache-control': 'public, max-age=300' } };
    }],
    ['GET', /^\/w\/([a-z0-9]{1,40})\/reviews$/, async (_r, m) => {
      const site = await siteOf(app, m[1]);
      if (!site) return { ...none, status: 404 };
      return { html: reviewsPage(site, await approvedReviews(app, site.account.store_id)), headers: { ...frameHeaders(site.domains), 'cache-control': 'public, max-age=300' } };
    }],
    ['POST', /^\/w\/([a-z0-9]{1,40})\/say$/, async (r, m) => {
      const v = String(r.form.v || '');
      const text = String(r.form.text || '').replace(/\r\n?/g, '\n').trim().slice(0, SAY_MAX);
      if (!addressOk(r.ip) || (isVisitor(v) && !visitorOk(v))) return { status: 429, json: { ok: false, message: 'רגע, יותר מדי הודעות. אפשר לנסות שוב בעוד דקה.' }, headers: { 'retry-after': '60' } };
      const site = await siteOf(app, m[1]);
      if (!site || !isVisitor(v)) return { status: 404, json: { ok: false } };
      if (!text) return { status: 400, json: { ok: false, message: 'ההודעה ריקה.' } };
      const id = `web:${site.account.external_id}:${v}:${randomUUID()}`;
      await enqueue(app.db, 'web_inbound', { channel: 'web', from: v, text, id, account: site.account.external_id, at: Date.now() }, { dedupeKey: id });
      return { json: { ok: true } };
    }],
    ['GET', /^\/w\/([a-z0-9]{1,40})\/lines$/, async (r, m) => {
      if (!readOk(r.ip)) return { status: 429, json: { ok: false }, headers: { 'retry-after': '60' } };
      const site = await siteOf(app, m[1]);
      const v = String(r.url.searchParams.get('v') || '');
      if (!site || !isVisitor(v)) return { status: 404, json: { ok: false } };
      return { json: { ok: true, lines: await visitorLines(app, site.account, v, Number(r.url.searchParams.get('after') || 0)) } };
    }],
  ];
}
