import type { App } from '../../app.ts';
import { secretsReady } from '../../core/secrets.ts';
import { connectOrders, disconnectOrders, OrderConnectError, orderAccessOf, ordersPlatform, type AccessRow, type OrderPlatform } from '../../orders.ts';
import { dropSource } from '../../auto/platforms.ts';
import { audit } from '../../db/log.ts';
import { cleanTrackingPage, PAGE_MAX, TrackingPageError } from '../../tracking.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { csrfField, esc, icon, postButton, shortDate } from '../ui.ts';

// The store's orders, read-only (src/orders.ts): a panel on the store's knowledge page (pages/customer.ts) where the
// owner pastes a key that only reads orders, with where to get it on their platform, and POST /lead/<id>/orders to
// connect it (tried once before it is kept) or /lead/<id>/orders/off to forget it. The account's owner connects; a
// member sees whether it is connected. The key is never shown again, only its last four characters.

const PLATFORM = { shopify: 'Shopify', woocommerce: 'WooCommerce', wix: 'Wix' } as const;

export const STEPS: Record<OrderPlatform, string[]> = {
  // Since 2026-01-01 Shopify makes new apps only in its Dev Dashboard (shopify.dev/changelog/posts/legacy-custom-apps-
  // can-t-be-created-after-january-1-2026; shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard).
  shopify: [
    'נכנסים ל-Dev Dashboard של Shopify, ב-dev.shopify.com, עם החשבון שהחנות שייכת אליו. לוחצים Create app ואז Start from Dev Dashboard, ונותנים לאפליקציה שם, למשל תורן.',
    'בדף Versions יוצרים גרסה. ב-Scopes מסמנים רק את read_orders, ולוחצים Release.',
    'לוחצים Install app ומתקינים את האפליקציה על החנות.',
    'בהגדרות של האפליקציה (Settings) מעתיקים את ה-Client ID ואת ה-Client secret, ומדביקים אותם כאן.',
  ],
  woocommerce: [
    'בניהול של וורדפרס נכנסים ל-WooCommerce, להגדרות, ללשונית "מתקדם" ול-REST API.',
    'מוסיפים מפתח, ובהרשאות בוחרים "קריאה" (Read).',
    'מעתיקים את ה-Consumer key ואת ה-Consumer secret. וורדפרס מראה אותם פעם אחת בלבד.',
  ],
  wix: [
    'בחשבון של Wix נכנסים ל-API Keys (בכתובת manage.wix.com/account/api-keys) ויוצרים מפתח.',
    'בוחרים את האתר של החנות, ובהרשאות מסמנים קריאה של הזמנות (Read Orders).',
    'מעתיקים את המפתח. את מזהה האתר (Site ID) רואים בכתובת של הדשבורד, אחרי /dashboard/.',
  ],
};

const field = (name: string, label: string, { hint = '', placeholder = '', required = true }: { hint?: string; placeholder?: string; required?: boolean } = {}) =>
  `<label class="f mt8">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}<input type="text" name="${name}" dir="ltr" autocomplete="off" spellcheck="false" maxlength="400"${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}${required ? ' required' : ''}></label>`;

export const FIELDS: Record<OrderPlatform, string> = {
  shopify: field('client_id', 'Client ID') + field('client_secret', 'Client secret') + field('shop', 'הכתובת של החנות ב-myshopify', { hint: 'אפשר להשאיר ריק, ותורן ימצא אותה לבד', placeholder: 'my-store.myshopify.com', required: false }),
  woocommerce: field('key', 'Consumer key', { placeholder: 'ck_...' }) + field('secret', 'Consumer secret', { placeholder: 'cs_...' }),
  wix: field('api_key', 'מפתח ה-API') + field('site_id', 'מזהה האתר (Site ID)', { placeholder: '00000000-0000-0000-0000-000000000000' }),
};

/**
 * A store that made a custom app in its admin before 2026 still has its token (shpat_), and Shopify keeps it working:
 * folded under the Dev Dashboard steps, for the few who have one.
 */
const oldShopifyApp = (r: DashReq, id: number) => `<details class="mt12"><summary class="small">יש לכם כבר אפליקציה מלפני 2026, עם טוקן שמתחיל ב-shpat_?</summary>
<ol class="m0 mt8"><li>בניהול של Shopify נכנסים להגדרות, ל"אפליקציות וערוצי מכירה" ול"פיתוח אפליקציות", ופותחים את האפליקציה.</li><li>מוודאים שבהרשאות של Admin API מסומן read_orders, ומעתיקים את ה-Admin API access token.</li></ol>
<form method="post" action="/lead/${id}/orders" class="mt8">${csrfField(r.ctx)}${field('token', 'Admin API access token', { placeholder: 'shpat_...' })}${field('shop', 'הכתובת של החנות ב-myshopify', { hint: 'אפשר להשאיר ריק, ותורן ימצא אותה לבד', placeholder: 'my-store.myshopify.com', required: false })}<button class="btn sm mt12" type="submit">${icon('check')}לחבר עם הטוקן</button></form></details>`;

/**
 * The store's own tracking page (src/tracking.ts; the owner, 2026-11-09: "or the website's own tracking"), folded under
 * the connected orders: Toran gives it instead of the carrier's link, with {number} and {order} filled in. Shown once
 * the orders are connected, since only then does Toran tell a shipment; the account's owner sets it, a member sees it.
 */
async function trackingPageBox(app: App, r: DashReq, id: number, may: boolean): Promise<string> {
  const page = (await app.db.one<{ tracking_page: string | null }>('SELECT tracking_page FROM stores WHERE id = $1', [id]))?.tracking_page || '';
  if (!may) return page ? `<p class="small muted mt12 m0">דף המעקב שתורן שולח: <bdi class="ltr">${esc(page)}</bdi></p>` : '';
  return `<details class="mt12" id="tracking-page"${page ? ' open' : ''}><summary class="small">יש לכם באתר דף למעקב אחרי משלוח?</summary>
<p class="small muted mt8 m0">מדביקים כאן את הכתובת שלו, ותורן ישלח ללקוח אותה במקום הלינק של חברת המשלוחים. אם הדף צריך את מספר המעקב, כותבים במקומו {number}. את מספר ההזמנה כותבים {order}.</p>
<form method="post" action="/lead/${id}/tracking-page" class="mt8">${csrfField(r.ctx)}<label class="f">הכתובת של דף המעקב<small>למשל https://my-store.co.il/track?n={number}. משאירים ריק, ותורן ישלח את הלינק שבהזמנה.</small><input type="url" name="tracking_page" value="${esc(page)}" dir="ltr" autocomplete="off" spellcheck="false" maxlength="${PAGE_MAX}" placeholder="https://"></label><button class="btn sm mt12" type="submit">לשמור</button></form></details>`;
}

/** Whether this store's orders are connected and working: what the knowledge page's lists say Toran answers. */
export const ordersOn = (a: AccessRow | null) => a?.status === 'active';

export async function ordersPanel(app: App, r: DashReq, s: { id: number; platform: string }, writeUs: string): Promise<string> {
  if (!ordersPlatform(s.platform)) return '';
  const a = await orderAccessOf(app.db, s.id);
  const may = !r.ctx.readOnly && r.user.role !== 'client_member';
  const name = PLATFORM[s.platform];
  const head = `<section class="panel" id="orders"><header><h2>שאלות על הזמנות</h2>${a ? `<span class="end chip ${ordersOn(a) ? 'ok' : 'warn'}">${ordersOn(a) ? 'מחובר' : 'המפתח לא עובד'}</span>` : ''}</header>`;
  if (a && ordersOn(a)) {
    return `${head}<p class="m0">מחובר ל-${name} מ-${esc(shortDate(a.connected_at))}${a.meta?.hint ? `, עם המפתח שנגמר ב-<bdi class="ltr">${esc(a.meta.hint)}</bdi>` : ''}. כשלקוח שואל איפה ההזמנה שלו, תורן מבקש את מספר ההזמנה, בודק ועונה לבד: מה הסטטוס, אם היא נשלחה, ולינק למעקב אם יש. מי שלא כותב מהטלפון שההזמנה נעשתה ממנו מתבקש קודם את המספר הזה. כל השאר מגיע אליכם.</p>
  ${await trackingPageBox(app, r, s.id, may)}
  ${may ? `<div class="row mt12">${postButton(r.ctx, `/lead/${s.id}/orders/off`, 'לנתק', { cls: 'btn sm danger', confirm: 'לנתק? שאלות על הזמנות יגיעו שוב אליכם. כדאי למחוק את המפתח גם ב-' + name + '.' })}</div>` : ''}</section>`;
  }
  const broken = a ? `<div class="banner warn">${icon('alert')}<div><p>${name} הפסיק לקבל את המפתח, אז שאלות על הזמנות מגיעות שוב אליכם. אפשר להדביק כאן מפתח חדש.</p></div></div>` : '';
  const intro = `<p class="m0">כשלקוח שואל איפה ההזמנה שלו, תורן יכול לבדוק ב-${name} ולענות לבד: מה הסטטוס, אם היא נשלחה, ולינק למעקב אם יש. בשביל זה צריך מפתח שרק קורא הזמנות. תורן עונה על הזמנה רק למי שכותב מהטלפון שההזמנה נעשתה ממנו, או נותן את המספר הזה, ככה לקוח אחד לא רואה הזמנה של מישהו אחר.</p>`;
  if (!secretsReady(app.env)) return `${head}${intro}<p class="small muted mt12 m0">החיבור להזמנות עוד לא פתוח בשרת. כתבו לנו ונחבר יחד.</p>${writeUs ? `<div class="row mt8">${writeUs}</div>` : ''}</section>`;
  if (!may) return `${head}${broken}${intro}<p class="small muted mt12 m0">את המפתח מחבר מי שפתח את החשבון.</p></section>`;
  return `${head}${broken}${intro}
  <h3 class="small mt16">איפה מוצאים את המפתח</h3><ol class="m0">${STEPS[s.platform].map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
  <form method="post" action="/lead/${s.id}/orders" class="mt8">${csrfField(r.ctx)}${FIELDS[s.platform]}<button class="btn sm primary mt12" type="submit">${icon('check')}לחבר</button></form>
  ${s.platform === 'shopify' ? oldShopifyApp(r, s.id) : ''}
  <p class="small muted mt8 m0">לפני ששומרים, תורן בודק שהמפתח עובד. אנחנו שומרים אותו מוצפן, ותורן רק קורא איתו. כשמנתקים, הוא נמחק אצלנו.</p></section>`;
}

export function ordersRoutes(app: App): Route<DashReq>[] {
  const owner = (r: DashReq) => {
    if (r.user.role === 'client_member') throw new ActionError('את המפתח מחבר מי שפתח את החשבון.', 403);
  };
  return [
    ['POST', /^\/lead\/(\d+)\/orders$/, async (r, m) => {
      owner(r);
      const id = Number(m[1]);
      try {
        await connectOrders(app, id, r.form, r.user.name);
      } catch (e) {
        if (e instanceof OrderConnectError) {
          app.log(`[orders] store ${id}: ${e.message}`);
          throw new ActionError(e.he);
        }
        throw e;
      }
      return { redirect: `/lead/${id}/knowledge#orders`, message: 'ההזמנות מחוברות. מעכשיו תורן עונה לבד על שאלות כמו "איפה ההזמנה שלי".' };
    }],
    // The store's own tracking page: an https address, or empty to go back to the order's link. The server already
    // checked the store is this workspace's.
    ['POST', /^\/lead\/(\d+)\/tracking-page$/, async (r, m) => {
      owner(r);
      const id = Number(m[1]);
      let page: string | null;
      try {
        page = cleanTrackingPage(String(r.form.tracking_page || ''));
      } catch (e) {
        if (e instanceof TrackingPageError) throw new ActionError(e.he);
        throw e;
      }
      await app.db.query('UPDATE stores SET tracking_page = $2, updated_at = now() WHERE id = $1', [id, page]);
      await audit(app.db, { actor: r.user.name, action: 'tracking_page', storeId: id, detail: { page } });
      return { redirect: `/lead/${id}/knowledge#orders`, message: page ? 'מעכשיו תורן שולח ללקוחות את דף המעקב שלכם.' : 'דף המעקב נמחק. תורן ישלח את הלינק שבהזמנה.' };
    }],
    ['POST', /^\/lead\/(\d+)\/orders\/off$/, async (r, m) => {
      owner(r);
      const id = Number(m[1]);
      // The automatic messages read the store with the same key: their webhooks go first, while the key still works.
      await dropSource(app, id).catch((e) => app.log(`[auto] store ${id}: the source was not dropped cleanly: ${e?.message || e}`));
      await disconnectOrders(app, id, r.user.name);
      return { redirect: `/lead/${id}/knowledge#orders`, message: 'ההזמנות נותקו, והמפתח נמחק אצלנו.' };
    }],
  ];
}
