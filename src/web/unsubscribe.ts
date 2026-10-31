import type { App } from '../app.ts';
import { a11yHead, a11yWidget, accessibilityLink, iconLinks } from '../brand.ts';
import { brandColor, displayName, inkOn, readableShade } from '../ingest/brand.ts';
import { linkOf, stopFromLink, undoFromLink, type StopLink } from '../auto/consent.ts';
import { esc } from './ui.ts';
import type { Out, Req, Route } from './server.ts';

// The customer's page of message settings, /u/<token>: where the link in a cart reminder or a review request goes (the
// WhatsApp template's "הגדרות הודעות" button, the line at the end of the email, its List-Unsubscribe). Public, never
// indexed, in the store's own colour and logo as its pitch page is, Hebrew, phone first. The token (auto_links,
// migration 019) says which store, channel and address, and nothing in the URL is personal.
//
//   GET  /u/<token>             the store's name and one question, "לא לקבל יותר תזכורות מ<store>?", with one button;
//                               once stopped, the confirmation and its undo
//   GET  /u/<token>/theme.css   the store's colour (the CSP allows no inline style)
//   POST /u/<token>             the button (do=stop), the undo (do=undo, which gives back the "yes" the stop put
//                               aside), or a mail client's one-click unsubscribe (RFC 8058: List-Unsubscribe=One-Click),
//                               which is answered with the confirmation and nothing to click
//
// A GET never changes anything, so a mail scanner that opens the link stops nothing. A token that is not ours gets one
// polite page, the same for every wrong one. Each route is one lookup by primary key, and an address may ask 30 times
// a minute.

// Script only from this site, for the accessibility panel's one file (static/a11y.js): no inline script and nothing from
// anywhere else, and the page still sends nothing anywhere (connect-src 'none').
const CSP = "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'none'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const headers = { 'content-security-policy': CSP, 'x-robots-tag': 'noindex, nofollow, noarchive', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };

type Store = { name: string; color: string; logo: string | null };

async function storeOf(app: App, l: StopLink): Promise<Store> {
  const s = await app.db.one<any>('SELECT name, domain, brand, brand_override FROM stores WHERE id = $1', [l.store_id]);
  const brand = { ...(s?.brand || {}), ...(s?.brand_override || {}) };
  const logo = brand.logoIsMark && /^https:\/\//.test(String(brand.logo || '')) ? String(brand.logo) : null;
  return { name: displayName(s?.brand_override?.name, s?.brand?.name, s?.name) || s?.domain || '', color: readableShade(brandColor(brand) || '#4a4a52'), logo };
}

/** "מ" before a Hebrew name, "מ-" before anything else ("מ-Kli Shop"), the name isolated for bidi. */
const from = (name: string) => `${/^[֐-׿]/.test(name) ? 'מ' : 'מ-'}<bdi>${esc(name)}</bdi>`;
const initialOf = (name: string) => (name.trim().match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();

function page(title: string, body: string, theme: string | null): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#f4f4f6">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/brand.css">
<link rel="stylesheet" href="/static/pitch.css">
${theme ? `<link rel="stylesheet" href="${esc(theme)}">` : ''}
${a11yHead()}
${iconLinks()}
</head>
<body>
<div class="wrap stop">
${body}
<footer class="foot">${accessibilityLink()}</footer>
</div>
${a11yWidget()}
</body>
</html>`;
}

export type StopView = 'ask' | 'done' | 'kept';

/** The page for one link: the question, or the confirmation with its undo. */
export function stopPage(token: string, s: Store, view: StopView): string {
  const mark = s.logo ? `<img class="stop-logo" src="${esc(s.logo)}" alt="" referrerpolicy="no-referrer" decoding="async">` : `<span class="initial" aria-hidden="true">${esc(initialOf(s.name))}</span>`;
  const head = `<header class="stop-store">${mark}<b><bdi>${esc(s.name)}</bdi></b></header>`;
  const form = (what: 'stop' | 'undo', label: string, cls: string) => `<form method="post" action="/u/${esc(token)}"><input type="hidden" name="do" value="${what}"><button class="${cls}" type="submit">${label}</button></form>`;
  const orders = 'עדכונים על הזמנות שעשיתם (תשלום ומשלוח) ימשיכו להגיע.';
  const body = view === 'done'
    ? `${head}
<section class="glass stop-card" aria-live="polite">
  <h1>סגור, לא נשלח לכם יותר תזכורות ${from(s.name)}.</h1>
  <p class="lede">${orders}</p>
  ${form('undo', 'בעצם כן, להמשיך לקבל', 'grey')}
</section>`
    : `${head}
<section class="glass stop-card">
  ${view === 'kept' ? `<p class="stop-note" role="status">בסדר, התזכורות ${from(s.name)} ימשיכו להגיע.</p>` : ''}
  <h1>לא לקבל יותר תזכורות ${from(s.name)}?</h1>
  <p class="lede">אלה ההודעות על מוצרים שנשארו בעגלה והבקשות לכתוב ביקורת. ${orders}</p>
  ${form('stop', 'כן, להפסיק', 'stop-btn')}
</section>`;
  return page(`הגדרות הודעות, ${s.name}`, body, `/u/${token}/theme.css`);
}

/** The page for a token that is not one of ours: the same for every wrong one, and nothing about any store. */
export function stopGone(): string {
  return page('הקישור לא עובד', `<section class="glass stop-card">
  <h1>הקישור הזה לא עובד</h1>
  <p class="lede">אולי הוא לא הועתק עד הסוף. אם קיבלתם מחנות הודעה ואתם לא רוצים עוד תזכורות ממנה, אפשר לענות לה ולבקש.</p>
</section>`, null);
}

export function unsubscribeRoutes(app: App, allowed: (ip: string) => boolean): Route<Req>[] {
  const busy: Out = { status: 429, html: page('רגע', '<section class="glass stop-card"><h1>רגע, יותר מדי בקשות</h1><p class="lede">אפשר לנסות שוב בעוד דקה.</p></section>', null), headers: { ...headers, 'retry-after': '60' } };
  const gone: Out = { status: 404, html: stopGone(), headers };
  return [
    ['GET', /^\/u\/([\w-]{1,64})\/theme\.css$/, async (r, m) => {
      const l = allowed(r.ip) ? await linkOf(app.db, m[1]) : null;
      if (!l) return { status: 404, text: '', type: 'text/css; charset=utf-8' };
      const c = (await storeOf(app, l)).color;
      return { text: `:root{--store:${c};--store-ink:${inkOn(c)}}`, type: 'text/css; charset=utf-8', headers: { 'cache-control': 'public, max-age=300', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' } };
    }],
    ['GET', /^\/u\/([\w-]{1,64})\/?$/, async (r, m) => {
      if (!allowed(r.ip)) return busy;
      const l = await linkOf(app.db, m[1]);
      if (!l) return gone;
      const view: StopView = l.stopped_at ? 'done' : r.url.searchParams.get('kept') === '1' ? 'kept' : 'ask';
      return { html: stopPage(l.token, await storeOf(app, l), view), headers };
    }],
    ['POST', /^\/u\/([\w-]{1,64})\/?$/, async (r, m) => {
      if (!allowed(r.ip)) return busy;
      const l = await linkOf(app.db, m[1]);
      if (!l) return gone;
      // RFC 8058: the mail client posts "List-Unsubscribe=One-Click" (as a form, or multipart), with no cookie and no page.
      const oneClick = r.form['List-Unsubscribe'] === 'One-Click' || /List-Unsubscribe=One-Click|name="List-Unsubscribe"\s+One-Click/.test(r.raw || '');
      if (r.form.do === 'undo' && !oneClick) {
        if (l.stopped_at) await undoFromLink(app, l);
        return { redirect: `/u/${l.token}?kept=1`, headers };
      }
      if (!l.stopped_at) await stopFromLink(app, l, oneClick ? 'one-click' : 'page');
      if (oneClick) return { html: stopPage(l.token, await storeOf(app, l), 'done'), headers };
      return { redirect: `/u/${l.token}`, headers };
    }],
  ];
}
