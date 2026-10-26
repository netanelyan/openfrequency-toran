import type { App } from '../../app.ts';
import { displayName } from '../../ingest/brand.ts';
import { orderAccessOf, ordersPlatform } from '../../orders.ts';
import { emailText, isKind, KIND_KEYS, KINDS, LEGACY, MESSAGES, publicBase, SAMPLE, SETTINGS_BUTTON, waText, type Kind, type MessageKey } from '../../auto/messages.ts';
import { setupSource, sourceOf, type Source } from '../../auto/platforms.ts';
import { AutoError, saveSetting, settingsOf, storeEmail, type Setting } from '../../auto/send.ts';
import { approvedFor, storeWa, submitTemplates, templatesOf, type TemplateRow } from '../../auto/templates.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { csrfField, esc, icon, postButton, stamp } from '../ui.ts';

// The store's automatic messages in Settings (src/auto/, docs/customer.md): one panel a store, under its channels.
// Where the store's events come from and what its key allows, said plainly; the store's WhatsApp templates and where
// each stands at Meta, with the button that submits them; and the four kinds, each off until the account's owner turns
// it on, with the channels, the delay or the review link, and the exact text each message goes out with. The latest
// messages, sent or not, with why. A member sees all of it and changes none of it.

const PLATFORM = { shopify: 'Shopify', woocommerce: 'WooCommerce', wix: 'Wix' } as const;

const T_STATE: Record<string, [string, string]> = {
  APPROVED: ['ok', 'אושרה'],
  PENDING: ['sig', 'מחכה לאישור של Meta'],
  IN_APPEAL: ['sig', 'בערעור אצל Meta'],
  REJECTED: ['bad', 'Meta דחתה אותה'],
  PAUSED: ['warn', 'Meta השהתה אותה'],
  DISABLED: ['bad', 'Meta כיבתה אותה'],
  error: ['bad', 'לא נשלחה'],
};

/** Why a message did not go out, in the owner's words. */
export function whyHe(why: string | null): string {
  const w = String(why || '');
  const map: [RegExp, string][] = [
    [/^ordered$/, 'הלקוח הזמין'],
    [/^replied$/, 'הלקוח כתב לחנות בינתיים'],
    [/^off$/, 'ההודעה כבויה'],
    [/^late$/, 'עבר יותר מדי זמן'],
    [/^duplicate$/, 'כבר נשלחה ללקוח הזה'],
    [/^recent$/, 'הלקוח כבר קיבל הודעה כזו היום'],
    [/^opted_out$|opted out/, 'הלקוח ביקש להסיר'],
    [/^paid$/, 'התשלום עבר בינתיים'],
    [/^delivered$/, 'ההזמנה כבר נמסרה'],
    [/no consent/, 'הלקוח לא הסכים לקבל הודעות שיווקיות, או ביקש להפסיק'],
    [/no phone/, 'אין טלפון בהזמנה'],
    [/no address/, 'אין מייל בהזמנה'],
    [/template not approved/, 'התבנית בוואטסאפ עוד לא אושרה'],
    [/no link/, 'אין לינק לשלוח'],
    [/suppressed/, 'מיילים לכתובת הזו חוזרים'],
    [/not connected/, 'הערוץ לא מחובר'],
  ];
  return map.find(([re]) => re.test(w))?.[1] || 'שגיאה בשליחה';
}

/** How the store's events reach Toran, and what its key cannot do, plainly. */
function sourceLines(platform: keyof typeof PLATFORM, s: Source | null): string[] {
  const name = PLATFORM[platform];
  if (!s) return ['כשתפעילו הודעה ראשונה, תורן יתחבר להזמנות של החנות עם המפתח שכבר חיברתם.'];
  const out: string[] = [];
  const w = String(s.can?.why?.webhooks || '');
  if (s.can?.webhooks) out.push(`${name} מעדכן את תורן ברגע שמשהו קורה בחנות, ותורן גם בודק כל שעה שלא פספס כלום.${w.startsWith('missing') ? ` חלק מהעדכונים ${name} לא הסכים לרשום, ועליהם תורן יודע בבדיקה של כל שעה.` : ''}`);
  else if (w === 'no_secret') out.push('כרגע תורן בודק את החנות כל רבע שעה, אז הודעה יוצאת עד רבע שעה אחרי שמשהו קרה. כדי שתצא מיד, מדביקים כאן את ה-API secret key של האפליקציה שיצרתם ב-Shopify. הוא באותו מסך של ה-token, תחת API credentials.');
  else if (w === 'read_only') out.push('המפתח של WooCommerce שחיברתם הוא לקריאה בלבד, ולכן הוא לא יכול לבקש מהחנות לעדכן את תורן מיד. תורן בודק את ההזמנות כל רבע שעה, ומשם הוא יודע מה קרה. כדי שההודעות ייצאו מיד, יוצרים ב-WooCommerce מפתח עם הרשאת Read/Write ומחברים אותו במקום.');
  else if (w === 'wix_keys') out.push('ב-Wix מפתח API לא יכול לבקש מהאתר לעדכן את תורן מיד, אז תורן בודק את ההזמנות כל רבע שעה.');
  else out.push(`תורן בודק את החנות כל רבע שעה${w && w !== 'no_public_url' ? `, כי ${name} לא הסכים לרשום עדכונים מיידיים` : ''}.`);
  if (s.can?.checkouts === false) out.push(`המפתח לא יכול לקרוא עגלות נטושות ב-${name}, אז תזכורת על עגלה לא תצא.${platform === 'wix' ? ' ב-Wix מסמנים במפתח גם קריאה של Abandoned Checkouts.' : ''}`);
  if (s.polled_at) out.push(`הבדיקה האחרונה: ${stamp(s.polled_at)}.`);
  return out;
}

const CONSENT_HE: Record<string, string> = {
  shopify: 'ב-Shopify זה הסימון בקופה של קבלת עדכונים ומבצעים, במייל או ב-SMS (הסכמה ל-SMS נחשבת גם לוואטסאפ). כדאי שהנוסח שלו יגיד שאולי תכתבו גם בוואטסאפ.',
  woocommerce: 'ב-WooCommerce אין סימון כזה בקופה הרגילה, אז תורן מכיר הסכמה רק מתוסף ששומר אותה על ההזמנה, למשל Mailchimp for WooCommerce.',
  wix: 'ב-Wix ההסכמה נקראת מאיש הקשר של הלקוח, אם הוא נרשם לדיוור במייל או בטלפון.',
};

function previews(kind: Kind, store: string, base: string): string {
  const marketing = KINDS[kind].marketing;
  return KINDS[kind].messages.map((m) => {
    const wa = waText(m, store, SAMPLE).text;
    const mail = emailText(m, store, SAMPLE, `${base}/u/...`);
    const button = marketing ? `<p class="small muted mt8 m0">ומתחת להודעה כפתור "${esc(SETTINGS_BUTTON)}", שמוביל לדף שבו הלקוח יכול להפסיק לקבל מכם תזכורות כאלה. הודעות על תשלום ומשלוח ממשיכות להגיע אליו.</p>` : '';
    return `<h4 class="small mt12 m0">${esc(MESSAGES[m].he)}</h4><p class="small muted m0">בוואטסאפ:</p><blockquote class="q mt8" dir="rtl">${esc(wa).replace(/\n/g, '<br>')}</blockquote>${button}<p class="small muted mt8 m0">במייל, עם הנושא "${esc(mail.subject)}":</p><blockquote class="q mt8" dir="rtl">${esc(mail.text).replace(/\n/g, '<br>')}</blockquote>`;
  }).join('');
}

export async function autoPanel(app: App, r: DashReq, s: { id: number; name: string; platform: string }): Promise<string> {
  if (!ordersPlatform(s.platform)) return '';
  const id = s.id;
  const may = !r.ctx.readOnly && r.user.role !== 'client_member';
  const access = await orderAccessOf(app.db, id);
  const head = `<section class="panel" id="auto"><header><h2>הודעות אוטומטיות</h2></header><p class="m0">תורן יכול לכתוב ללקוחות של ${esc(s.name)} בעצמו כשמשהו קורה בחנות: עגלה שנשארה, תשלום, משלוח, ובקשה לביקורת. כל הודעה כבויה עד שמפעילים אותה כאן. הן לא יוצאות בלילה (21:00 עד 09:00), בשבת ובחגים, ולא נספרות בחבילה אלא אם הלקוח עונה.</p>`;
  if (access?.status !== 'active') return `${head}<p class="mt12 m0">בשביל זה תורן צריך לראות את ההזמנות של החנות. מחברים אותן ב<a href="/lead/${id}/knowledge#orders">מה תורן יודע</a>, עם אותו מפתח שעונה ללקוחות על הזמנות.</p></section>`;
  const platform = access.platform;
  const src = await sourceOf(app, id);
  const settings = await settingsOf(app, id);
  const wa = await storeWa(app, id);
  const mail = await storeEmail(app, id);
  const templates = wa ? await templatesOf(app, wa.id) : [];
  const byName = new Map(templates.map((t) => [t.name, t]));
  const st = await app.db.one<any>('SELECT name, domain, brand, brand_override FROM stores WHERE id = $1', [id]);
  const store = displayName(st?.brand_override?.name, st?.brand?.name, st?.name) || st?.domain || s.name;

  const secretForm = platform === 'shopify' && may && !src?.can?.webhooks ? `<form method="post" action="/lead/${id}/auto/secret" class="mt8">${csrfField(r.ctx)}<label class="f">API secret key<small>מתחיל ב-shpss_. תורן בודק איתו שכל עדכון באמת הגיע מ-Shopify.</small><input type="text" name="secret" dir="ltr" autocomplete="off" spellcheck="false" maxlength="200" required placeholder="shpss_..."></label><button class="btn sm mt8" type="submit">${icon('check')}לחבר עדכונים מיידיים</button></form>` : '';
  const source = `<h3 class="small mt16">מאיפה תורן יודע מה קרה</h3>${sourceLines(platform, src).map((l) => `<p class="small m0 mt8">${esc(l)}</p>`).join('')}${secretForm}`;

  // A marketing template Meta approved in its old wording ("כתבו הסר") still goes out until the new one is approved.
  const oldOk = (m: MessageKey) => byName.get(LEGACY[m]?.template || '')?.status === 'APPROVED';
  const tLine = (t: TemplateRow | undefined, m: MessageKey) => {
    const waiting = Boolean(t && ['PENDING', 'IN_APPEAL'].includes(t.status));
    const [cls, he] = t?.status !== 'APPROVED' && oldOk(m)
      ? ['ok', waiting ? 'אושרה בנוסח הקודם, והחדש מחכה לאישור של Meta' : 'אושרה בנוסח הקודם. צריך לשלוח את הנוסח החדש']
      : t ? T_STATE[t.status] || ['ghost', t.status] : ['ghost', 'עוד לא נשלחה'];
    const moved = t?.category && t.category !== t.asked ? ` <span class="chip warn">Meta סיווגה אותה ${t.category === 'MARKETING' ? 'כשיווקית' : 'כהודעת שירות'}</span>` : '';
    return `<li><span>${esc(MESSAGES[m].he)}</span><span class="end"><span class="chip ${cls}">${esc(he)}</span>${moved}${t?.why && t.status !== 'APPROVED' ? ` <small class="muted">${esc(t.why.slice(0, 120))}</small>` : ''}</span></li>`;
  };
  const allSent = wa && KIND_KEYS.every((k) => KINDS[k].messages.every((m) => ['APPROVED', 'PENDING', 'IN_APPEAL'].includes(byName.get(MESSAGES[m].template)?.status || '')));
  const whatsapp = wa
    ? `<h3 class="small mt16">התבניות בוואטסאפ</h3><p class="small m0">הודעה שהחנות שולחת ראשונה בוואטסאפ צריכה תבנית ש-Meta אישרה בחשבון של החנות. תורן שולח אותן בשמכם, ו-Meta בודקת, בדרך כלל תוך כמה דקות ולפעמים עד יום.</p>
  <ul class="keys mt8">${KIND_KEYS.flatMap((k) => KINDS[k].messages).map((m) => tLine(byName.get(MESSAGES[m].template), m)).join('')}</ul>
  ${may && !allSent ? `<div class="row mt8">${postButton(r.ctx, `/lead/${id}/auto/templates`, 'לשלוח את התבניות לאישור של Meta', { cls: 'btn sm', iconName: 'send' })}</div>` : ''}
  <p class="small muted mt8 m0">Meta גובה על ההודעות האלה מהחשבון של החנות ב-WhatsApp, אז צריך שיהיה בו אמצעי תשלום (ב-WhatsApp Manager, תחת "חיוב").</p>`
    : `<h3 class="small mt16">בוואטסאפ</h3><p class="small m0">בוואטסאפ ההודעות יוצאות מהמספר של החנות, אחרי שמחברים אותו, ואף פעם לא ממספר הדמו שלנו. עד אז אפשר לשלוח במייל.</p>`;

  const kindForm = async (k: Kind) => {
    const set: Setting = settings[k];
    const def = KINDS[k];
    const on = set.whatsapp || set.email;
    const t = await approvedFor(app, wa?.id ?? null, k);
    const waOk = Boolean(wa && t.ok);
    const waNote = !wa ? 'המספר של החנות לא מחובר' : !t.ok ? 'התבנית עוד לא אושרה' : '';
    const mailNote = mail ? '' : 'המייל של החנות לא מחובר';
    const dis = (ok: boolean, checked: boolean) => `${checked ? ' checked' : ''}${ok && may ? '' : ' disabled'}`;
    const delay = def.delay ? `<label class="f mt8">${esc(def.delay.he)}<select name="delay"${may ? '' : ' disabled'}>${def.delay.options.map((o) => `<option value="${o.minutes}"${o.minutes === set.delay_minutes ? ' selected' : ''}>${esc(o.he)}</option>`).join('')}</select></label>` : '';
    const link = k === 'review' ? `<label class="f mt8">הלינק לכתיבת ביקורת<small>למשל הדף של החנות בגוגל, או דף הביקורות באתר. מתחיל ב-https://</small><input type="url" name="link" dir="ltr" maxlength="500" value="${esc(set.link || '')}" placeholder="https://"${may ? '' : ' readonly'}></label>` : '';
    const consent = def.marketing ? `<p class="small muted mt8 m0">זו הודעה שיווקית, אז היא נשלחת רק ללקוח שהסכים לקבל מכם הודעות. ${esc(CONSENT_HE[platform])} בכל הודעה יש לינק קטן שבו הלקוח יכול להפסיק לקבל מכם תזכורות כאלה.</p>` : '';
    return `<form method="post" action="/lead/${id}/auto/${k}" class="mt16">${csrfField(r.ctx)}
  <div class="row"><h3 class="small m0">${esc(def.he)}</h3><span class="end chip ${on ? 'ok' : 'ghost'}">${on ? 'פעיל' : 'כבוי'}</span></div>
  <p class="small m0 mt8">${esc(def.what)}</p>
  <div class="row mt8"><label class="small"><input type="checkbox" name="whatsapp" value="1"${dis(waOk, set.whatsapp)}> בוואטסאפ${waNote && !set.whatsapp ? ` <span class="muted">(${esc(waNote)})</span>` : ''}</label><label class="small"><input type="checkbox" name="email" value="1"${dis(Boolean(mail), set.email)}> במייל${mailNote ? ` <span class="muted">(${esc(mailNote)})</span>` : ''}</label></div>
  <p class="small muted m0 mt8">כשאפשר, ההודעה יוצאת בוואטסאפ, ואם לא, במייל.</p>
  ${delay}${link}${consent}
  <details class="mt8"><summary class="small">איך ההודעה נראית</summary>${previews(k, store, publicBase(app.env))}</details>
  ${may ? '<button class="btn sm mt8" type="submit">לשמור</button>' : ''}</form>`;
  };

  const recent = await app.db.query<any>("SELECT message, ref, status, why, channel, due_at, sent_at, created_at FROM auto_events WHERE store_id = $1 AND kind <> 'order' ORDER BY id DESC LIMIT 8", [id]);
  const recentHtml = recent.length ? `<h3 class="small mt16">ההודעות האחרונות</h3><ul class="keys mt8">${recent.map((e) => {
    const what = `${MESSAGES[e.message as keyof typeof MESSAGES]?.he || e.message}${e.ref ? `, ${e.ref}` : ''}`;
    const state = e.status === 'sent' ? `<span class="chip ok">נשלחה ${e.channel === 'email' ? 'במייל' : 'בוואטסאפ'}, ${esc(stamp(e.sent_at))}</span>` : e.status === 'waiting' || e.status === 'sending' ? `<span class="chip sig">תצא ב-${esc(stamp(e.due_at))}</span>` : `<span class="chip ${e.status === 'failed' ? 'bad' : 'ghost'}">לא נשלחה: ${esc(whyHe(e.why))}</span>`;
    return `<li><span>${esc(what)}</span><span class="end">${state}</span></li>`;
  }).join('')}</ul>` : '';

  const forms = (await Promise.all(KIND_KEYS.map(kindForm))).join('');
  return `${head}${source}${whatsapp}${forms}${recentHtml}${may ? '' : '<p class="small muted mt12 m0">את ההודעות מפעיל מי שפתח את החשבון.</p>'}</section>`;
}

export function autoRoutes(app: App): Route<DashReq>[] {
  const owner = (r: DashReq) => {
    if (r.user.role === 'client_member') throw new ActionError('את ההודעות האוטומטיות מפעיל מי שפתח את החשבון.', 403);
  };
  const back = '/settings#auto';
  return [
    ['POST', /^\/lead\/(\d+)\/auto\/(cart|payment|shipping|review)$/, async (r, m) => {
      owner(r);
      const id = Number(m[1]);
      const kind = m[2];
      if (!isKind(kind)) throw new ActionError('אין הודעה כזו', 404);
      try {
        await saveSetting(app, id, kind, { whatsapp: r.form.whatsapp === '1', email: r.form.email === '1', delay: Number(r.form.delay) || null, link: r.form.link || null }, r.user.name);
      } catch (e) {
        if (e instanceof AutoError) {
          app.log(`[auto] store ${id} ${kind}: ${e.message}`);
          throw new ActionError(e.he);
        }
        throw e;
      }
      const on = r.form.whatsapp === '1' || r.form.email === '1';
      return { redirect: back, message: on ? `ההודעה על ${KINDS[kind].he} פעילה. היא יוצאת רק על מה שקורה בחנות מעכשיו.` : `ההודעה על ${KINDS[kind].he} כבויה.` };
    }],
    ['POST', /^\/lead\/(\d+)\/auto\/templates$/, async (r, m) => {
      owner(r);
      const id = Number(m[1]);
      if (!(await storeWa(app, id))) throw new ActionError('קודם מחברים את הוואטסאפ של החנות.');
      const out = await submitTemplates(app, id, r.user.name);
      return { redirect: back, message: out.refused ? `${out.sent} תבניות נשלחו ל-Meta, ו-${out.refused} לא נשלחו. רואים כאן למה.` : 'התבניות נשלחו ל-Meta. כשהן מאושרות, אפשר להפעיל את ההודעות בוואטסאפ.' };
    }],
    ['POST', /^\/lead\/(\d+)\/auto\/secret$/, async (r, m) => {
      owner(r);
      const id = Number(m[1]);
      const secret = String(r.form.secret || '').trim();
      if (!/^shpss_[A-Za-z0-9]{16,}$/.test(secret) && !/^[a-f0-9]{32,}$/i.test(secret)) throw new ActionError('זה לא נראה כמו API secret key של Shopify. הוא מתחיל ב-shpss_ ומופיע באפליקציה, תחת API credentials.');
      const out = await setupSource(app, id, { secret });
      if (!out) throw new ActionError('קודם מחברים את ההזמנות של החנות.');
      return { redirect: back, message: out.can.webhooks ? 'מעכשיו Shopify מעדכן את תורן ברגע שמשהו קורה בחנות.' : 'Shopify לא הסכים לרשום את העדכונים, אז תורן ממשיך לבדוק כל רבע שעה.' };
    }],
  ];
}
