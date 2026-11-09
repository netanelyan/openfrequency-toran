import type { App } from '../../app.ts';
import { checkDomain, dropDomain, mailDomainOf, OwnDomainError, startDomain, type DomainRecord, type MailDomain } from '../../channels/mailDomain.ts';
import { enabledChannels } from '../../channels/config.ts';
import { displayName } from '../../ingest/brand.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { csrfField, esc, icon, postButton, sendTo, stamp } from '../ui.ts';

// The store's own address for its email (channels/mailDomain.ts), under the email card's "עוד אפשרויות" (pages/
// mailSetup.ts) and on the operator's lead page. The owner, 2026-11-09, on the card as it was ("כתובת על הדומיין של
// החנות ... מוסיפים כמה רשומות DNS ...", "תת דומיין לקבלת מייל, לא חובה ... רשומת MX"): "i dont understand anything,
// and i am the owner. make everything easy for the user. he also doesnt know anything about tech". The owner writes
// the address once; the technical part is for whoever runs their site, so the card's main button sends that person a
// ready message with every record to add, word for word, and the records themselves fold under it. The visible words
// are plain; DNS, MX, TXT and subdomain are only inside the message and the fold meant for that person.

const STATUS_HE: Record<string, [string, string]> = {
  verified: ['מחובר', 'ok'],
  pending: ['מחכה למי שמנהל את האתר', 'warn'],
  not_started: ['מחכה למי שמנהל את האתר', 'ghost'],
  failed: ['עוד לא עובד', 'bad'],
  temporary_failure: ['בעיה זמנית', 'warn'],
};
const chip = (status: string | null) => {
  const [he, cls] = STATUS_HE[status || 'not_started'] || [status || '', 'ghost'];
  return `<span class="chip ${cls}">${esc(he)}</span>`;
};

/** A record's full name (some DNS hosts want only the part before the domain). */
const fullName = (n: string, domain: string) => (!n || n === '@' ? domain : n.endsWith(domain) ? n : `${n}.${domain}`);

/** The records as a table, for the person who adds them (folded on the card). */
function records(list: DomainRecord[], domain: string) {
  if (!list.length) return '';
  return `<div class="scrollx mt8"><table class="table stack records"><thead><tr><th>סוג</th><th>שם</th><th>ערך</th><th>עדיפות</th><th>מצב</th></tr></thead><tbody>${list.map((x) => `<tr><td data-k="סוג">${esc(x.type)}</td><td data-k="שם"><code class="ltr">${esc(fullName(x.name, domain))}</code></td><td data-k="ערך"><code class="ltr">${esc(x.value)}</code></td><td class="n" data-k="עדיפות">${x.priority ?? ''}</td><td data-k="מצב">${chip(x.status)}</td></tr>`).join('')}</tbody></table></div>`;
}

/** The message for whoever runs the store's site: exactly what to add, and where mail must keep going. */
export function developerMessage(store: string, d: MailDomain, shared: string): string {
  const line = (x: DomainRecord, domain: string) => `${x.type}  ${fullName(x.name, domain)}  ${x.value}${x.priority != null ? `  (priority ${x.priority})` : ''}`;
  const sending = d.records.filter((x) => x.status !== 'verified');
  const receiving = d.receiving && d.receiving_status !== 'verified' ? d.receiving_records.filter((x) => x.status !== 'verified') : [];
  return [
    `שלום, אפשר עזרה עם הדומיין ${d.domain}?`,
    `החנות ${store} עונה ללקוחות במייל דרך תורן, ואנחנו רוצים שהתשובות ייצאו מ-${d.local}@${d.domain}.`,
    `צריך להוסיף ב-DNS של ${d.domain} את הרשומות האלה, בדיוק כמו שהן:`,
    ...(sending.length ? sending : d.records).map((x) => line(x, d.domain)),
    ...(receiving.length ? ['', `ובשביל קבלה ישירה, על ${d.receiving}:`, ...receiving.map((x) => line(x, d.receiving!))] : []),
    '',
    `חשוב: מייל שמגיע ל-${d.local}@${d.domain} צריך להמשיך לעבור (Forwarding) ל-${shared}, כמו היום.`,
    'כשסיימת, תכתוב לי ואלחץ "לבדוק עכשיו". תודה',
  ].join('\n');
}

/** The part of the store's email card about its own address; empty while the store's email is not connected. */
export async function mailDomainPanel(app: App, r: DashReq, storeId: number, shared: string | null): Promise<string> {
  if (!shared || !app.mail?.domains) return '';
  const d = await mailDomainOf(app, storeId);
  const ro = Boolean(r.ctx.readOnly);
  if (!d) {
    return `<p class="small m0">היום התשובות יוצאות מהכתובת של תורן. אפשר שייצאו מכתובת של החנות, למשל <bdi class="ltr">support@yourstore.co.il</bdi>. כותבים אותה כאן, ותורן מכין הודעה מוכנה למי שמנהל לכם את האתר.</p>
${ro ? '' : `<form method="post" action="/lead/${storeId}/mail-domain" class="mt8">${csrfField(r.ctx)}<input type="hidden" name="on" value="1">
  <label class="f">מאיזו כתובת לענות?<input type="email" name="address" required maxlength="120" dir="ltr" placeholder="support@yourstore.co.il"></label>
  <details class="mt8"><summary class="small">הגדרה נוספת, למי שמנהל לכם את האתר</summary><label class="f mt8">תת דומיין לקבלת מייל ישר לתורן, לא חובה<small>למשל help. צריך בשבילו רשומת MX. המייל הרגיל של החנות לא משתנה.</small><input type="text" name="receiving" maxlength="60" dir="ltr" placeholder="help"></label></details>
  <button class="btn sm mt12" type="submit">${icon('chev')}להמשיך</button></form>`}`;
  }
  const s = await app.db.one<any>('SELECT name, domain, brand, brand_override FROM stores WHERE id = $1', [storeId]);
  return domainState(r, storeId, d, shared, ro, displayName(s?.brand_override?.name, s?.brand?.name, s?.name) || s?.domain || '');
}

function domainState(r: DashReq, storeId: number, d: MailDomain, shared: string, ro: boolean, store: string) {
  const from = `${d.local}@${d.domain}`;
  const on = d.status === 'verified';
  const inboxOn = !d.receiving || d.receiving_status === 'verified';
  const inbox = d.receiving ? `${d.local}@${d.receiving}` : null;
  // Waiting is said by the line under it; only a check that failed gets its own word.
  const now = on ? d.receiving_status : d.status;
  const status = on && inboxOn ? '' : ['failed', 'temporary_failure'].includes(String(now)) ? ` ${chip(now)}` : '';
  return `<p class="small m0">${on ? `התשובות יוצאות מ־<bdi class="ltr">${esc(from)}</bdi>, ותשובות של לקוחות חוזרות לאותה כתובת.` : `כשזה יהיה מוכן, התשובות ייצאו מ־<bdi class="ltr">${esc(from)}</bdi>. עד אז הן יוצאות מהכתובת של תורן.`}${status}</p>
${on && inboxOn ? '' : `<p class="small mt12 m0">את זה מסדר מי שמנהל לכם את האתר. שולחים לו את ההודעה, וכשהוא מסיים לוחצים "לבדוק עכשיו". לפעמים זה לוקח עד יומיים, ותורן גם בודק לבד כל עשר דקות.</p>
${sendTo(developerMessage(store, d, shared), `תשובות ממייל של ${store}`, 'לשלוח למי שמנהל לכם את האתר', 'btn primary sm')}
<details class="mt12"><summary class="small">מה צריך להוסיף (בשביל מי שמנהל לכם את האתר)</summary>${on ? '' : `<p class="small mt8 m0">ב-DNS של <bdi class="ltr">${esc(d.domain)}</bdi>:</p>${records(d.records, d.domain)}`}${d.receiving && !inboxOn ? `<p class="small mt8 m0">בשביל מייל ישר ל־<bdi class="ltr">${esc(inbox!)}</bdi>, רשומת MX על <bdi class="ltr">${esc(d.receiving)}</bdi>. היא לא נוגעת במייל הרגיל של החנות.</p>${records(d.receiving_records, d.receiving)}` : ''}</details>`}
${d.receiving && inboxOn && on ? `<p class="small mt8 m0">מייל ל־<bdi class="ltr">${esc(inbox!)}</bdi> מגיע לתורן ישר, בלי העברה.</p>` : ''}
${d.checked_at && !(on && inboxOn) ? `<p class="small muted mt8 m0">נבדק לאחרונה ${esc(stamp(d.checked_at))}.</p>` : ''}
${ro ? '' : `<div class="row mt12">${on && inboxOn ? '' : postButton(r.ctx, `/lead/${storeId}/mail-domain/check`, 'לבדוק עכשיו', { cls: 'btn sm', iconName: 'refresh' })}${postButton(r.ctx, `/lead/${storeId}/mail-domain`, 'לחזור לכתובת של תורן', { cls: 'btn sm ghost', fields: { on: '0' }, confirm: `לחזור? תורן יענה שוב מ־${shared}.` })}</div>`}`;
}

export function mailDomainRoutes(app: App): Route<DashReq>[] {
  const back = (r: DashReq, id: number) => (r.scope.operator ? `/lead/${id}#channels` : '/settings#email');
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
        return { redirect: back(r, id), message: 'מעכשיו תורן עונה שוב מהכתובת שלו.' };
      }
      await ready(id);
      try {
        await startDomain(app, id, String(r.form.address || ''), String(r.form.receiving || ''), r.user.name);
        return { redirect: back(r, id), message: 'שמרנו. עכשיו שולחים את ההודעה למי שמנהל לכם את האתר.' };
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
      if (!d) throw new ActionError('אין כתובת לבדוק.');
      const msg = d.status === 'verified' ? `זה עובד. מעכשיו תורן עונה מ־${d.local}@${d.domain}.` : `עוד לא מוכן, אז תורן עונה בינתיים מ־${shared}. אם מי שמנהל לכם את האתר סיים עכשיו, זה יכול לקחת קצת זמן.`;
      return { redirect: back(r, id), message: msg };
    }],
  ];
}
