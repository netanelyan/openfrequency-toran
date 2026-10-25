import type { App } from '../../app.ts';
import { checkDomain, dropDomain, mailDomainOf, OwnDomainError, startDomain, type DomainRecord, type MailDomain } from '../../channels/mailDomain.ts';
import { enabledChannels } from '../../channels/config.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { csrfField, esc, icon, postButton, stamp } from '../ui.ts';

// The store's own address for its email, on the store's channels (customer.ts's Settings, the operator's lead page):
// the owner gives it, adds the DNS records shown, and presses "לבדוק עכשיו" (channels/mailDomain.ts does the rest).

const STATUS_HE: Record<string, [string, string]> = {
  verified: ['מאומת', 'ok'],
  pending: ['בבדיקה', 'warn'],
  not_started: ['עוד לא נבדק', 'ghost'],
  failed: ['האימות נכשל', 'bad'],
  temporary_failure: ['בעיה זמנית', 'warn'],
};
const chip = (status: string | null) => {
  const [he, cls] = STATUS_HE[status || 'not_started'] || [status || '', 'ghost'];
  return `<span class="chip ${cls}">${esc(he)}</span>`;
};

/** The records as a table: the full name (some DNS hosts want only the part before the domain), the value to copy. */
function records(list: DomainRecord[], domain: string) {
  if (!list.length) return '';
  const full = (n: string) => (!n || n === '@' ? domain : n.endsWith(domain) ? n : `${n}.${domain}`);
  return `<div class="scrollx mt8"><table class="table stack records"><thead><tr><th>סוג</th><th>שם</th><th>ערך</th><th>עדיפות</th><th>מצב</th></tr></thead><tbody>${list.map((x) => `<tr><td data-k="סוג">${esc(x.type)}</td><td data-k="שם"><code class="ltr">${esc(full(x.name))}</code></td><td data-k="ערך"><code class="ltr">${esc(x.value)}</code></td><td class="n" data-k="עדיפות">${x.priority ?? ''}</td><td data-k="מצב">${chip(x.status)}</td></tr>`).join('')}</tbody></table></div>`;
}

/** The part of the store's email panel about its own domain; empty while the store's email is not connected. */
export async function mailDomainPanel(app: App, r: DashReq, storeId: number, shared: string | null): Promise<string> {
  if (!shared || !app.mail?.domains) return '';
  const d = await mailDomainOf(app, storeId);
  const ro = Boolean(r.ctx.readOnly);
  if (!d) {
    return `<h3 class="small mt16">כתובת על הדומיין של החנות</h3>
<p class="small m0">היום תורן עונה מ־<bdi class="ltr">${esc(shared)}</bdi>. אפשר שיענה מכתובת של החנות, למשל <bdi class="ltr">support@yourstore.co.il</bdi>. מוסיפים כמה רשומות DNS אצל מי שמחזיק את הדומיין, ועד שהן מאומתות תורן ממשיך לענות מהכתובת של היום.</p>
${ro ? '' : `<form method="post" action="/lead/${storeId}/mail-domain" class="mt8">${csrfField(r.ctx)}<input type="hidden" name="on" value="1">
  <label class="f">הכתובת שממנה תורן יענה<small>המייל שמגיע לכתובת הזו צריך להמשיך לעבור ל־<bdi class="ltr">${esc(shared)}</bdi>, כמו היום, כדי שתשובות של לקוחות יגיעו לתורן.</small><input type="email" name="address" required maxlength="120" dir="ltr" placeholder="support@yourstore.co.il"></label>
  <label class="f mt8">תת דומיין לקבלת מייל, לא חובה<small>רוצים שמייל יגיע לתורן ישר, בלי העברה? כותבים שם לתת דומיין, למשל help, ומוסיפים לו רשומת MX. המייל הרגיל של החנות לא משתנה.</small><input type="text" name="receiving" maxlength="60" dir="ltr" placeholder="help"></label>
  <button class="btn sm mt12" type="submit">${icon('plus')}להוסיף את הדומיין</button></form>`}`;
  }
  return domainState(r, storeId, d, shared, ro);
}

function domainState(r: DashReq, storeId: number, d: MailDomain, shared: string, ro: boolean) {
  const from = `${d.local}@${d.domain}`;
  const on = d.status === 'verified';
  const inbox = d.receiving ? `${d.local}@${d.receiving}` : null;
  return `<h3 class="small mt16">כתובת על הדומיין של החנות ${chip(d.status)}</h3>
<p class="small m0">${on ? `תורן עונה מ־<bdi class="ltr">${esc(from)}</bdi>, ותשובות של לקוחות חוזרות לאותה כתובת.` : `כשהדומיין יאומת, תורן יענה מ־<bdi class="ltr">${esc(from)}</bdi>. עד אז הוא עונה מ־<bdi class="ltr">${esc(shared)}</bdi>.`}</p>
${on ? '' : `<p class="small mt8 m0">מוסיפים את הרשומות האלה בדיוק כמו שהן כתובות כאן, אצל מי שמחזיק את הדומיין <bdi class="ltr">${esc(d.domain)}</bdi> (בדרך כלל איפה שקניתם אותו). האימות לוקח בדרך כלל כמה דקות, ולפעמים עד יומיים. תורן בודק לבד כל עשר דקות.</p>`}
${on ? '' : records(d.records, d.domain)}
${d.receiving ? `<p class="small mt12 m0"><b>מייל ישר לתורן, ל־<bdi class="ltr">${esc(inbox!)}</bdi></b> ${chip(d.receiving_status)}</p>
${d.receiving_status === 'verified' ? '<p class="small m0">מייל שנשלח לתת הדומיין מגיע לתורן ישר, בלי העברה.</p>' : `<p class="small m0">רשומת MX אחת על <bdi class="ltr">${esc(d.receiving)}</bdi>. היא לא נוגעת במייל הרגיל של החנות.</p>${records(d.receiving_records, d.receiving)}`}` : ''}
${d.checked_at ? `<p class="small muted mt8 m0">נבדק לאחרונה ${esc(stamp(d.checked_at))}.</p>` : ''}
${ro ? '' : `<div class="row mt8">${on && (!d.receiving || d.receiving_status === 'verified') ? '' : postButton(r.ctx, `/lead/${storeId}/mail-domain/check`, 'לבדוק עכשיו', { cls: 'btn sm', iconName: 'refresh' })}${postButton(r.ctx, `/lead/${storeId}/mail-domain`, 'להפסיק עם הדומיין הזה', { cls: 'btn sm danger', fields: { on: '0' }, confirm: `להפסיק? תורן יחזור לענות מ־${shared}.` })}</div>`}`;
}

export function mailDomainRoutes(app: App): Route<DashReq>[] {
  const back = (r: DashReq, id: number) => (r.scope.operator ? `/lead/${id}#channels` : '/settings#channels');
  const ready = async (id: number) => {
    if (!enabledChannels(app.env).has('email') || !app.mail) throw new ActionError('המייל עוד כבוי בשרת (TORAN_CHANNELS).');
    const a = await app.db.one<{ external_id: string }>("SELECT external_id FROM channel_accounts WHERE store_id = $1 AND channel = 'email' AND status = 'active' ORDER BY id DESC LIMIT 1", [id]);
    if (!a) throw new ActionError('קודם מחברים את המייל של החנות, ואז את הדומיין.');
    return a.external_id;
  };
  return [
    ['POST', /^\/lead\/(\d+)\/mail-domain$/, async (r, m) => {
      const id = Number(m[1]);
      if (r.form.on !== '1') {
        await dropDomain(app, id, r.user.name);
        return { redirect: back(r, id), message: 'הדומיין הוסר. תורן עונה שוב מהכתובת אצלנו.' };
      }
      await ready(id);
      try {
        const d = await startDomain(app, id, String(r.form.address || ''), String(r.form.receiving || ''), r.user.name);
        return { redirect: back(r, id), message: `הדומיין ${d.domain} נוסף. עכשיו מוסיפים את הרשומות שמופיעות כאן, ולוחצים "לבדוק עכשיו".` };
      } catch (e) {
        if (e instanceof OwnDomainError) throw new ActionError(e.message);
        throw e;
      }
    }],
    ['POST', /^\/lead\/(\d+)\/mail-domain\/check$/, async (r, m) => {
      const id = Number(m[1]);
      const shared = await ready(id);
      let d: MailDomain | null;
      try {
        d = await checkDomain(app, id);
      } catch (e: any) {
        app.log(`[mail-domain] check store ${id}: ${String(e?.message || e)}`);
        throw new ActionError('לא הצלחנו לבדוק עכשיו. כדאי לנסות שוב בעוד כמה דקות.');
      }
      if (!d) throw new ActionError('אין דומיין לבדוק.');
      const msg = d.status === 'verified' ? `הדומיין מאומת. מעכשיו תורן עונה מ־${d.local}@${d.domain}.` : `עוד לא מאומת, אז תורן עונה בינתיים מ־${shared}. רשומות שהוספתם עכשיו יכולות לקחת קצת זמן.`;
      return { redirect: back(r, id), message: msg };
    }],
  ];
}
