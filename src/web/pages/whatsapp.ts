import type { App } from '../../app.ts';
import { displayName } from '../../ingest/brand.ts';
import { metaSettings } from '../../channels/meta.ts';
import { ConnectError, connectWhatsapp, disconnectWhatsapp } from '../../channels/waStore.ts';
import { disconnectKapso, finishKapsoConnect, KapsoError, startKapsoConnect, storeConnectReady, waProvider } from '../../channels/kapso.ts';
import { disconnectZernio, finishZernioConnect, startZernioConnect, ZernioError } from '../../channels/zernio.ts';
import { GraphError } from '../../channels/meta.ts';
import { SecretError } from '../../core/secrets.ts';
import { ActionError, DASH_CSP, viaAdminReq, type DashReq, type Route } from '../server.ts';
import { esc, icon, layout, postButton, shortDate, stamp, storeBadge } from '../ui.ts';
import { tokenState } from '../../channels/waStore.ts';
import { oneNumberRoles, ROLE_HE, type Role } from '../../channels/lines.ts';
import { isCompany } from '../../company.ts';
import { BINDING_DAYS } from '../../channels/demo.ts';
import { channelSwitch, offChannels } from './channelOff.ts';
import { pendingClaim } from '../../domainProof.ts';

// A store connects its own WhatsApp number (channels/meta.ts, waStore.ts): the page under /lead/<id>/whatsapp, which
// server.ts opens to the store's own workspace only. Before the button, what to check so Meta's window does not stop
// halfway (the WhatsApp Business app, updated, in use for a week, a Facebook account); the button opens Meta's
// Embedded Signup for an existing WhatsApp Business app number (static/wa-connect.js), and its result comes back to
// POST /lead/<id>/whatsapp/connect. After it: connected, waiting for Meta, or stopped by Meta, and a way to disconnect.
// When the token from Meta ends within ten days, or has ended, the page says so and offers the same button again,
// "לחבר מחדש את הוואטסאפ" (waBanner, also on Today and the lead page).
//
// This page alone loads Meta's SDK, so its CSP lets connect.facebook.net in; every other page keeps DASH_CSP.
//
// With TORAN_WA_PROVIDER=kapso (channels/kapso.ts) a store connects through Kapso instead, while our own Meta app waits
// for its review: the button is a plain form that makes a setup link and sends the store to Kapso's hosted page (so
// form-action lets app.kapso.ai in, the one place it may go), and Kapso sends the store back to
// /lead/<id>/whatsapp/kapso, which takes the number and shows this page with how it went. Our company store always
// connects on Meta.
//
// With TORAN_WA_PROVIDER=zernio (channels/zernio.ts; the owner, 2026-11-08: "yes, switch to zernio") the same plain form
// sends the store to Zernio's hosted page on zernio.com, coexistence, and Zernio sends it back to
// /lead/<id>/whatsapp/zernio?connected=whatsapp&accountId=.. (or ?error=..), which takes the number the same way.

// A function, not a constant: server.ts imports this module before DASH_CSP exists.
const connectCsp = () => DASH_CSP
  .replace("script-src 'self'", "script-src 'self' https://connect.facebook.net")
  .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
  .replace("connect-src 'self'", "connect-src 'self' https://*.facebook.com https://*.facebook.net")
  .replace("frame-src 'self'", "frame-src 'self' https://*.facebook.com")
  .replace("form-action 'self'", "form-action 'self' https://app.kapso.ai https://zernio.com");

export type WaRow = { id: number; status: string; meta: any; name: string | null; connected_at: string; token_expires_at: string | null; token_checked_at: string | null; kind?: string };

export async function waAccountOf(app: App, storeId: number): Promise<WaRow | null> {
  return app.db.one<WaRow>("SELECT id, status, meta, name, connected_at, token_expires_at, token_checked_at, kind FROM channel_accounts WHERE store_id = $1 AND channel = 'whatsapp' AND kind IN ('meta', 'kapso', 'zernio') ORDER BY (status <> 'off') DESC, id DESC LIMIT 1", [storeId]);
}

/** A line at the top of the page: how the connection through Kapso or Zernio went. */
const noticeHe = (kind: 'info' | 'warn', title: string, text: string) => `<div class="banner ${kind}">${icon(kind === 'info' ? 'check' : 'alert')}<div><b>${esc(title)}</b><p>${esc(text)}</p></div></div>`;

/** Zernio's own reasons for a WhatsApp connect that did not go through, said to the store (zernio.com/openapi.yaml, getConnectUrl). */
const ZERNIO_WA_ERRORS_HE: Record<string, string> = {
  whatsapp_coexistence_not_registered: 'המספר עוד לא רשום ב-WhatsApp Business בטלפון, או שהוא בשימוש שם פחות משבוע. אחרי שבוע בשימוש באפליקציה מנסים שוב.',
  // A number for Toran alone that a WhatsApp app still uses, and Meta's own reason when it gave one.
  whatsapp_number_in_use: 'המספר הזה עדיין רשום באפליקציית וואטסאפ. כדי לחבר אותו רק לתורן, מוחקים קודם את החשבון שלו באפליקציה, או מחברים אותו כמו שהוא, עם האפליקציה.',
  whatsapp_error: 'Meta לא השלימה את החיבור. אם זה מספר חדש, כדאי לבדוק שהקוד הגיע אליו ושהוא לא רשום באף אפליקציית וואטסאפ, ולנסות שוב.',
  whatsapp_number_already_connected: 'המספר הזה כבר מחובר לשירות אחר. מנתקים אותו שם, ואז מנסים שוב.',
  one_whatsapp_per_profile: 'לחנות הזו כבר מחובר מספר. מנתקים אותו כאן, ואז מחברים את החדש.',
  connection_cancelled: 'החלון נסגר לפני הסוף. אפשר לנסות שוב.',
  session_expired: 'עבר יותר משעה מאז שהחלון נפתח. לוחצים שוב על "לחבר".',
};

const phone = (a: WaRow) => (a.meta?.display_phone_number ? `<bdi class="ltr">+${esc(a.meta.display_phone_number)}</bdi>` : '');
const AGAIN = 'לחבר מחדש את הוואטסאפ';

/**
 * The banner on Today, the lead page and the WhatsApp page while the store's token ends within WARN_DAYS, or has
 * ended (channels/waStore.ts). `here`: on the WhatsApp page itself, whose own button connects again.
 */
export function waBanner(a: WaRow | null, storeId: number, { here = false }: { here?: boolean } = {}): string {
  if (!a) return '';
  const t = tokenState(a);
  if (!t.ended && !t.soon) return '';
  const go = here ? '' : `<a class="btn sm primary" href="/lead/${storeId}/whatsapp">${icon('chat')}${AGAIN}</a>`;
  if (t.ended) return `<div class="banner bad">${icon('alert')}<div><b>תורן לא עונה בוואטסאפ של החנות</b><p>החיבור של הוואטסאפ לתורן הסתיים. ההודעות של הלקוחות מחכות לכם בשיחות, ואפשר לענות להן מהטלפון. כדי שתורן יחזור לענות, מחברים מחדש. זה לוקח דקה.</p></div>${go}</div>`;
  const ends = shortDate(t.endsAt);
  return `<div class="banner warn">${icon('alert')}<div><b>צריך לחבר מחדש את הוואטסאפ עד ${esc(ends)}</b><p>החיבור של הוואטסאפ לתורן מסתיים ב-${esc(ends)}, ואחרי זה תורן לא יוכל לענות בו. זה לוקח דקה, והוואטסאפ בטלפון לא משתנה.</p></div>${go}</div>`;
}

/** One line on the store's WhatsApp, for Today, Settings and the lead page. */
export function waLine(a: WaRow | null, s: { id: number; demo_code?: string | null; taken_down_at?: string | null; platform?: string | null }, ready: boolean): string {
  if (a?.status === 'reconnect') return `החיבור של ${phone(a)} לתורן הסתיים, ותורן לא עונה בו. <a href="/lead/${s.id}/whatsapp">${AGAIN}</a>`;
  if (a?.status === 'active' && tokenState(a).soon) return `מחובר, ${phone(a)}. החיבור מסתיים ב-${esc(shortDate(tokenState(a).endsAt))}. <a href="/lead/${s.id}/whatsapp">${AGAIN}</a>`;
  // Our company store's number is our one number (channels/lines.ts): never this store's own WhatsApp.
  if (a?.status === 'active' && isCompany(s)) return `מחובר, ${phone(a)}. זה המספר שלנו: תורן עונה בו לבעלי העסקים, לדמו ולתמיכה, והוואטסאפ בטלפון ממשיך לעבוד. <a href="/lead/${s.id}/whatsapp">מה המספר עושה</a>`;
  if (a?.status === 'active') return a.meta?.coexistence === false ? `מחובר, ${phone(a)}. תורן עונה בו, ועל מה שמחכה לכם עונים מהשיחות כאן.` : `מחובר, ${phone(a)}. תורן עונה בו, והוואטסאפ בטלפון ממשיך לעבוד.`;
  if (a?.status === 'pending') return `${phone(a)} ממתין לאישור של Meta. תורן יתחיל לענות בו לבד כשהמספר מאושר.`;
  if (a?.status === 'error') return `Meta עצרה את המספר ${phone(a)} (${esc(a.meta?.why || 'בלי סיבה')}). תורן לא עונה בו. כתבו לנו ונבדוק יחד.`;
  // Not connected: one clear button (the owner, 2026-11-09: "i dont see a place where to connect the whatsapp number"),
  // and no demo code on the line (the project's rule: no codes or mechanics shown).
  return ready ? `<a class="btn sm" href="/lead/${s.id}/whatsapp">${icon('chat')}${CONNECT}</a>` : 'החיבור של הוואטסאפ של העסק עוד לא פתוח אצלנו.';
}

/** The button's words wherever the store's WhatsApp is connected from: Settings, Today, setup, its own page. */
export const CONNECT = 'לחבר את הוואטסאפ של העסק';

/**
 * On our company store's page: what our one number does once it is connected here (channels/lines.ts), in the order
 * its messages are read, and how to try each role; before that, what connecting it here does.
 */
async function oursPanel(app: App, storeId: number): Promise<string> {
  const r = await oneNumberRoles(app);
  if (!r || r.one.storeId !== storeId) return `<section class="panel mt16"><header><h2>המספר של OpenFrequency</h2></header>
  <p class="m0">זה העמוד של התמיכה שלנו. כשמחברים כאן את המספר של OpenFrequency, תורן עונה בו בשלושה תפקידים: לבעלי העסקים שמחוברים לחשבון, לדמו ולתמיכה. אין צורך בהגדרה נוספת.</p>
</section>`;
  const items = r.roles.map((x) => `<li>${esc(ROLE_HE[x])}</li>`).join('');
  const off = (['owner', 'demo', 'support'] as Role[]).filter((x) => !r.roles.includes(x));
  return `<section class="panel mt16"><header><h2>מה המספר הזה עושה</h2><span class="end chip ok">מספר אחד, ${r.roles.length} תפקידים</span></header>
  <p class="m0">כל הודעה למספר נקראת לפי הסדר הזה, והתשובה יוצאת מאותו מספר:</p>
  <ol class="mt8 m0">${items}</ol>
  <p class="small mt12 m0">קוד של דמו נקרא לפני הכול, כדי שגם בעל עסק שלוחץ על הכפתור בעמוד של חנות יקבל את הדמו. מי שבדמו וכותב "תמיכה" או "עזרה" עובר לתמיכה, וכך גם כשעוברים ${BINDING_DAYS} ימים מתחילת הדמו.</p>
  ${off.includes('owner') ? '<p class="small muted mt8 m0">הקו של בעלי העסקים במספר אחר, כי META_OWNER_PHONE_ID מכוון אליו.</p>' : ''}
  ${off.includes('support') ? '<p class="small muted mt8 m0">התמיכה כבויה: TORAN_SUPPORT_STORE מכוון לחנות שלא קיימת כאן.</p>' : ''}
  <p class="small mt12 m0">כשעונים מהטלפון, התשובה נכנסת לשיחה שבה האדם נמצא עכשיו, ותורן מפסיק לענות בה ל-12 שעות.</p>
</section>`;
}

/**
 * A number for Toran alone, without coexistence (the owner, 2026-11-09: "also build an option for businesses connecting
 * not trough coexistnece"): folded under the main button, which is the number the store already uses. Zernio opens
 * Meta's standard window (onboarding=api, channels/zernio.ts), where the number gets a code by SMS or a call. The
 * number must not be on any WhatsApp app, and none can be on it afterwards: the owner answers from the inbox here.
 */
const newNumber = (r: DashReq, id: number) => `<details class="mt16"><summary class="small">אין לכם WhatsApp Business, או שרוצים מספר חדש רק לתורן?</summary>
  <p class="small mt8 m0">אפשר לחבר מספר שלא נמצא באף אפליקציית וואטסאפ, למשל קו חדש. אחרי החיבור אי אפשר להשתמש בו באפליקציה בטלפון, ועל מה שתורן מעביר אליכם עונים מהשיחות כאן.</p>
  <ol class="steps mt12">
    <li><span>נכנסים לפייסבוק, ובוחרים את העסק או יוצרים אותו.</span></li>
    <li><span>בוחרים להוסיף מספר חדש, וכותבים את שם העסק כמו שלקוחות יראו אותו. Meta בודקת את השם.</span></li>
    <li><span>מקלידים את המספר, ומקבלים אליו קוד ב-SMS או בשיחה.</span></li>
  </ol>
  <div class="mt12">${postButton(r.ctx, `/lead/${id}/whatsapp/zernio/start`, 'לחבר מספר חדש לתורן', { cls: 'btn sm', iconName: 'chat', fields: { number: 'new' } })}</div>
</details>`;

/**
 * Connecting the number the business already uses, as a guided card (the owner, 2026-11-09: "make everything easy for
 * the user. he also doesnt know anything about tech", and "i dont see a place where to connect the whatsapp number.
 * copy the setup process from teder"): what to have ready, what happens after the one button, step by step, and what
 * changes in the app and what Meta charges, folded. No "coexistence", WABA or phone number id on it.
 *
 * Checked 2026-11-09:
 *   - Zernio's hosted page is in English (its language parameter has en, es and pt-BR only, "videos stay in English";
 *     docs.zernio.com/platforms/whatsapp/connection), with a checklist that follows Meta's window.
 *   - The approval on the phone: Zernio's docs say "The user opens the WhatsApp Business app and taps the camera icon at
 *     the top right to scan it, or scans it from Settings > Linked devices"; Meta's own page says a message comes from
 *     the official Facebook Business account and the owner taps Connect, then confirms sharing the chat history
 *     (developers.facebook.com, onboarding business app users). Which one the owner sees is UNVERIFIED, so the step
 *     names both; the Hebrew words of the app's buttons are UNVERIFIED and not quoted.
 *   - Meta: app version 2.24.17 or newer; up to 6 months of 1:1 chats can be shared; "Messages sent and received are
 *     mirrored between the Cloud API and WhatsApp Business app"; disappearing messages, view once and live location are
 *     turned off in 1:1 chats and broadcast lists are disabled; groups are not synced; the app must be opened about
 *     every 14 days or the connection stops. A week of use in the app before connecting is said only by third parties
 *     (UNVERIFIED), so it is not on the list; Zernio's own refusal for a number too new still says it (ZERNIO_WA_ERRORS_HE).
 *   - Meta's fees changed on 2026-10-01: a free tier of 1,000 service messages a month per number, then per message;
 *     messages the business starts are charged per message; a payment method in Meta's Billing Hub
 *     (developers.facebook.com/documentation/business-messaging/whatsapp/pricing). Whose Billing Hub holds it on a
 *     number connected through Zernio is UNVERIFIED, so the line says "בחשבון של העסק ב-Meta" as the page did.
 */
function connectGuide(via: 'zernio' | 'kapso' | 'meta', button: string, extra = ''): string {
  const page = via === 'zernio' ? 'של Zernio, השירות שמחבר את הוואטסאפ לתורן. העמוד מראה כל שלב בזמן שהוא קורה.' : via === 'kapso' ? 'של Kapso, השירות שמחבר את הוואטסאפ לתורן. שם בוחרים WhatsApp Business App.' : 'בו עושים את כל השלבים הבאים.';
  return `<section class="panel" id="connect"><header><h2>מחברים את הוואטסאפ של העסק</h2></header>
  <p class="m0">תורן עונה במספר שכבר יש לעסק, והוואטסאפ בטלפון ממשיך לעבוד. כשעונים ללקוח מהטלפון, התשובה מופיעה גם כאן, ותורן לא מתערב בשיחה הזו.</p>
  <h3 class="small mt16">מה צריך לפני</h3>
  <ul class="m0">
    <li>הוואטסאפ של העסק באפליקציית WhatsApp Business, מעודכנת. אם זה הוואטסאפ הרגיל, עוברים ל-WhatsApp Business בחינם, והשיחות עוברות איתו.</li>
    <li>חשבון פייסבוק להיכנס איתו.</li>
    <li>הטלפון עם הוואטסאפ של העסק לידכם.</li>
  </ul>
  <h3 class="small mt16">מה קורה אחרי הלחיצה</h3>
  <ol class="steps mt8">
    <li><b>${via === 'meta' ? 'נפתח חלון של Meta' : 'נפתח עמוד באנגלית'}</b><span>${esc(page)}</span></li>
    <li><b>נכנסים לפייסבוק</b><span>ובוחרים את העסק, או יוצרים אותו.</span></li>
    <li><b>בוחרים לחבר את WhatsApp Business הקיים</b><span>ומקלידים את המספר של העסק.</span></li>
    <li><b>מאשרים בטלפון</b><span>באפליקציית WhatsApp Business: סורקים את הקוד שעל המסך במצלמה שבאפליקציה, או פותחים את ההודעה מ-Facebook Business ומאשרים. אפשר לשתף גם את השיחות של חצי השנה האחרונה.</span></li>
    <li><b>חוזרים לכאן לבד</b><span>והעמוד אומר שהמספר מחובר.</span></li>
  </ol>
  ${button}
  <details class="mt16"><summary class="small">מה משתנה באפליקציה אחרי החיבור?</summary><p class="small mt8 m0">רשימות תפוצה נכבות, ובשיחות עם לקוחות נכבים הודעות נעלמות, צפייה חד-פעמית ומיקום חי. קבוצות לא עוברות לתורן. כדאי לפתוח את האפליקציה לפחות פעם בשבועיים, אחרת Meta מנתקת את החיבור.</p></details>
  <details class="mt8"><summary class="small">כמה זה עולה ב-Meta?</summary><p class="small mt8 m0">Meta גובה מהחשבון של העסק על הודעות שיוצאות דרך תורן. 1,000 תשובות ללקוחות בחודש בלי תשלום, ואחר כך לפי הודעה. הודעה שהעסק שולח ראשון, למשל תזכורת על עגלה, בתשלום לכל הודעה. בשביל זה צריך אמצעי תשלום בחשבון של העסק ב-Meta.</p></details>
  ${extra}
</section>`;
}

/**
 * /whatsapp: the WhatsApp page of the session's store, or, before the store exists, what to have ready and why the
 * button waits. Connecting needs the store (its Zernio profile, its channel account), and the store exists only once
 * its site is proven the workspace's (domainProof.ts, PRA-SEC-003: nothing is read and no lead is taken before the
 * proof), so the button opens right after the proof, while the site is still being read (as Teder's "אפשר לחבר כבר
 * עכשיו, עוד לפני שהחשבון מוכן"). Until then this page has the guide and one button, to the proof.
 */
async function prepPage(app: App, r: DashReq) {
  const ws = Number(r.scope.workspaceId) || 0;
  const claim = ws > 0 ? await pendingClaim(app, ws) : null;
  const ro = r.ctx.readOnly;
  const wait = claim
    ? `<div class="banner info">${icon('clock')}<div><b>החיבור נפתח מיד אחרי שמאמתים את האתר</b><p>זה לוקח דקה, ומיד אחרי זה הכפתור כאן פתוח, גם בזמן שתורן קורא את האתר.</p></div>${ro ? '' : `<a class="btn sm primary" href="/start">${icon('check')}לאמת את האתר</a>`}</div>`
    : `<div class="banner info">${icon('clock')}<div><b>קודם מוסיפים את החנות</b><p>כותבים את הכתובת של האתר ומאמתים שהוא שלכם. מיד אחרי זה הכפתור כאן פתוח.</p></div>${ro ? '' : `<a class="btn sm primary" href="/start">${icon('plus')}להוסיף את החנות</a>`}</div>`;
  const body = `<div class="head"><h1>הוואטסאפ של העסק</h1></div>
${wait}
${connectGuide(waProvider(app.env) === 'zernio' ? 'zernio' : waProvider(app.env) === 'kapso' ? 'kapso' : 'meta', `<p class="small muted mt16 m0">הכפתור "${CONNECT}" יופיע כאן מיד אחרי האימות.</p>`)}`;
  return layout({ ...r.ctx, title: 'הוואטסאפ של העסק', active: 'settings' }, body);
}

async function page(app: App, r: DashReq, id: number, notice = '') {
  const s = await app.db.one<any>('SELECT id, name, domain, brand, brand_override, demo_code, taken_down_at, platform FROM stores WHERE id = $1', [id]);
  if (!s) return null;
  const ours = isCompany(s) ? await oursPanel(app, id) : '';
  const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
  const a = await waAccountOf(app, id);
  // Through Kapso for every store but ours, when TORAN_WA_PROVIDER says so (channels/kapso.ts).
  const viaKapso = waProvider(app.env) === 'kapso' && !isCompany(s);
  // Through Zernio for every store but ours, when TORAN_WA_PROVIDER says so (channels/zernio.ts).
  const viaZernio = waProvider(app.env) === 'zernio' && !isCompany(s);
  const ready = storeConnectReady(app.env, isCompany(s));
  const m = metaSettings(app.env);
  const ro = r.ctx.readOnly;
  const live = a && a.status !== 'off';
  const tok = a ? tokenState(a) : null;
  // The token ends soon or has ended: the same window of Meta's connects the same number again (waStore.ts). A Kapso
  // number has no token of ours; Meta taking its access away makes it 'reconnect' too (kapso.ts kapsoEvent).
  const again = Boolean(live && tok && (tok.ended || tok.soon));
  const connectButton = (label: string) => ro ? '<p class="muted mt12 m0">במצב צפייה אי אפשר לחבר.</p>' : !ready
    ? '<p class="muted mt12 m0">החיבור עוד לא פתוח בשרת. כתבו לנו, ונחבר יחד.</p>'
    : viaKapso || viaZernio
      ? `<div class="mt16">${postButton(r.ctx, `/lead/${id}/whatsapp/${viaZernio ? 'zernio' : 'kapso'}/start`, label, { cls: 'btn primary', iconName: 'chat' })}</div>`
      : `<div class="mt16" data-wa-connect data-app-id="${esc(m.appId)}" data-config-id="${esc(m.configId)}" data-version="${esc(m.version)}" data-action="/lead/${id}/whatsapp/connect" data-csrf="${esc(r.ctx.csrf)}"><button class="btn primary" type="button" disabled>${icon('chat')}${label}</button><p class="small mt8 m0" data-msg role="status" aria-live="polite"></p></div>`;
  const chip = a?.status === 'active' ? (tok?.soon ? ['sig', 'צריך לחבר מחדש'] : ['ok', 'מחובר']) : a?.status === 'pending' ? ['sig', 'ממתין לאישור של Meta'] : a?.status === 'reconnect' ? ['bad', 'צריך לחבר מחדש'] : ['bad', 'נעצר'];
  const until = a?.token_expires_at ? esc(stamp(a.token_expires_at)) : a?.token_checked_at ? 'בלי הגבלת זמן' : '';

  const state = live
    ? `<section class="panel"><header><h2>הוואטסאפ של ${esc(name)}</h2><span class="end chip ${chip[0]}">${chip[1]}</span></header>
  <p class="m0">${waLine(a, s, ready)}</p>
  ${a!.status === 'pending' ? '<p class="small muted mt8 m0">בודקים מול Meta כל עשר דקות. לרוב זה לוקח כמה דקות, לפעמים עד יום.</p>' : ''}
  ${again ? `<p class="small mt12 m0">מחברים מחדש באותו חלון של Meta, עם אותו מספר. השיחות נשארות, והוואטסאפ בטלפון לא משתנה.</p>${connectButton(AGAIN)}` : ''}
  ${a!.status === 'active' && !ours ? channelSwitch(r, id, 'whatsapp', (await offChannels(app, id)).includes('whatsapp')) : ''}
  <dl class="kv mt12"><dt>שם העסק ב-WhatsApp</dt><dd>${esc(a!.name || a!.meta?.verified_name || '-')}</dd><dt>חובר</dt><dd>${esc(stamp(a!.connected_at))}</dd>${until ? `<dt>החיבור בתוקף עד</dt><dd>${until}</dd>` : ''}</dl>
  <p class="small mt12 m0">${a!.meta?.coexistence === false ? 'המספר הזה מחובר לתורן בלבד, בלי אפליקציה בטלפון. עונים ללקוחות מהשיחות כאן, ואחרי שעניתם תורן מפסיק לענות בשיחה הזו לזמן מה.' : 'כשעונים ללקוח מהטלפון, תורן מפסיק לענות בשיחה הזו, ורואים את התשובה גם כאן, בשיחות.'}</p>
  ${ro ? '' : `<div class="row mt12">${postButton(r.ctx, `/lead/${id}/whatsapp/disconnect`, 'לנתק את הוואטסאפ מתורן', { cls: 'btn sm danger', confirm: ours ? 'לנתק? תורן יפסיק לענות במספר שלנו: לבעלי העסקים, בדמו ובתמיכה. הוואטסאפ בטלפון ממשיך לעבוד כרגיל.' : 'לנתק? תורן יפסיק לענות בוואטסאפ של החנות. הוואטסאפ בטלפון ממשיך לעבוד כרגיל.' })}</div>`}
</section>`
    : connectGuide(viaZernio ? 'zernio' : viaKapso ? 'kapso' : 'meta', connectButton(CONNECT), viaZernio && ready && !ro ? newNumber(r, id) : '');
  const body = `<a class="back" href="/settings#channels">${icon('chev')}הגדרות</a>
<div class="head"><div class="row">${storeBadge({ id: s.id, name, domain: s.domain })}<h1 class="title">הוואטסאפ של ${esc(name)}</h1></div></div>
${notice}
${live ? waBanner(a, id, { here: true }) : ''}
${state}
${ours}
${ready && !viaKapso && !viaZernio && (!live || again) && !ro ? '<script src="/static/wa-connect.js?v=2" defer></script>' : ''}`;
  return layout({ ...r.ctx, title: `הוואטסאפ של ${name}`, active: 'settings' }, body);
}

export function whatsappRoutes(app: App): Route<DashReq>[] {
  return [
    // The store's WhatsApp from anywhere (setup's step, Today, Settings): its page once the store exists, else the guide.
    ['GET', /^\/whatsapp$/, async (r) => {
      if (r.scope.operator) return { redirect: '/' };
      const s = await app.db.one<{ id: number }>('SELECT id FROM stores WHERE workspace_id = $1 ORDER BY id LIMIT 1', [Number(r.scope.workspaceId) || 0]);
      return s ? { redirect: `/lead/${s.id}/whatsapp` } : { html: await prepPage(app, r) };
    }],
    ['GET', /^\/lead\/(\d+)\/whatsapp$/, async (r, m) => {
      // Kapso's hosted page sends the store back here when the connection did not go through.
      const failed = r.url.searchParams.get('kapso') === 'failed' ? noticeHe('warn', 'החיבור לא הושלם', 'אפשר לנסות שוב. אם זה חוזר, כתבו לנו ונחבר יחד.') : '';
      const html = await page(app, r, Number(m[1]), failed);
      if (!html) throw new ActionError('אין חנות כזו', 404);
      return { html, headers: { 'content-security-policy': connectCsp() } };
    }],
    // Through Kapso (channels/kapso.ts): a setup link, and the store goes to Kapso's hosted page.
    ['POST', /^\/lead\/(\d+)\/whatsapp\/kapso\/start$/, async (r, m) => {
      const id = Number(m[1]);
      try {
        return { redirect: await startKapsoConnect(app, id, r.user.name) };
      } catch (e: any) {
        if (e instanceof KapsoError) throw new ActionError(e.he);
        app.log(`[kapso] setup link for store ${id} failed: ${e?.message || e}`);
        if (e instanceof GraphError) throw new ActionError('לא הצלחנו לפתוח את עמוד החיבור. אפשר לנסות שוב בעוד כמה דקות, ואם זה חוזר, כתבו לנו.');
        throw e;
      }
    }],
    // Kapso's hosted page, done: the number is taken when Kapso's own API says it is this store's, and the page says how
    // it went (a page, not a redirect: the way back from Kapso's site may not carry a flash cookie).
    ['GET', /^\/lead\/(\d+)\/whatsapp\/kapso$/, async (r, m) => {
      const id = Number(m[1]);
      let notice: string;
      try {
        const out = await finishKapsoConnect(app, id, r.url.searchParams.get('phone_number_id'), r.user.name);
        notice = out.status === 'active' ? noticeHe('info', 'הוואטסאפ מחובר', 'תורן עונה בו מעכשיו, והוואטסאפ בטלפון ממשיך לעבוד.') : noticeHe('info', 'החיבור נשלח', 'המספר ממתין לאישור של Meta, ותורן יתחיל לענות בו לבד כשהוא מאושר.');
      } catch (e: any) {
        if (!(e instanceof KapsoError)) app.log(`[kapso] connect for store ${id} failed: ${e?.message || e}`);
        notice = noticeHe('warn', 'החיבור לא הושלם', e instanceof KapsoError ? e.he : 'Kapso לא אישרה את המספר. אפשר לנסות שוב בעוד כמה דקות, ואם זה חוזר, כתבו לנו.');
      }
      const html = await page(app, r, id, notice);
      if (!html) throw new ActionError('אין חנות כזו', 404);
      return { html, headers: { 'content-security-policy': connectCsp() } };
    }],
    // Through Zernio (channels/zernio.ts): the store's Zernio profile, and the store goes to Zernio's hosted page.
    ['POST', /^\/lead\/(\d+)\/whatsapp\/zernio\/start$/, async (r, m) => {
      const id = Number(m[1]);
      try {
        return { redirect: await startZernioConnect(app, id, 'whatsapp', r.user.name, { viaAdmin: viaAdminReq(r.req), number: r.form.number === 'new' ? 'new' : 'app' }) };
      } catch (e: any) {
        if (e instanceof ZernioError) throw new ActionError(e.he);
        app.log(`[zernio] whatsapp connect link for store ${id} failed: ${e?.message || e}`);
        if (e instanceof GraphError) throw new ActionError('לא הצלחנו לפתוח את עמוד החיבור. אפשר לנסות שוב בעוד כמה דקות, ואם זה חוזר, כתבו לנו.');
        throw e;
      }
    }],
    // Zernio's hosted page, done (?connected=whatsapp&accountId=..) or not (?error=..): the number is taken when
    // Zernio's own API lists it under this store's profile, and the page says how it went.
    ['GET', /^\/lead\/(\d+)\/whatsapp\/zernio$/, async (r, m) => {
      const id = Number(m[1]);
      const q = r.url.searchParams;
      let notice: string;
      if (q.get('error')) {
        const why = String(q.get('error') || '');
        app.log(`[zernio] whatsapp connect for store ${id} came back with ${why.slice(0, 60)}${q.get('request_id') ? ` (request ${String(q.get('request_id')).slice(0, 60)})` : ''}`);
        notice = noticeHe('warn', 'החיבור לא הושלם', ZERNIO_WA_ERRORS_HE[why] || 'אפשר לנסות שוב. אם זה חוזר, כתבו לנו ונחבר יחד.');
      } else {
        try {
          const number = q.get('number') === 'new' ? 'new' : 'app';
          await finishZernioConnect(app, id, 'whatsapp', q.get('accountId'), r.user.name, { number });
          notice = noticeHe('info', 'הוואטסאפ מחובר', number === 'new' ? 'תורן עונה בו מעכשיו. על המספר הזה עונים ללקוחות מהשיחות כאן, לא מאפליקציה בטלפון.' : 'תורן עונה בו מעכשיו, והוואטסאפ בטלפון ממשיך לעבוד.');
        } catch (e: any) {
          if (!(e instanceof ZernioError)) app.log(`[zernio] whatsapp connect for store ${id} failed: ${e?.message || e}`);
          notice = noticeHe('warn', 'החיבור לא הושלם', e instanceof ZernioError ? e.he : 'Zernio לא אישרה את המספר. אפשר לנסות שוב בעוד כמה דקות, ואם זה חוזר, כתבו לנו.');
        }
      }
      const html = await page(app, r, id, notice);
      if (!html) throw new ActionError('אין חנות כזו', 404);
      return { html, headers: { 'content-security-policy': connectCsp() } };
    }],
    ['POST', /^\/lead\/(\d+)\/whatsapp\/connect$/, async (r, m) => {
      const id = Number(m[1]);
      try {
        // The person who connects is who hears when the connection has to be made again (waStore.ts).
        const email = r.user.role === 'superadmin' ? null : r.user.email || null;
        const out = await connectWhatsapp(app, id, { code: r.form.code, phoneId: r.form.phone_number_id, wabaId: r.form.waba_id, businessId: r.form.business_id, event: r.form.event, by: r.user.name, email });
        // Our company store's number is our one number from now on (channels/lines.ts): nothing else to set.
        if (out.ours) return { redirect: `/lead/${id}/whatsapp`, message: out.status === 'active' ? 'המספר שלנו מחובר. מעכשיו תורן עונה בו לבעלי העסקים, לדמו ולתמיכה.' : 'החיבור נשלח. כש-Meta תאשר את המספר, תורן יענה בו לבעלי העסקים, לדמו ולתמיכה.' };
        return { redirect: `/lead/${id}/whatsapp`, message: out.status === 'active' ? 'הוואטסאפ מחובר. תורן עונה בו מעכשיו.' : 'החיבור נשלח. ממתין לאישור של Meta, ותורן יתחיל לענות לבד כשהמספר מאושר.' };
      } catch (e: any) {
        if (e instanceof ConnectError) throw new ActionError(e.he);
        app.log(`[wa] connect for store ${id} failed: ${e?.message || e}`);
        if (e instanceof GraphError || e instanceof SecretError) throw new ActionError('Meta לא השלימה את החיבור. אפשר לנסות שוב בעוד כמה דקות, ואם זה חוזר, כתבו לנו.');
        throw e;
      }
    }],
    ['POST', /^\/lead\/(\d+)\/whatsapp\/disconnect$/, async (r, m) => {
      const id = Number(m[1]);
      const a = await waAccountOf(app, id);
      if (a?.kind === 'kapso') await disconnectKapso(app, id, r.user.name);
      else if (a?.kind === 'zernio') await disconnectZernio(app, id, 'whatsapp', r.user.name);
      else await disconnectWhatsapp(app, id, r.user.name);
      return { redirect: `/lead/${id}/whatsapp`, message: 'הוואטסאפ נותק מתורן. בטלפון הוא ממשיך לעבוד כרגיל.' };
    }],
  ];
}
