import type { App } from '../../app.ts';
import { secretsReady } from '../../core/secrets.ts';
import { connectOrders, disconnectOrders, OrderConnectError, orderAccessOf, ordersPlatform, type AccessRow, type OrderPlatform } from '../../orders.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { csrfField, esc, icon, postButton, shortDate } from '../ui.ts';

// The store's orders, read-only (src/orders.ts): a panel on the store's knowledge page (pages/customer.ts) where the
// owner pastes a key that only reads orders, with where to get it on their platform, and POST /lead/<id>/orders to
// connect it (tried once before it is kept) or /lead/<id>/orders/off to forget it. The account's owner connects; a
// member sees whether it is connected. The key is never shown again, only its last four characters.

const PLATFORM = { shopify: 'Shopify', woocommerce: 'WooCommerce', wix: 'Wix' } as const;

const STEPS: Record<OrderPlatform, string[]> = {
  shopify: [
    'בניהול של Shopify נכנסים להגדרות, ל"אפליקציות וערוצי מכירה" ול"פיתוח אפליקציות".',
    'יוצרים אפליקציה, ובהרשאות של Admin API מסמנים רק את read_orders.',
    'מתקינים את האפליקציה ומעתיקים את ה-Admin API access token. הוא מתחיל ב-shpat_, ו-Shopify מראה אותו פעם אחת בלבד.',
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

const FIELDS: Record<OrderPlatform, string> = {
  shopify: field('token', 'Admin API access token', { placeholder: 'shpat_...' }) + field('shop', 'הכתובת של החנות ב-myshopify', { hint: 'אפשר להשאיר ריק, ותורן ימצא אותה לבד', placeholder: 'my-store.myshopify.com', required: false }),
  woocommerce: field('key', 'Consumer key', { placeholder: 'ck_...' }) + field('secret', 'Consumer secret', { placeholder: 'cs_...' }),
  wix: field('api_key', 'מפתח ה-API') + field('site_id', 'מזהה האתר (Site ID)', { placeholder: '00000000-0000-0000-0000-000000000000' }),
};

/** Whether this store's orders are connected and working: what the knowledge page's lists say Toran answers. */
export const ordersOn = (a: AccessRow | null) => a?.status === 'active';

export async function ordersPanel(app: App, r: DashReq, s: { id: number; platform: string }, writeUs: string): Promise<string> {
  if (!ordersPlatform(s.platform)) return '';
  const a = await orderAccessOf(app.db, s.id);
  const may = !r.ctx.readOnly && r.user.role !== 'client_member';
  const name = PLATFORM[s.platform];
  const head = `<section class="panel" id="orders"><header><h2>שאלות על הזמנות</h2>${a ? `<span class="end chip ${ordersOn(a) ? 'ok' : 'warn'}">${ordersOn(a) ? 'מחובר' : 'המפתח לא עובד'}</span>` : ''}</header>`;
  if (a && ordersOn(a)) {
    return `${head}<p class="m0">מחובר ל-${name} מ-${esc(shortDate(a.connected_at))}${a.meta?.hint ? `, עם המפתח שנגמר ב-<bdi class="ltr">${esc(a.meta.hint)}</bdi>` : ''}. כשלקוח שואל איפה ההזמנה שלו ונותן את המייל או הטלפון שבה, תורן בודק ועונה לבד: מה הסטטוס, אם היא נשלחה, ולינק למעקב אם יש. כל השאר מגיע אליכם.</p>
  ${may ? `<div class="row mt12">${postButton(r.ctx, `/lead/${s.id}/orders/off`, 'לנתק', { cls: 'btn sm danger', confirm: 'לנתק? שאלות על הזמנות יגיעו שוב אליכם. כדאי למחוק את המפתח גם ב-' + name + '.' })}</div>` : ''}</section>`;
  }
  const broken = a ? `<div class="banner warn">${icon('alert')}<div><p>${name} הפסיק לקבל את המפתח, אז שאלות על הזמנות מגיעות שוב אליכם. אפשר להדביק כאן מפתח חדש.</p></div></div>` : '';
  const intro = `<p class="m0">כשלקוח שואל איפה ההזמנה שלו, תורן יכול לבדוק ב-${name} ולענות לבד: מה הסטטוס, אם היא נשלחה, ולינק למעקב אם יש. בשביל זה צריך מפתח שרק קורא הזמנות. תורן עונה על הזמנה רק למי שנותן גם את המייל או הטלפון שבה, ככה לקוח אחד לא רואה הזמנה של מישהו אחר.</p>`;
  if (!secretsReady(app.env)) return `${head}${intro}<p class="small muted mt12 m0">החיבור להזמנות עוד לא פתוח בשרת. כתבו לנו ונחבר יחד.</p>${writeUs ? `<div class="row mt8">${writeUs}</div>` : ''}</section>`;
  if (!may) return `${head}${broken}${intro}<p class="small muted mt12 m0">את המפתח מחבר מי שפתח את החשבון.</p></section>`;
  return `${head}${broken}${intro}
  <h3 class="small mt16">איפה מוצאים את המפתח</h3><ol class="m0">${STEPS[s.platform].map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
  <form method="post" action="/lead/${s.id}/orders" class="mt8">${csrfField(r.ctx)}${FIELDS[s.platform]}<button class="btn sm primary mt12" type="submit">${icon('check')}לחבר</button></form>
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
    ['POST', /^\/lead\/(\d+)\/orders\/off$/, async (r, m) => {
      owner(r);
      const id = Number(m[1]);
      await disconnectOrders(app, id, r.user.name);
      return { redirect: `/lead/${id}/knowledge#orders`, message: 'ההזמנות נותקו, והמפתח נמחק אצלנו.' };
    }],
  ];
}
