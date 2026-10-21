import type { App } from '../app.ts';
import { iconLinks, ofMark, toranMark } from '../brand.ts';
import { inkOn, readableShade, storeColor, normHex, hsl } from '../ingest/brand.ts';
import { esc } from '../web/ui.ts';
import { money } from '../agent/tools.ts';
import { shortTitle, type SampleChat } from './build.ts';

// The pitch page: /s/<slug>, one per store, the page the shop owner opens from my
// message. Hebrew, right to left, phone first, never indexed.
//
// It reads as a short letter from Netanel to the owner, in the hebrew-voice guide's
// rules: first person, the thing said first, the store's own facts instead of claims
// (its product count, its shipping and returns lines quoted), what does not work yet
// said plainly, no slogans, no triads, no colons in headings, no grid of identical
// cards. The owner is addressed in the plural ("לכם"), which names the business and
// fits any owner.
//
// Colour: the store's own colour on the sample chat's bubbles and its initial; Toran
// green on the WhatsApp demo button and the Toran mark only; the system's blue nowhere
// on this page except links. The per-store colours come from /s/<slug>/theme.css (the
// CSP allows no inline style).

export type PitchData = {
  store: { id: number; name: string; domain: string; url: string; slug: string; demo_code: string; brand: any; brand_override: any; config: any };
  chat: SampleChat;
  product: { title: string; image: string | null; url: string; price_min: number | null } | null;
  counts: { products: number; available: number };
  shipping: string | null;
  returns: string | null;
  missing: string[];
};

export async function pitchData(app: App, slug: string): Promise<PitchData | null> {
  const store = await app.db.one<any>('SELECT id, name, domain, url, slug, demo_code, brand, brand_override, config FROM stores WHERE slug = $1 AND page_built_at IS NOT NULL', [slug]);
  if (!store) return null;
  const pitch = await app.db.one<any>('SELECT product_id, sample_chat FROM pitches WHERE store_id = $1', [store.id]);
  const product = pitch?.product_id ? await app.db.one<any>('SELECT title, image, url, price_min::float FROM products WHERE id = $1', [pitch.product_id]) : null;
  const counts = await app.db.one<any>('SELECT COUNT(*)::int AS products, COUNT(*) FILTER (WHERE available)::int AS available FROM products WHERE store_id = $1 AND gone_at IS NULL', [store.id]);
  const pol = await app.db.query<{ kind: string; text: string; override_text: string | null }>("SELECT kind, text, override_text FROM policies WHERE store_id = $1 AND kind IN ('shipping', 'returns')", [store.id]);
  const firstSentence = (kind: string) => {
    const p = pol.find((x) => x.kind === kind);
    if (!p) return null;
    const text = (p.override_text || p.text).split('\n').map((l) => l.trim()).filter((l) => l.length > 20 && /[א-ת]/.test(l))[0];
    if (!text) return null;
    const s = text.split(/(?<=[.!?])\s/)[0];
    return s.length > 150 ? `${s.slice(0, 147)}...` : s;
  };
  const missing = [!pol.some((p) => p.kind === 'shipping') && 'משלוחים', !pol.some((p) => p.kind === 'returns') && 'החזרות'].filter(Boolean) as string[];
  return { store, chat: pitch?.sample_chat || [], product, counts, shipping: firstSentence('shipping'), returns: firstSentence('returns'), missing };
}

/** The store's colours for its page, as CSS custom properties. */
export function themeCss(d: PitchData): string {
  const brand = { ...(d.store.brand || {}), ...(d.store.brand_override || {}) };
  const main = storeColor(brand);
  const bubble = readableShade(main);
  const second = (brand.colors || []).map(normHex).find((c: string | null) => c && c !== main) || main;
  const { h } = hsl(main);
  return `:root{--store:${main};--store-bubble:${bubble};--store-ink:${inkOn(bubble)};--store-2:${second};--store-hue:${Math.round(h)}}`;
}

const initialOf = (name: string) => (String(name).trim().match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();

export function waLink(env: Record<string, string | undefined>, code: string, name: string): string | null {
  const num = String(env.DEMO_WA_NUMBER || '').replace(/\D/g, '');
  if (!num) return null;
  return `https://wa.me/${num}?text=${encodeURIComponent(`${code} היי, אני רוצה לנסות את העוזר של ${name}`)}`;
}

function bubble(m: { role: string; text: string }) {
  return `<div class="msg ${m.role === 'agent' ? 'out' : 'in'}"><p>${esc(m.text).replace(/(https?:\/\/[^\s<]+)/g, '<span class="lnk">$1</span>').replace(/\n/g, '<br>')}</p></div>`;
}

export function pitchPage(d: PitchData, { env, preview = false }: { env: Record<string, string | undefined>; preview?: boolean }): string {
  const brand = { ...(d.store.brand || {}), ...(d.store.brand_override || {}) };
  const name = String(brand.name || d.store.name || d.store.domain);
  const logo = typeof brand.logo === 'string' && /^https:\/\//.test(brand.logo) ? brand.logo : null;
  const link = waLink(env, d.store.demo_code, name);
  const owner = { name: env.TORAN_OWNER_NAME || 'נתנאל', wa: String(env.TORAN_OWNER_WHATSAPP || '').replace(/\D/g, ''), email: env.TORAN_OWNER_EMAIL || '' };
  const currency = d.store.config?.currency || 'ILS';
  const n = d.counts.products;
  const productName = d.product ? shortTitle(d.product.title) : null;
  const initial = `<span class="initial" aria-hidden="true">${esc(initialOf(name))}</span>`;

  const knows = [
    `<li><b class="num">${n}</b> מוצרים, <span class="num">${d.counts.available}</span> מהם במלאי היום. את המחירים והמלאי הוא קורא מהאתר, ואני מרענן אותם פעם ביום.</li>`,
    d.shipping ? `<li>על משלוחים הוא עונה לפי הדף שלכם, שכתוב בו: <q>${esc(d.shipping)}</q></li>` : '',
    d.returns ? `<li>על החזרות והחלפות, לפי מה שכתבתם: <q>${esc(d.returns)}</q></li>` : '',
    d.missing.length ? `<li>לא מצאתי אצלכם דף על ${d.missing.join(' ועל ')}, אז על זה הוא לא ממציא תשובה. הוא כותב ללקוח שהוא בודק, ומעביר אליכם.</li>` : '',
  ].filter(Boolean);

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>העוזר של ${esc(name)} בוואטסאפ · תורן</title>
<meta name="description" content="דמו של עוזר וואטסאפ שעונה ללקוחות של ${esc(name)}, מהמחירים והמדיניות שבאתר.">
<link rel="stylesheet" href="/static/brand.css">
<link rel="stylesheet" href="/static/pitch.css">
<link rel="stylesheet" href="/s/${esc(d.store.slug)}/theme.css">
${iconLinks()}
</head>
<body${preview ? ' class="preview"' : ''}>
<header class="bar">
  <div class="who">${initial}<span class="sname">${esc(name)}</span></div>
  <div class="by">${toranMark(26, { label: 'תורן' })}<span>תורן</span></div>
</header>

<main class="page" data-slug="${esc(d.store.slug)}">
  <section class="letter" data-depth="25">
    ${logo ? `<img class="logo" src="${esc(logo)}" alt="${esc(name)}" referrerpolicy="no-referrer" loading="lazy" data-hide-on-error>` : ""}
    <p class="eyebrow">הכנתי את זה בשביל <bdi>${esc(name)}</bdi></p>
    <h1>בניתי עוזר לוואטסאפ של ${esc(name)}, והוא כבר מכיר את ${n > 1 ? `${n} המוצרים` : 'המוצרים'} שלכם.</h1>
    <p class="lede">הוא עונה ללקוחות על מוצרים, מחירים, מלאי ומשלוחים, רק לפי מה שכתוב אצלכם באתר. כשהוא לא יודע משהו, הוא אומר שהוא בודק ומעביר אליכם. אפשר לנסות אותו עכשיו מהטלפון, מהצד של הלקוח.</p>
    <div class="cta">
      ${link ? `<a class="wa" href="${esc(link)}" data-demo rel="noopener">${waIcon()}<span>לנסות את הדמו בוואטסאפ</span></a>` : `<span class="wa off">${waIcon()}<span>מספר הדמו עוד לא מוגדר</span></span>`}
      <p class="small">נפתחת שיחה עם הודעה מוכנה שמתחילה בקוד <bdi class="code">${esc(d.store.demo_code)}</bdi>. שולחים אותה, ומשם כל שאלה נענית כאילו נשלחה ל־${esc(name)}.</p>
    </div>
  </section>

  <section class="phone-wrap" data-depth="50" aria-label="שיחת דוגמה">
    <div class="phone">
      <div class="ph-top">${initial}<div><b>${esc(name)}</b><small>עוזר דיגיטלי · עונה מיד</small></div></div>
      <div class="ph-chat">
        ${d.product?.image ? `<div class="msg in card"><img src="${esc(d.product.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span>${esc(productName || '')}${d.product.price_min != null ? ` · ${esc(money(d.product.price_min, currency))}` : ''}</span></div>` : ''}
        ${d.chat.map(bubble).join('')}
      </div>
    </div>
    <p class="caption">את השאלה כתבתי אני. את התשובה כתב העוזר מהנתונים באתר שלכם${productName ? `, על ${esc(productName)}` : ''}, ולא נגעתי בה.</p>
  </section>

  <section class="facts" data-depth="75">
    <h2>מה הוא כבר יודע על ${esc(name)}</h2>
    <ul>${knows.join('')}</ul>
  </section>

  <section class="day">
    <h2>ככה זה נראה ביום רגיל</h2>
    <ol>
      <li><b>שאלה על מוצר בעשר בלילה.</b> הוא בודק במלאי ועונה עם המחיר שבאתר, תוך כמה שניות. את השיחה אתם רואים למחרת, אם בכלל צריך.</li>
      <li><b>מישהו מבקש הנחה או החזר.</b> הוא לא מבטיח כלום, גם כשלוחצים עליו. הוא כותב שהעביר את הבקשה, ואתם מקבלים שורה אחת שמסכמת מה הלקוח רוצה.</li>
      <li><b>מי שמוכן לקנות</b> מקבל קישור למוצר. בגרסה המלאה זה קישור לעגלה שכבר מחכה לו.</li>
      <li><b>שאלה שאין לה קשר לחנות,</b> כמו מזג האוויר, מקבלת תשובה קצרה שהוא כאן בשביל החנות. ככה המספר נשאר בתוך הכללים של וואטסאפ לעסקים.</li>
    </ol>
  </section>

  <section class="limits" data-depth="100">
    <h2>מה עוד לא עובד</h2>
    <p>הדמו לא מחובר להזמנות שלכם, אז על "איפה ההזמנה שלי" הוא עונה שבגרסה המלאה זה ייבדק אוטומטית, ומעביר אליכם. הוא גם עונה כרגע ממספר הדמו שלי ולא מהמספר של ${esc(name)}. את המספר שלכם מחברים רק אם מחליטים להמשיך.</p>
  </section>

  <section class="sign">
    <p>אני ${esc(owner.name)}. בניתי את תורן לבד, ואני גם זה שעונה כאן. אם בא לכם לנסות אותו על המספר שלכם, כותבים לי${owner.wa || owner.email ? '' : ' [פרטי קשר]'}.</p>
    <div class="sign-row">
      ${owner.wa ? `<a class="btn-quiet" href="https://wa.me/${esc(owner.wa)}" rel="noopener">לכתוב לי בוואטסאפ</a>` : ''}
      ${owner.email ? `<a class="btn-quiet" href="mailto:${esc(owner.email)}">במייל</a>` : ''}
    </div>
  </section>
</main>

<footer class="foot">${ofMark(18, { label: null })}<span>תורן נבנה על ידי <span class="ltr">OpenFrequency</span></span></footer>
${link ? `<div class="dock">${link ? `<a class="wa" href="${esc(link)}" data-demo rel="noopener">${waIcon()}<span>לנסות בוואטסאפ</span></a>` : ''}</div>` : ''}
<script src="/static/pitch.js" defer></script>
</body>
</html>`;
}

function waIcon() {
  return '<svg class="wai" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.2a9.7 9.7 0 0 0-8.3 14.8L2.4 21.8l4.9-1.3A9.7 9.7 0 1 0 12 2.2zm0 17.7c-1.5 0-3-.4-4.2-1.2l-.3-.2-2.9.8.8-2.8-.2-.3a8 8 0 1 1 6.8 3.7zm4.4-6c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.8 1c-.1.2-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 0 0-.7.3 2.8 2.8 0 0 0-.9 2.1c0 1.3.9 2.5 1 2.6.1.2 1.8 2.8 4.4 3.9 1.6.7 2.3.8 3.1.6.5-.1 1.4-.6 1.6-1.1.2-.6.2-1 .1-1.1l-.4-.3z"/></svg>';
}
