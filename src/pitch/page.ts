import type { App } from '../app.ts';
import { iconLinks, ofMark, toranMark } from '../brand.ts';
import { brandColor, displayName, inkOn, readableShade } from '../ingest/brand.ts';
import { esc } from '../web/ui.ts';
import { money } from '../agent/tools.ts';
import { getOffer, ofWhatsapp, PAGE_ABOUT, PAGE_DOWN, type Offer } from '../offer.ts';
import { pitchUrl } from '../outreach.ts';
import { shortTitle, type SampleChat } from './build.ts';
import { autoApprove, isPublic, pitchGaps, type Gap } from './ready.ts';

// The pitch page: /s/<slug>, one per store, the page a shop owner opens from our
// message. Hebrew, right to left, one column, phone first, light only, never indexed.
//
// The speaker is OpenFrequency, the company, in the first person plural ("בנינו",
// "תכתבו לנו"), in the hebrew-voice guide's rules: the thing said first, the store's own
// facts instead of claims, no slogans, no triads, no colons in headings. The agent in
// the sample chat speaks as the store. The owner is addressed in the plural ("לכם").
//
// The look is the Teder family's: silver wallpaper, frosted glass panels, pill buttons.
// Colour: the store's own colour on its initial and its chat bubbles only, darkened
// until white text on it passes 4.5:1; Toran green on the WhatsApp buttons and the Toran
// mark; OpenFrequency's mark small, in the top line and the footer. The per-store colour
// comes from /s/<slug>/theme.css (the CSP allows no inline style).
//
// Nothing on the page is a guess. A field that is missing holds the page back
// (pitch/ready.ts); the owner's own view shows the page anyway, with a visible
// [placeholder] where the gap is and a note on top saying why nobody else can see it.

export type PitchData = {
  store: { id: number; name: string | null; domain: string; url: string; slug: string; demo_code: string; brand: any; brand_override: any; config: any; approved_at: any; taken_down_at: any; status: string };
  name: string | null;
  color: string | null;
  chat: SampleChat;
  product: { title: string; image: string | null; url: string; price_min: number | null } | null;
  counts: { products: number; available: number; images: number; min: number | null; max: number | null };
  pages: { shipping: boolean; returns: boolean; titles: string[] };
  shelf: ShelfItem[];
  offer: Offer;
  gaps: Gap[];
  public: boolean;
};

export type ShelfItem = { title: string; image: string; price_min: number | null };

/** How many of the store's products the strip under the hero shows, and the fewest it needs to show any. */
const SHELF_MAX = 16;
const SHELF_MIN = 3;

export async function pitchData(app: App, slug: string): Promise<PitchData | null> {
  const store = await app.db.one<any>('SELECT id, name, domain, url, slug, demo_code, brand, brand_override, config, approved_at, taken_down_at, status FROM stores WHERE slug = $1 AND page_built_at IS NOT NULL', [slug]);
  if (!store) return null;
  const brand = { ...(store.brand || {}), ...(store.brand_override || {}) };
  const pitch = await app.db.one<any>('SELECT product_id, sample_chat FROM pitches WHERE store_id = $1', [store.id]);
  const product = pitch?.product_id ? await app.db.one<any>('SELECT title, image, url, price_min::float FROM products WHERE id = $1', [pitch.product_id]) : null;
  const counts = await app.db.one<any>('SELECT COUNT(*)::int AS products, COUNT(*) FILTER (WHERE available)::int AS available, COALESCE(SUM(image_count), 0)::int AS images, MIN(price_min)::float AS min, MAX(price_max)::float AS max FROM products WHERE store_id = $1 AND gone_at IS NULL', [store.id]);
  const policies = await app.db.query<{ kind: string; title: string }>('SELECT kind, title FROM policies WHERE store_id = $1 ORDER BY id', [store.id]);
  const kinds = new Set(policies.map((p) => p.kind));
  // The store's own products with a photo, in stock first, for the strip under the hero.
  const shelf = await app.db.query<ShelfItem>(
    "SELECT title, image, price_min::float FROM products WHERE store_id = $1 AND gone_at IS NULL AND image IS NOT NULL AND image <> '' AND COALESCE((override->>'hidden')::boolean, false) = false ORDER BY available DESC, id LIMIT $2",
    [store.id, SHELF_MAX],
  );
  const gaps = await pitchGaps(app, store);
  await autoApprove(app, store, gaps);
  return {
    store,
    name: displayName(store.brand_override?.name, store.brand?.name, store.name),
    color: brandColor(brand),
    chat: (pitch?.sample_chat || []).length >= 4 ? pitch.sample_chat : [],
    product,
    counts,
    pages: { shipping: kinds.has('shipping'), returns: kinds.has('returns'), titles: [...new Set(policies.map((p) => p.title.trim()).filter(Boolean))] },
    shelf: shelf.length >= SHELF_MIN ? shelf : [],
    offer: await getOffer(app.db),
    gaps,
    public: isPublic(store, gaps),
  };
}

/** The store's colour for its page, darkened until white text on it passes 4.5:1. Graphite only in the owner's preview of a page held for its colour. */
export function themeCss(d: PitchData): string {
  const c = readableShade(d.color || '#4a4a52');
  // Each row of the strip takes 4 seconds a product to come round, so a longer row is not a faster one.
  const pace = shelfRows(d.shelf).map((r, i) => `--shelf-${i}:${r.length * 4}s`).join(';');
  return `:root{--store:${c};--store-ink:${inkOn(c)}${pace ? ';' + pace : ''}}`;
}

/**
 * The strip's rows: one row for a few products, two from 6 on, every other product to each. A row repeats its
 * products until it holds at least 8, so one copy of it is wider than the page and the loop has no gap.
 */
export function shelfRows(shelf: ShelfItem[]): ShelfItem[][] {
  if (!shelf.length) return [];
  const rows = shelf.length >= 6 ? [shelf.filter((_, i) => i % 2 === 0), shelf.filter((_, i) => i % 2 === 1)] : [shelf];
  return rows.map((r) => Array.from({ length: Math.ceil(8 / r.length) }, () => r).flat());
}

/** A Shopify photo at the size the strip shows it, so a page never loads a full-size photo for a 132px tile. */
const thumb = (src: string) => (/(^https:\/\/cdn\.shopify\.com\/|\/cdn\/shop\/)/.test(src) ? `${src}${src.includes('?') ? '&' : '?'}width=300` : src);

const initialOf = (name: string | null) => (String(name || '').trim().match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();

/** The prefix of outreach.le: "ל" before a Hebrew name, "ל־" before any other. */
const le = (name: string) => (/^[א-ת]/.test(name) ? 'ל' : 'ל־');

const digits = (s: unknown) => String(s || '').replace(/\D/g, '');

export function waLink(env: Record<string, string | undefined>, code: string, name: string): string | null {
  const num = digits(env.DEMO_WA_NUMBER);
  if (!num) return null;
  return `https://wa.me/${num}?text=${encodeURIComponent(`${code} היי, באתי לנסות את תורן של ${name}`)}`;
}

/**
 * The price on the page's price card, as openfrequency.co.il shows it: the monthly figure large, and under it VAT and
 * the setup fee. A part not decided yet is a [placeholder] in the owner's view (`ph`); the public page is held back
 * until all of it is set (pitch/ready.ts), so `ph` null never meets a gap.
 */
export function priceFigure(o: Offer, ph: ((label: string) => string) | null): string {
  const gap = (label: string) => (ph ? ph(label) : '');
  const figure = o.monthly != null && o.monthly > 0 ? `<span class="num">${esc(o.monthly.toLocaleString('he-IL'))}</span><span class="cur">₪</span>` : gap('[המחיר]');
  const vat = o.vat === 'included' ? 'כולל מע״מ.' : o.vat === 'excluded' ? 'לא כולל מע״מ.' : gap('[כולל או לא כולל מע״מ]');
  const setup = o.setup == null ? gap('[דמי הקמה, אם יש]') : o.setup > 0 ? `בחודש הראשון יש גם ${esc(`${o.setup.toLocaleString('he-IL')} ₪`)} דמי הקמה, פעם אחת.` : 'אין דמי הקמה.';
  return `<p class="figure">${figure}<span class="per">לחודש</span></p>\n        <p class="price-notes">${vat} ${setup}</p>`;
}

function bubble(m: { role: string; text: string }) {
  const text = esc(m.text).replace(/(https?:\/\/[^\s<]+)/g, '<span class="lnk" dir="ltr">$1</span>').replace(/\n/g, '<br>');
  return `<div class="msg ${m.role === 'agent' ? 's' : 'c'}"><p>${text}</p></div>`;
}

const waIcon = () => `<svg class="wa-i" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.4-.3Z"/></svg>`;

export function pitchPage(d: PitchData, { env, owner = false, preview = false }: { env: Record<string, string | undefined>; owner?: boolean; preview?: boolean }): string {
  const ph = (label: string) => `<mark class="ph" dir="rtl">${esc(label)}</mark>`;
  const nameText = d.name || d.store.domain;
  const name = d.name ? `<bdi>${esc(d.name)}</bdi>` : ph('[שם החנות]');
  const leName = d.name ? `${le(d.name)}<span class="hl">${name}</span>` : `ל${name}`;
  const demo = waLink(env, d.store.demo_code, nameText);
  const of = ofWhatsapp(env);
  const url = pitchUrl(env, d.store.slug);
  // Both messages end with the page's link: on the demo number (when it is also ours) the router knows the store by it.
  const ofLink = of ? `https://wa.me/${of}?text=${encodeURIComponent(`${PAGE_ABOUT} ${le(nameText)}${nameText}: ${url}`)}` : null;
  const downLink = of ? `https://wa.me/${of}?text=${encodeURIComponent(`${PAGE_DOWN} ${le(nameText)}${nameText}? ${url}`)}` : null;
  const n = d.counts.products;
  const initial = (cls = 'initial') => `<span class="${cls}" aria-hidden="true">${esc(initialOf(d.name))}</span>`;
  const currency = d.store.config?.currency || 'ILS';
  const productName = d.product ? shortTitle(d.product.title) : null;

  // What we read, said with what was really found: "על 14 המוצרים ועל עמודי המשלוחים וההחזרות".
  const prods = n === 1 ? 'המוצר' : `${n.toLocaleString('he-IL')} המוצרים`;
  const pages = d.pages.shipping && d.pages.returns ? 'עמודי המשלוחים וההחזרות' : d.pages.shipping ? 'עמוד המשלוחים' : d.pages.returns ? 'עמוד ההחזרות' : null;
  const read = pages ? `עברנו על האתר שלכם, על ${prods} ועל ${pages}. תורן כבר מכיר אותם.` : `עברנו על האתר שלכם ועל ${prods} שבו. תורן כבר מכיר ${n === 1 ? 'אותו' : 'אותם'}.`;

  // What we read, as numbers: the products, their images, the information pages (named under them) and the prices.
  const num = (x: number) => x.toLocaleString('he-IL');
  const stat = (v: string, label: string, cls = '') => `<div${cls ? ` class="${cls}"` : ''}><dt>${label}</dt><dd>${v}</dd></div>`;
  const range = d.counts.min == null ? null : d.counts.max == null || d.counts.max === d.counts.min ? esc(money(d.counts.min, currency)) : `${esc(money(d.counts.min, currency))} <small>עד</small> ${esc(money(d.counts.max, currency))}`;
  const stats = [
    stat(num(n), n === 1 ? 'מוצר' : 'מוצרים'),
    d.counts.images ? stat(num(d.counts.images), d.counts.images === 1 ? 'תמונת מוצר' : 'תמונות מוצרים') : '',
    d.pages.titles.length ? stat(num(d.pages.titles.length), d.pages.titles.length === 1 ? 'עמוד מידע' : 'עמודי מידע') : '',
    range ? stat(range, 'טווח המחירים', 'wide') : '',
  ].join('');
  const readSec = `<section class="read" aria-labelledby="read-h">
    <h2 id="read-h">מה קראנו באתר שלכם</h2>
    <dl class="stats">${stats}</dl>
    ${d.pages.titles.length ? `<div class="pages"><span id="pages-h">עמודי המידע שקראנו</span><ul aria-labelledby="pages-h">${d.pages.titles.map((t) => `<li><bdi>${esc(t)}</bdi></li>`).join('')}</ul></div>` : ''}
  </section>`;

  // The store's own products, moving past under the hero in one or two rows, so the page opens on their shop. Each row
  // is two identical lists side by side, moved by one list's width. It is a picture of their shop, repeated to loop,
  // so it is hidden from screen readers; the numbers under it say what was read.
  const tile = (p: ShelfItem) => `<li><img src="${esc(thumb(p.image))}" alt="" width="132" height="132" referrerpolicy="no-referrer" decoding="async" data-hide-on-error><b>${esc(shortTitle(p.title))}</b>${p.price_min != null ? `<small>${esc(money(p.price_min, currency))}</small>` : ''}</li>`;
  const shelfSec = d.shelf.length
    ? `<div class="shelf" aria-hidden="true">
    ${shelfRows(d.shelf).map((row, r) => `<div class="shelf-row r${r}"><div class="shelf-track">${[0, 1].map(() => `<ul>${row.map(tile).join('')}</ul>`).join('')}</div></div>`).join('\n    ')}
  </div>`
    : '';

  const greenBtn = (label: string, cls = '') => (demo ? `<a class="wa ${cls}" href="${esc(demo)}" data-demo rel="noopener">${waIcon()}<span>${label}</span></a>` : `<span class="wa off ${cls}">${waIcon()}<span>${owner ? ph('[מספר הדמו]') : label}</span></span>`);
  const held = owner && !d.public ? `<aside class="held" role="note"><b>${d.store.taken_down_at ? 'העמוד הזה הוסר. רואים אותו רק מהדשבורד.' : 'את העמוד הזה רואים רק מהדשבורד, עוד לא לכולם.'}</b>${d.gaps.length ? `<ul>${d.gaps.map((g) => `<li>${esc(g.he)}</li>`).join('')}</ul>` : !d.store.approved_at && !d.store.taken_down_at ? '<p>הוא נפתח לכולם אחרי שמאשרים אותו בבדיקה.</p>' : ''}</aside>` : '';

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#f4f4f6">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>בנינו ${esc(le(nameText))}${esc(nameText)} תורן שעונה ללקוחות שלכם</title>
<meta name="description" content="${esc(read)}">
<link rel="preload" href="/static/fonts/heebo-hebrew.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/brand.css">
<link rel="stylesheet" href="/static/pitch.css">
<link rel="stylesheet" href="/s/${esc(d.store.slug)}/theme.css">
${iconLinks()}
</head>
<body${preview ? ' class="preview"' : ''}>
<div class="wrap" data-slug="${esc(d.store.slug)}">
  <header class="top">
    <span class="for">עמוד שהכנו בשביל ${name}</span>
    <span class="by">${ofMark(16, { label: null })}<span dir="ltr">OpenFrequency</span></span>
  </header>
  ${held}

  <div class="lead${d.shelf.length ? ' with-shelf' : ''}">
  <section class="hero">
    <div class="marks">${initial()}${toranMark(64, { label: 'תורן' })}</div>
    <h1>בנינו ${leName} תורן שעונה ללקוחות שלכם</h1>
    <p class="lede">${esc(read)} אפשר לכתוב לו עכשיו כמו לקוח ולראות מה הוא עונה.</p>
    ${readSec}
    <div class="read-cta">
      ${greenBtn('לכתוב לו בוואטסאפ', 'big')}
      <p class="quiet">זו הדגמה. אף לקוח שלכם לא רואה אותה.</p>
    </div>
  </section>

  ${shelfSec}
  </div>

  <section class="glass chat" data-depth="25" aria-label="שיחת דוגמה">
    <header class="ch-head">${initial('initial sm')}<div><b>${name}</b><small>שיחה על מוצר אמיתי מהאתר שלכם</small></div></header>
    ${d.product ? `<div class="prod">${d.product.image ? `<img src="${esc(d.product.image)}" alt="" width="52" height="52" referrerpolicy="no-referrer" data-hide-on-error>` : ''}<div><b>${esc(productName || '')}</b>${d.product.price_min != null ? `<small>${esc(money(d.product.price_min, currency))}</small>` : ''}</div></div>` : ''}
    <div class="msgs">${d.chat.length ? d.chat.map(bubble).join('') : owner ? `<p class="empty">${ph('[שיחת הדוגמה עוד לא נבנתה]')}</p>` : ''}</div>
  </section>
  <p class="caption">את השאלות כתבנו אנחנו. התשובות הן מה שתורן ענה באמת, ולא שינינו בהן מילה.</p>

  <section class="price" data-depth="50" aria-labelledby="price-h">
    <h2 id="price-h">אם תחברו אותו למספר של החנות</h2>
    <div class="glass price-card">
      <div class="price-main">
        <p class="price-name">${toranMark(36, { label: null })}<b>תורן</b></p>
        ${priceFigure(d.offer, owner ? ph : null)}
        ${greenBtn('לכתוב לתורן')}
      </div>
      <div class="price-incl">
        <h3>מה כלול במחיר</h3>
        <ul class="checks">
          <li>לקוחות יקבלו תשובות כאלה גם כשאתם באמצע יום עמוס, או כבר ישנים.</li>
          <li>שאלה שהוא לא יודע לענות עליה מגיעה אליכם בוואטסאפ. עונים לו פעם אחת, ובפעם הבאה הוא כבר יודע.</li>
          <li>מי שהסכים לקבל מכם הודעות יקבל תזכורת כשהוא משאיר מוצרים בעגלה, ואחרי שהוא מזמין, לינק למעקב אחרי המשלוח.</li>
          <li>בשבועיים הראשונים אנחנו קוראים איתכם את השיחות ומתקנים מה שצריך.</li>
        </ul>
      </div>
    </div>
    <p class="after">ואם זה לא בשבילכם, תכתבו לנו ונוריד את העמוד. ${ofLink ? `<a class="grey sm" href="${esc(ofLink)}" rel="noopener">לכתוב לנו</a>` : `<span class="grey sm off">${owner ? ph('[המספר של OpenFrequency]') : 'לכתוב לנו'}</span>`}</p>
  </section>

  <footer class="foot" data-depth="100">
    <span class="by">${ofMark(16, { label: null })}<span><span dir="ltr">OpenFrequency</span>, ${esc(d.offer.city)}</span></span>
    ${downLink ? `<a href="${esc(downLink)}" data-takedown rel="noopener">להוריד את העמוד הזה</a>` : owner ? ph('[חסר המספר של OpenFrequency, אז אין לינק להורדת העמוד]') : ''}
  </footer>
</div>
${demo ? `<div class="dock">${greenBtn('לכתוב לו בוואטסאפ')}</div>` : ''}
<script src="/static/pitch.js" defer></script>
</body>
</html>`;
}

/** The page for a slug that is not (or no longer) there. */
export function goneHtml(removed: boolean): string {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="robots" content="noindex, nofollow"><title>${removed ? 'העמוד הוסר' : 'העמוד לא נמצא'}</title><link rel="stylesheet" href="/static/brand.css"><link rel="stylesheet" href="/static/pitch.css"></head><body><div class="wrap"><section class="hero gone"><h1>${removed ? 'העמוד הזה הוסר' : 'העמוד הזה לא כאן'}</h1><p class="lede">${removed ? 'הורדנו אותו כמו שביקשתם, והקישור כבר לא עובד.' : 'אולי הקישור ישן. אם קיבלתם אותו מאיתנו, אפשר לענות להודעה ונשלח קישור חדש.'}</p></section></div></body></html>`;
}
