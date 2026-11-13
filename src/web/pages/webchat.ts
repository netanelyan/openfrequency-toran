import type { App } from '../../app.ts';
import { siteOrigin, storeLook, turnOff, turnOn, webAccountOf } from '../../channels/web.ts';
import { botName } from '../../agent/intro.ts';
import { J } from '../../db/index.ts';
import { audit } from '../../db/log.ts';
import { displayName } from '../../ingest/brand.ts';
import { colorOf, lookCss, type LookChoice, type LookMode } from '../../ingest/palette.ts';
import { decide, reviewsOf } from '../../reviews.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { previewPage } from '../widget.ts';
import { csrfField, esc, icon, postButton, sendTo, stamp } from '../ui.ts';
import { channelSwitch, offChannels } from './channelOff.ts';
import { liveOf } from '../../golive.ts';

// The store's chat on its own site (channels/web.ts, web/widget.ts) and the reviews Toran collected (reviews.ts), on
// the store's Settings: turn the chat on, the one line to add with where to paste it on each platform, the domains it
// may show on; and the reviews, each with the customer's word, to show on the site or hide.
//
// Where the line goes, as each platform's own help says it:
//   Shopify      Online Store > Themes > ... > Edit code (help.shopify.com/en/manual/online-store/themes/customizing-themes/edit-code);
//                the file is layout/theme.liquid, before </body> (the theme's layout, which every page uses: UNVERIFIED in
//                that article's words, it names the editor, not the file)
//   WooCommerce  the WPCode plugin, Code Snippets > Header & Footer, the Footer box (wpcode.com/docs/using-the-global-header-footer-settings/)
//   Wix          Settings > Custom Code > + Add Custom Code, All pages, Body - end (support.wix.com/en/article/wix-editor-embedding-custom-code-on-your-site)
//                The last buttons' names ("Save" in Shopify's editor, "Save Changes" in WPCode, "Apply" in Wix) are UNVERIFIED
//                against those pages today.

const publicBase = (app: App) => String(app.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || `http://localhost:${app.env.PORT || 4710}`;

// The owner, 2026-11-09: "make everything easy for the user. he also doesnt know anything about tech" (the project's
// rule: one action per screen, no codes shown). Adding the chat to the site is a line of code, so the card's main
// button sends whoever runs the site a ready message with the line and where it goes; "להוסיף בעצמי" folds the steps
// for the store's own platform with a copy button, and the line itself, the sites it may show on and the reviews'
// place are under "עוד אפשרויות". Once the chat opened on the site, the card says so and has the switch.
const PLATFORM_STEPS: Record<string, { name: string; steps: string[]; dev: string }> = {
  shopify: { name: 'Shopify', steps: ['בניהול של Shopify נכנסים ל־Online Store ואז ל־Themes.', 'ליד התבנית לוחצים על שלוש הנקודות, ואז Edit code.', 'פותחים את הקובץ theme.liquid, מדביקים את השורה ממש לפני </body>, ולוחצים Save.'], dev: 'ב־Shopify: Online Store > Themes > ... > Edit code, בקובץ layout/theme.liquid לפני </body>.' },
  woocommerce: { name: 'WooCommerce', steps: ['בניהול של וורדפרס מתקינים את התוסף WPCode.', 'נכנסים ל־Code Snippets ואז ל־Header & Footer.', 'מדביקים את השורה בתיבה Footer, ולוחצים Save Changes.'], dev: 'בוורדפרס: עם WPCode (Code Snippets > Header & Footer > Footer), או ב־footer של התבנית.' },
  wix: { name: 'Wix', steps: ['בהגדרות האתר ב־Wix נכנסים ל־Custom Code.', 'לוחצים Add Custom Code ומדביקים את השורה.', 'בוחרים All pages ו־Body - end, ולוחצים Apply.'], dev: 'ב־Wix: Settings > Custom Code > Add Custom Code, All pages, Body - end.' },
};

// How the chat looks (the owner, 2026-11-09: "design the website widget better. make it according to the website's
// colors"): as on the store's site by default, the colours Toran read there shown as swatches; the owner may pick
// another main colour, and light or dark under "עוד אפשרויות". One button saves; the preview beside it is the real
// chat, redrawn as the owner picks (static/app.js data-look), from /lead/<id>/web/preview and its look.css.

const MODES: [LookMode, string][] = [['site', 'כמו באתר'], ['light', 'בהיר'], ['dark', 'כהה']];

/** The owner's choice as a form or a query says it: "own" with a colour, else the site's; light, dark or the site's. */
export function choiceOf(q: { use?: unknown; color?: unknown; mode?: unknown }): LookChoice {
  const color = q.use === 'own' ? colorOf(String(q.color || '')) : null;
  const mode = MODES.some(([m]) => m === q.mode) ? (q.mode as LookMode) : 'site';
  return { color, mode };
}

const choiceQuery = (p: URLSearchParams) => ({ use: p.get('use') || 'site', color: p.get('color') || '', mode: p.get('mode') || 'site' });

// The preview is a page of the dashboard framed by the dashboard itself, and nothing else may frame it.
const PREVIEW_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'none'; font-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'SAMEORIGIN',
};

const swatch = (c: string, label: string) => `<svg class="look-sw" role="img" aria-label="${esc(label)}" width="22" height="22" viewBox="0 0 22 22"><title>${esc(label)}</title><circle cx="11" cy="11" r="10" fill="${esc(c)}"/></svg>`;

function lookCard(r: DashReq, id: number, s: { brand: any; brand_override: any }, choice: LookChoice, may: boolean): string {
  const site = storeLook(s, null);
  const found = site.from === 'site';
  const own = Boolean(choice.color);
  const mode = choice.mode || 'site';
  const q = (c: LookChoice) => new URLSearchParams({ use: c.color ? 'own' : 'site', color: c.color || '', mode: c.mode || 'site' }).toString();
  const swatches = `<span class="sws">${swatch(site.primary, 'הצבע הראשי')}${swatch(site.bg, 'הרקע')}${swatch(site.text, 'הטקסט')}${swatch(site.accent, 'הקישורים')}</span>`;
  const preview = `<div class="look-pv"><iframe id="look-${id}" src="/lead/${id}/web/preview?${esc(q(choice))}" title="תצוגה של הצ׳אט באתר" loading="lazy"></iframe><p class="small muted m0">ככה הלקוחות יראו אותו באתר. השיחה כאן היא דוגמה.</p></div>`;
  if (!may) return `<h3 class="small mt16">איך הצ׳אט נראה</h3><div class="look-wrap"><div class="look">${preview}</div></div>`;
  return `<h3 class="small mt16">איך הצ׳אט נראה</h3>
  <div class="look-wrap"><div class="look">
  <form method="post" action="/lead/${id}/web" class="look-form" data-look="#look-${id}">${csrfField(r.ctx)}<input type="hidden" name="do" value="look">
    <fieldset class="look-pick"><legend class="sr">הצבע הראשי</legend>
      <label class="look-opt"><input type="radio" name="use" value="site"${own ? '' : ' checked'}><span><b>כמו באתר שלכם</b><small>${found ? `הצבעים שמצאנו באתר ${swatches}` : 'לא מצאנו צבעים באתר, אז הצ׳אט בצבעים ניטרליים.'}</small></span></label>
      <label class="look-opt"><input type="radio" name="use" value="own"${own ? ' checked' : ''}><span><b>צבע אחר</b><small>לכפתור ולבועות של הלקוחות</small></span><input type="color" name="color" value="${esc(choice.color || site.primary)}" aria-label="הצבע הראשי"></label>
    </fieldset>
    <details class="mt8"${mode !== 'site' ? ' open' : ''}><summary class="small">עוד אפשרויות</summary>
      <fieldset class="look-mode mt8"><legend class="small">בהיר או כהה</legend>${MODES.map(([m, t]) => `<label><input type="radio" name="mode" value="${m}"${m === mode ? ' checked' : ''}>${t}${m === 'site' ? (site.dark ? ' (כהה)' : ' (בהיר)') : ''}</label>`).join('')}</fieldset>
      <p class="small muted mt8 m0">בכל צבע שתבחרו, הטקסט נשאר קריא. כשצריך, אנחנו מכהים או מבהירים אותו קצת.</p>
    </details>
    <div class="row mt12"><button class="btn sm" type="submit">לשמור</button></div>
  </form>
  ${preview}
  </div></div>`;
}

/**
 * The chat panel on a store's Settings. `main`: its next step may be the page's main button (Settings passes false while
 * another card holds it; the audit of 2026-11-12, P1-11).
 */
export async function webChatPanel(app: App, r: DashReq, s: { id: number; name: string; platform?: string | null }, main = true): Promise<string> {
  const may = !r.ctx.readOnly && r.user.role !== 'client_member';
  const a = await webAccountOf(app, s.id);
  const on = a?.status === 'active';
  const seen = Boolean(a?.meta?.first_seen_at);
  const chip = !on ? ['ghost', 'כבוי'] : seen ? ['ok', 'פועל באתר'] : ['sig', 'נשאר להוסיף לאתר'];
  // The chat takes messages while Toran does not answer: what the visitor reads then (channels/store.ts HELD_WEB, P0-5).
  const store = (await liveOf(app, s.id)).state;
  const head = `<section class="panel" id="webchat"><header><h2>צ׳אט באתר</h2><span class="end chip ${chip[0]}">${chip[1]}</span></header>
  <p class="m0">כפתור צ׳אט בפינה של האתר של ${esc(s.name)}: הלקוחות שואלים בלי לצאת מהדף, ותורן עונה כמו בוואטסאפ. השיחות מגיעות לשיחות כאן, ואפשר לענות בהן בעצמכם.</p>${on && store !== 'live' ? `<p class="small mt8 m0">${store === 'paused' ? 'כל עוד תורן מושהה' : 'עד שמפעילים את תורן'}, מי שכותב בצ׳אט מקבל תשובה שההודעה הגיעה, והשיחה מחכה לכם.</p>` : ''}`;
  if (!on) {
    return `${head}${may ? `<div class="row mt12">${postButton(r.ctx, `/lead/${s.id}/web`, 'להפעיל צ׳אט באתר', { cls: 'btn sm', fields: { do: 'on' }, iconName: 'chat' })}</div>` : ''}</section>`;
  }
  const line = `<script src="${publicBase(app)}/w/${a!.external_id}.js" async></script>`;
  const domains = (a!.meta?.domains || []) as string[];
  const brand = await app.db.one<{ brand: any; brand_override: any }>('SELECT brand, brand_override FROM stores WHERE id = $1', [s.id]);
  const mine = PLATFORM_STEPS[String(s.platform || '')];
  const steps = (p: { steps: string[] }) => `<ol class="steps mt8">${p.steps.map((x) => `<li><span>${esc(x)}</span></li>`).join('')}</ol>`;
  const forDev = [
    `שלום, אפשר להוסיף לאתר של ${s.name} את הצ׳אט של תורן?`,
    'זו שורה אחת, בסוף כל עמוד (לפני </body>):',
    line,
    mine ? mine.dev : Object.values(PLATFORM_STEPS).map((p) => p.dev).join('\n'),
    'ואם רוצים להציג באתר ביקורות של לקוחות, מוסיפים <div data-toran-reviews></div> במקום שבו הן יופיעו. תודה',
  ].join('\n');
  const copy = `<code class="ltr" id="snippet-${s.id}" hidden>${esc(line)}</code><button class="btn sm" type="button" data-copy="#snippet-${s.id}" data-done="השורה הועתקה">${icon('copy')}להעתיק את השורה</button>`;
  const self = `<details class="mt12"><summary class="small">להוסיף בעצמי</summary>
    ${mine ? steps(mine) : Object.values(PLATFORM_STEPS).map((p) => `<p class="small mt8 m0"><b class="ltr">${p.name}</b></p>${steps(p)}`).join('')}
    <div class="row mt8">${copy}</div></details>`;
  const add = seen ? `${channelSwitch(r, s.id, 'web', (await offChannels(app, s.id)).includes('web'), store)}` : `<h3 class="q1 mt16">נשאר להוסיף את הצ׳אט לאתר</h3>
  <p class="small m0">את זה עושה בדרך כלל מי שמנהל לכם את האתר, בכמה דקות. שולחים לו הודעה מוכנה עם כל מה שצריך.</p>
  ${sendTo(forDev, `הצ׳אט של תורן באתר של ${s.name}`, 'לשלוח למי שמנהל לכם את האתר', main ? 'btn primary' : 'btn')}
  ${self}`;
  const more = may ? `<details class="more mt16"><summary>עוד אפשרויות</summary>
    <h3 class="small mt12">השורה של הצ׳אט</h3><div class="row mt8"><code class="snippet ltr">${esc(line)}</code></div>
    <p class="small muted mt8 m0">כדי להציג ביקורות של לקוחות באתר, מי שמנהל את האתר מוסיף בדף את <code class="ltr">&lt;div data-toran-reviews&gt;&lt;/div&gt;</code> במקום שבו הן יופיעו.</p>
    <form method="post" action="/lead/${s.id}/web" class="mt12">${csrfField(r.ctx)}<input type="hidden" name="do" value="domains">
    <label class="f">האתרים שבהם הצ׳אט מופיע<small>כתובת בכל שורה. הכתובת של החנות כבר כאן. באתר אחר הצ׳אט לא יופיע, גם אם מעתיקים את השורה.</small><textarea name="domains" rows="3" dir="ltr" maxlength="1000">${esc(domains.join('\n'))}</textarea></label>
    <div class="row mt8"><button class="btn sm" type="submit">לשמור</button></div></form>
    <div class="row mt12">${postButton(r.ctx, `/lead/${s.id}/web`, 'לכבות את הצ׳אט', { cls: 'btn sm ghost', fields: { do: 'off' }, confirm: 'לחצו שוב כדי לכבות', note: 'הכפתור ייעלם מהאתר מיד.' })}</div>
  </details>` : '';
  return `${head}
  ${add}
  ${lookCard(r, s.id, brand || { brand: null, brand_override: null }, a!.meta?.look || {}, may)}
  ${more}
</section>`;
}

const STARS = (n: number) => `${'★'.repeat(n)}${'☆'.repeat(5 - n)}`;
const PUBLISH_HE: Record<string, string> = { yes: 'הסכים להציג', no: 'ביקש לא להציג', unknown: 'לא ענה אם להציג' };

/** The reviews Toran collected for a store, newest first; nothing while there are none. */
export async function reviewsPanel(app: App, r: DashReq, s: { id: number; name: string }): Promise<string> {
  const rows = await reviewsOf(app, s.id);
  if (!rows.length) return '';
  const may = !r.ctx.readOnly && r.user.role !== 'client_member';
  const item = (x: (typeof rows)[number]) => {
    const state = x.status === 'approved' ? '<span class="chip ok">מוצגת באתר</span>' : x.status === 'hidden' ? '<span class="chip ghost">מוסתרת</span>' : x.publish === 'yes' ? '<span class="chip sig">מחכה לאישור שלכם</span>' : '';
    const acts = may ? `${x.publish === 'yes' && x.status !== 'approved' ? postButton(r.ctx, `/lead/${s.id}/reviews/${x.id}`, 'להציג באתר', { cls: 'btn sm', fields: { do: 'approve' } }) : ''}${x.status !== 'hidden' ? postButton(r.ctx, `/lead/${s.id}/reviews/${x.id}`, 'להסתיר', { cls: 'btn sm ghost', fields: { do: 'hide' } }) : ''}` : '';
    return `<li class="review"><div><b class="stars" aria-label="${x.rating} מתוך 5">${STARS(x.rating)}</b> <span class="small muted">${esc(x.name || 'לקוח')}${x.order_ref ? ` · ${esc(x.order_ref)}` : ''} · ${esc(stamp(x.created_at))} · ${esc(PUBLISH_HE[x.publish] || x.publish)}</span></div>
    ${x.text ? `<p class="m0 mt8" dir="auto">${esc(x.text)}</p>` : ''}<div class="row mt8">${state}${acts}${x.conversation_id ? `<a class="small" href="/chat/${Number(x.conversation_id)}">לשיחה</a>` : ''}</div></li>`;
  };
  return `<section class="panel" id="reviews"><header><h2>ביקורות שנאספו</h2><span class="end small muted">${rows.length}</span></header>
  <p class="small m0">לקוחות שענו לבקשה לביקורת עם ציון. ביקורת מופיעה באתר רק אם הלקוח הסכים, ורק אחרי שאתם מאשרים.</p>
  <ul class="reviews mt12">${rows.map(item).join('')}</ul></section>`;
}

export function webChatRoutes(app: App): Route<DashReq>[] {
  const owner = (r: DashReq) => {
    if (r.user.role === 'client_member') throw new ActionError('את זה משנה מי שפתח את החשבון.', 403);
  };
  return [
    ['POST', /^\/lead\/(\d+)\/web$/, async (r, m) => {
      owner(r);
      const id = Number(m[1]);
      const what = String(r.form.do || '');
      if (what === 'on') {
        await turnOn(app, id, r.user.name);
        return { redirect: '/settings#webchat', message: 'הצ׳אט פעיל. נשאר להוסיף אותו לאתר.' };
      }
      if (what === 'off') {
        await turnOff(app, id, r.user.name);
        return { redirect: '/settings#webchat', message: 'הצ׳אט כבוי, והכפתור ירד מהאתר.' };
      }
      if (what === 'domains') {
        const typed = String(r.form.domains || '').split(/[\s,]+/).filter(Boolean);
        const bad = typed.filter((d) => !siteOrigin(d));
        if (bad.length) throw new ActionError(`לא הצלחנו לקרוא את הכתובת ${bad[0]}. כותבים כתובת אחת בכל שורה, למשל shop.co.il.`);
        await turnOn(app, id, r.user.name, typed);
        return { redirect: '/settings#webchat', message: 'שמרנו. הצ׳אט יופיע רק באתרים שברשימה.' };
      }
      if (what === 'look') {
        const look = choiceOf(r.form);
        const done = await app.db.query("UPDATE channel_accounts SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb WHERE store_id = $1 AND channel = 'web' RETURNING id", [id, J({ look })]);
        if (!done.length) throw new ActionError('קודם מפעילים את הצ׳אט באתר.', 400);
        await audit(app.db, { actor: r.user.name, action: 'web_chat_look', storeId: id, detail: look });
        return { redirect: '/settings#webchat', message: 'נשמר. מעכשיו הצ׳אט באתר נראה ככה.' };
      }
      throw new ActionError('אין פעולה כזו', 404);
    }],
    // The preview on Settings: the chat in the look being tried, framed only by our own pages.
    ['GET', /^\/lead\/(\d+)\/web\/preview$/, async (r, m) => {
      const id = Number(m[1]);
      const s = await app.db.one<any>('SELECT name, domain, brand, brand_override, platform, agent_name FROM stores WHERE id = $1', [id]);
      if (!s) throw new ActionError('לא נמצא', 404);
      const brand = { ...(s.brand || {}), ...(s.brand_override || {}) };
      const icon = String(s.brand?.palette?.icon || '');
      const logo = /^https:\/\//.test(icon) ? icon : brand.logoIsMark && /^https:\/\//.test(String(brand.logo || '')) ? String(brand.logo) : null;
      const face = { name: displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain, logo, whatsapp: null, bot: botName(s) };
      const css = `/lead/${id}/web/look.css?${new URLSearchParams(choiceQuery(r.url.searchParams)).toString()}`;
      return { html: previewPage(face, css), headers: PREVIEW_HEADERS };
    }],
    ['GET', /^\/lead\/(\d+)\/web\/look\.css$/, async (r, m) => {
      const s = await app.db.one<any>('SELECT brand, brand_override FROM stores WHERE id = $1', [Number(m[1])]);
      return { text: lookCss(storeLook(s, choiceOf(choiceQuery(r.url.searchParams)))), type: 'text/css; charset=utf-8', headers: { 'cache-control': 'private, max-age=60' } };
    }],
    ['POST', /^\/lead\/(\d+)\/reviews\/(\d+)$/, async (r, m) => {
      owner(r);
      const what = r.form.do === 'approve' ? 'approve' : r.form.do === 'hide' ? 'hide' : null;
      if (!what) throw new ActionError('אין פעולה כזו', 404);
      if (!(await decide(app, Number(m[1]), Number(m[2]), what, r.user.name))) throw new ActionError(what === 'approve' ? 'אפשר להציג רק ביקורת שהלקוח הסכים להציג.' : 'אין ביקורת כזו', what === 'approve' ? 400 : 404);
      return { redirect: '/settings#reviews', message: what === 'approve' ? 'הביקורת מוצגת באתר.' : 'הביקורת הוסתרה.' };
    }],
  ];
}
