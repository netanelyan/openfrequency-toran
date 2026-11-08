import type { App } from '../../app.ts';
import { siteOrigin, turnOff, turnOn, webAccountOf } from '../../channels/web.ts';
import { decide, reviewsOf } from '../../reviews.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { csrfField, esc, icon, postButton, stamp } from '../ui.ts';

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

const publicBase = (app: App) => String(app.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || `http://localhost:${app.env.PORT || 4710}`;

const PLATFORM_STEPS: [string, string][] = [
  ['Shopify', 'בניהול החנות: Online Store, ואז Themes, בשלוש הנקודות ליד התבנית Edit code. בקובץ theme.liquid מדביקים את השורה ממש לפני </body>, ושומרים.'],
  ['WooCommerce', 'מתקינים את התוסף WPCode. אחר כך Code Snippets, ואז Header & Footer, מדביקים את השורה בתיבה Footer, ושומרים.'],
  ['Wix', 'בהגדרות האתר: Custom Code, ואז Add Custom Code. מדביקים את השורה, בוחרים All pages ו-Body - end, ומאשרים.'],
];

/** The chat panel on a store's Settings. */
export async function webChatPanel(app: App, r: DashReq, s: { id: number; name: string }): Promise<string> {
  const may = !r.ctx.readOnly && r.user.role !== 'client_member';
  const a = await webAccountOf(app, s.id);
  const on = a?.status === 'active';
  const head = `<section class="panel" id="webchat"><header><h2>צ׳אט באתר</h2><span class="end chip ${on ? 'ok' : 'ghost'}">${on ? 'פעיל' : 'כבוי'}</span></header>
  <p class="m0">כפתור צ׳אט בפינה של האתר של ${esc(s.name)}: הלקוחות שואלים בלי לצאת מהדף, ותורן עונה כמו בוואטסאפ. השיחות מגיעות לתיבה, ואפשר לענות בהן בעצמכם.</p>`;
  if (!on) {
    return `${head}${may ? `<div class="row mt12">${postButton(r.ctx, `/lead/${s.id}/web`, 'להפעיל צ׳אט באתר', { cls: 'btn primary sm', fields: { do: 'on' }, iconName: 'chat' })}</div>` : ''}</section>`;
  }
  const line = `<script src="${publicBase(app)}/w/${a!.external_id}.js" async></script>`;
  const domains = (a!.meta?.domains || []) as string[];
  return `${head}
  <h3 class="small mt16">השורה שמוסיפים לאתר</h3>
  <div class="row mt8"><code class="snippet ltr" id="snippet-${s.id}">${esc(line)}</code><button class="btn sm" type="button" data-copy="#snippet-${s.id}" data-done="השורה הועתקה">${icon('copy')}להעתיק</button></div>
  <details class="mt12"><summary class="small">איפה מדביקים אותה</summary><ul class="keys mt8">${PLATFORM_STEPS.map(([p, t]) => `<li><b class="ltr">${p}</b><span>${esc(t)}</span></li>`).join('')}</ul></details>
  <p class="small muted mt8 m0">הצ׳אט מופיע רק באתרים שברשימה למטה, גם אם מישהו מעתיק את השורה. כדי להציג ביקורות של לקוחות באתר, מוסיפים בדף את <code class="ltr">&lt;div data-toran-reviews&gt;&lt;/div&gt;</code> במקום שבו הן יופיעו.</p>
  ${may ? `<form method="post" action="/lead/${s.id}/web" class="mt12">${csrfField(r.ctx)}<input type="hidden" name="do" value="domains">
    <label class="f">האתרים שבהם הצ׳אט מופיע<small>כתובת בכל שורה. הכתובת של החנות כבר כאן.</small><textarea name="domains" rows="3" dir="ltr" maxlength="1000">${esc(domains.join('\n'))}</textarea></label>
    <div class="row mt8"><button class="btn sm" type="submit">לשמור</button></div></form>
  <div class="row mt12">${postButton(r.ctx, `/lead/${s.id}/web`, 'לכבות את הצ׳אט', { cls: 'btn sm ghost', fields: { do: 'off' }, confirm: 'לכבות? הכפתור ייעלם מהאתר מיד.' })}</div>` : ''}
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
        return { redirect: '/settings#webchat', message: 'הצ׳אט פעיל. נשאר להוסיף לאתר את השורה שכאן.' };
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
        return { redirect: '/settings#webchat', message: 'נשמר.' };
      }
      throw new ActionError('אין פעולה כזו', 404);
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
