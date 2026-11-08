import { randomUUID } from 'node:crypto';
import type { App } from '../app.ts';
import { enqueue } from '../jobs/queue.ts';
import { isVisitor, siteOf, visitorLines, type Site } from '../channels/web.ts';
import { approvedReviews } from '../reviews.ts';
import { esc } from './ui.ts';
import type { Out, Req, Route } from './server.ts';

// The chat on a store's own site, its public side (channels/web.ts). The store adds one line:
//
//   <script src="https://<toran>/w/<key>.js" async></script>
//
//   GET  /w/<key>.js              the loader: a frame in the corner (data-side="right" on the script moves it), and
//                                 the reviews block in any element with data-toran-reviews. Nothing else on the
//                                 store's page is touched: no cookie, no style sheet, no listener but the frame's
//                                 own messages.
//   GET  /w/<key>/frame           the chat itself, a page of ours inside the frame: the store's colour and name, the
//                                 conversation, the box. Its CSP names the store's domains as the only pages that
//                                 may frame it (frame-ancestors), so a copied key shows nothing on anyone else's site.
//   GET  /w/<key>/theme.css       the store's colour (no inline style: the CSP)
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
  function sized(f, open) {
    var phone = Math.min(window.innerWidth, window.innerHeight) < 520 || window.innerWidth < 520;
    var st = f.style;
    st.position = 'fixed'; st.border = '0'; st.zIndex = '2147483000'; st.background = 'transparent'; st.colorScheme = 'normal';
    st.bottom = open && phone ? '0' : '16px'; st[side] = open && phone ? '0' : '16px'; st[side === 'left' ? 'right' : 'left'] = 'auto';
    st.width = open ? (phone ? '100vw' : 'min(380px, calc(100vw - 32px))') : '76px';
    st.height = open ? (phone ? '100%' : 'min(620px, calc(100vh - 32px))') : '76px';
    st.maxHeight = '100vh';
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
      if (e.source === f.contentWindow && e.data.t === 'toran:open') sized(f, Boolean(e.data.open));
      for (var j = 0; j < frames.length; j++) if (e.source === frames[j].contentWindow && e.data.t === 'toran:reviews') frames[j].style.height = Math.max(0, Math.min(4000, Number(e.data.h) || 0)) + 'px';
    });
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

/** The chat, as the frame shows it: the button when closed, the conversation when open. The script is static/chat.js. */
export function framePage(site: Site, key: string, side: 'left' | 'right'): string {
  const mark = site.logo ? `<img class="c-logo" src="${esc(site.logo)}" alt="" referrerpolicy="no-referrer">` : `<span class="c-initial" aria-hidden="true">${esc(initialOf(site.name))}</span>`;
  const wa = site.whatsapp ? `<a class="c-wa" href="https://wa.me/${esc(site.whatsapp)}" target="_blank" rel="noopener">להמשיך בוואטסאפ</a>` : '';
  return `<!doctype html>
<html lang="he" dir="rtl" class="side-${side}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>צ׳אט עם ${esc(site.name)}</title>
<link rel="stylesheet" href="/static/chat.css">
<link rel="stylesheet" href="/w/${esc(key)}/theme.css">
</head>
<body data-key="${esc(key)}">
<button class="c-open" type="button" aria-expanded="false" aria-controls="c-panel" aria-label="צ׳אט עם ${esc(site.name)}">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4A8 8 0 1 1 20 12z"/></svg>
</button>
<section class="c-panel" id="c-panel" role="dialog" aria-modal="false" aria-labelledby="c-name" hidden>
  <header class="c-head">${mark}<div class="c-who"><b id="c-name"><bdi>${esc(site.name)}</bdi></b><small>עונים כאן בדרך כלל תוך רגע</small></div>
    <button class="c-close" type="button" aria-label="לסגור את הצ׳אט"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>
  <div class="c-lines" role="log" aria-live="polite" aria-label="השיחה">
    <p class="c-hello">היי, אפשר לשאול כאן על מוצרים, מלאי, משלוחים והזמנות.</p>
  </div>
  <p class="c-typing" hidden><span></span><span></span><span></span><b class="c-sr">כותבים תשובה</b></p>
  <p class="c-error" role="alert" hidden></p>
  <form class="c-box">
    <label class="c-sr" for="c-text">ההודעה שלכם</label>
    <textarea id="c-text" rows="1" maxlength="${SAY_MAX}" dir="auto" placeholder="כתבו כאן…" required></textarea>
    <button class="c-send" type="submit" aria-label="לשלוח"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/></svg></button>
  </form>
  <footer class="c-foot">${wa}<span>עם תורן</span></footer>
</section>
<script src="/static/chat.js" defer></script>
</body>
</html>`;
}

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
<link rel="stylesheet" href="/static/chat.css">
<link rel="stylesheet" href="/w/${esc(site.account.external_id)}/theme.css">
</head>
<body class="r-body" data-reviews>
${reviews.length ? `<header class="r-head"><b>מה הלקוחות אומרים</b>${avg ? `<span>${avg} · ${reviews.length === 1 ? 'ביקורת אחת' : `${reviews.length} ביקורות`}</span>` : ''}</header>
<ul class="r-list">${reviews.map((r) => `<li class="r-card">${stars(r.rating)}<p dir="auto">${esc(r.text)}</p><small><bdi>${esc(r.name)}</bdi></small></li>`).join('')}</ul>` : ''}
<script src="/static/chat.js" defer></script>
</body>
</html>`;
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
      return { html: framePage(site, site.account.external_id, side), headers: frameHeaders(site.domains) };
    }],
    ['GET', /^\/w\/([a-z0-9]{1,40})\/theme\.css$/, async (_r, m) => {
      const site = await siteOf(app, m[1]);
      if (!site) return { status: 404, text: '', type: 'text/css; charset=utf-8' };
      return { text: `:root{--store:${site.color};--store-ink:${site.ink}}`, type: 'text/css; charset=utf-8', headers: { 'cache-control': 'public, max-age=300' } };
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
