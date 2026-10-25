import type { App } from '../../app.ts';
import { displayName } from '../../ingest/brand.ts';
import { metaSettings, waConnectReady } from '../../channels/meta.ts';
import { ConnectError, connectWhatsapp, disconnectWhatsapp } from '../../channels/waStore.ts';
import { GraphError } from '../../channels/meta.ts';
import { SecretError } from '../../core/secrets.ts';
import { ActionError, DASH_CSP, type DashReq, type Route } from '../server.ts';
import { esc, icon, layout, postButton, shortDate, stamp, storeBadge } from '../ui.ts';
import { tokenState } from '../../channels/waStore.ts';

// A store connects its own WhatsApp number (channels/meta.ts, waStore.ts): the page under /lead/<id>/whatsapp, which
// server.ts opens to the store's own workspace only. Before the button, what to check so Meta's window does not stop
// halfway (the WhatsApp Business app, updated, in use for a week, a Facebook account); the button opens Meta's
// Embedded Signup for an existing WhatsApp Business app number (static/wa-connect.js), and its result comes back to
// POST /lead/<id>/whatsapp/connect. After it: connected, waiting for Meta, or stopped by Meta, and a way to disconnect.
// When the token from Meta ends within ten days, or has ended, the page says so and offers the same button again,
// "לחבר מחדש את הוואטסאפ" (waBanner, also on Today and the lead page).
//
// This page alone loads Meta's SDK, so its CSP lets connect.facebook.net in; every other page keeps DASH_CSP.

// A function, not a constant: server.ts imports this module before DASH_CSP exists.
const connectCsp = () => DASH_CSP
  .replace("script-src 'self'", "script-src 'self' https://connect.facebook.net")
  .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
  .replace("connect-src 'self'", "connect-src 'self' https://*.facebook.com https://*.facebook.net")
  .replace("frame-src 'self'", "frame-src 'self' https://*.facebook.com");

export type WaRow = { id: number; status: string; meta: any; name: string | null; connected_at: string; token_expires_at: string | null; token_checked_at: string | null };

export async function waAccountOf(app: App, storeId: number): Promise<WaRow | null> {
  return app.db.one<WaRow>("SELECT id, status, meta, name, connected_at, token_expires_at, token_checked_at FROM channel_accounts WHERE store_id = $1 AND channel = 'whatsapp' AND kind = 'meta' ORDER BY (status <> 'off') DESC, id DESC LIMIT 1", [storeId]);
}

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
export function waLine(a: WaRow | null, s: { id: number; demo_code?: string | null; taken_down_at?: string | null }, ready: boolean): string {
  if (a?.status === 'reconnect') return `החיבור של ${phone(a)} לתורן הסתיים, ותורן לא עונה בו. <a href="/lead/${s.id}/whatsapp">${AGAIN}</a>`;
  if (a?.status === 'active' && tokenState(a).soon) return `מחובר, ${phone(a)}. החיבור מסתיים ב-${esc(shortDate(tokenState(a).endsAt))}. <a href="/lead/${s.id}/whatsapp">${AGAIN}</a>`;
  if (a?.status === 'active') return `מחובר, ${phone(a)}. תורן עונה בו, והוואטסאפ בטלפון ממשיך לעבוד.`;
  if (a?.status === 'pending') return `${phone(a)} ממתין לאישור של Meta. תורן יתחיל לענות בו לבד כשהמספר מאושר.`;
  if (a?.status === 'error') return `Meta עצרה את המספר ${phone(a)} (${esc(a.meta?.why || 'בלי סיבה')}). תורן לא עונה בו. כתבו לנו ונבדוק יחד.`;
  const demo = s.demo_code && !s.taken_down_at ? `עכשיו תורן עונה על מספר הדמו שלנו, עם הקוד <bdi class="ltr">${esc(s.demo_code)}</bdi>. ` : '';
  return ready ? `${demo}<a href="/lead/${s.id}/whatsapp">לחבר את הוואטסאפ של החנות</a>` : `${demo}החיבור של המספר של החנות עוד לא פתוח.`;
}

async function page(app: App, r: DashReq, id: number) {
  const s = await app.db.one<any>('SELECT id, name, domain, brand, brand_override, demo_code, taken_down_at FROM stores WHERE id = $1', [id]);
  if (!s) return null;
  const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
  const a = await waAccountOf(app, id);
  const ready = waConnectReady(app.env);
  const m = metaSettings(app.env);
  const ro = r.ctx.readOnly;
  const live = a && a.status !== 'off';
  const tok = a ? tokenState(a) : null;
  // The token ends soon or has ended: the same window of Meta's connects the same number again (waStore.ts).
  const again = Boolean(live && tok && (tok.ended || tok.soon));
  const connectButton = (label: string) => ro ? '<p class="muted mt12 m0">במצב צפייה אי אפשר לחבר.</p>' : ready
    ? `<div class="mt16" data-wa-connect data-app-id="${esc(m.appId)}" data-config-id="${esc(m.configId)}" data-version="${esc(m.version)}" data-action="/lead/${id}/whatsapp/connect" data-csrf="${esc(r.ctx.csrf)}"><button class="btn primary" type="button" disabled>${icon('chat')}${label}</button><p class="small mt8 m0" data-msg role="status" aria-live="polite"></p></div>`
    : '<p class="muted mt12 m0">החיבור עוד לא פתוח בשרת. כתבו לנו, ונחבר יחד.</p>';
  const chip = a?.status === 'active' ? (tok?.soon ? ['sig', 'צריך לחבר מחדש'] : ['ok', 'מחובר']) : a?.status === 'pending' ? ['sig', 'ממתין לאישור של Meta'] : a?.status === 'reconnect' ? ['bad', 'צריך לחבר מחדש'] : ['bad', 'נעצר'];
  const until = a?.token_expires_at ? esc(stamp(a.token_expires_at)) : a?.token_checked_at ? 'בלי הגבלת זמן' : '';

  const state = live
    ? `<section class="panel"><header><h2>הוואטסאפ של ${esc(name)}</h2><span class="end chip ${chip[0]}">${chip[1]}</span></header>
  <p class="m0">${waLine(a, s, ready)}</p>
  ${a!.status === 'pending' ? '<p class="small muted mt8 m0">בודקים מול Meta כל עשר דקות. לרוב זה לוקח כמה דקות, לפעמים עד יום.</p>' : ''}
  ${again ? `<p class="small mt12 m0">מחברים מחדש באותו חלון של Meta, עם אותו מספר. השיחות נשארות, והוואטסאפ בטלפון לא משתנה.</p>${connectButton(AGAIN)}` : ''}
  <dl class="kv mt12"><dt>שם העסק ב-WhatsApp</dt><dd>${esc(a!.name || a!.meta?.verified_name || '-')}</dd><dt>חובר</dt><dd>${esc(stamp(a!.connected_at))}</dd>${until ? `<dt>החיבור בתוקף עד</dt><dd>${until}</dd>` : ''}</dl>
  <p class="small mt12 m0">כשעונים ללקוח מהטלפון, תורן מפסיק לענות בשיחה הזו, ורואים את התשובה גם כאן, בשיחות.</p>
  ${ro ? '' : `<div class="row mt12">${postButton(r.ctx, `/lead/${id}/whatsapp/disconnect`, 'לנתק את הוואטסאפ מתורן', { cls: 'btn sm danger', confirm: 'לנתק? תורן יפסיק לענות בוואטסאפ של החנות. הוואטסאפ בטלפון ממשיך לעבוד כרגיל.' })}</div>`}
</section>`
    : `<section class="panel"><header><h2>לפני שמחברים</h2></header>
  <ul class="m0">
    <li>הוואטסאפ של החנות הוא באפליקציית <b>WhatsApp Business</b>. אם זה הוואטסאפ הרגיל, מעבירים אותו ל-WhatsApp Business בחינם, והשיחות עוברות איתו.</li>
    <li>האפליקציה מעודכנת לגרסה האחרונה.</li>
    <li>המספר פעיל ב-WhatsApp Business כבר שבוע לפחות.</li>
    <li>יש לכם חשבון פייסבוק. נכנסים איתו לחלון של Meta.</li>
    <li>הטלפון עם הוואטסאפ של החנות לידכם, כדי לאשר בו.</li>
  </ul>
</section>
<section class="panel mt16"><header><h2>מה קורה בחלון של Meta</h2></header>
  <ol class="m0">
    <li>נכנסים לפייסבוק, ובוחרים את העסק, או יוצרים אותו.</li>
    <li>בוחרים לחבר את מספר ה-WhatsApp Business הקיים, ומקלידים אותו.</li>
    <li>ב-WhatsApp Business בטלפון מופיעה בקשה. מאשרים אותה עם הקוד שבחלון.</li>
  </ol>
  <p class="small mt12 m0">הוואטסאפ בטלפון ממשיך לעבוד כרגיל, ותורן עונה לצידו. כשאתם עונים ללקוח מהטלפון, תורן מפסיק לענות בשיחה הזו.</p>
  ${connectButton('לחבר את הוואטסאפ של החנות')}
</section>`;
  const body = `<a class="back" href="/settings#channels">${icon('chev')}הגדרות</a>
<div class="head"><div class="row">${storeBadge({ id: s.id, name, domain: s.domain })}<h1 class="title">הוואטסאפ של ${esc(name)}</h1></div><p class="sub">מחברים את המספר שכבר יש לחנות ב-WhatsApp Business, ותורן עונה בו ללקוחות.</p></div>
${live ? waBanner(a, id, { here: true }) : ''}
${state}
${ready && (!live || again) && !ro ? '<script src="/static/wa-connect.js?v=2" defer></script>' : ''}`;
  return layout({ ...r.ctx, title: `הוואטסאפ של ${name}`, active: 'settings' }, body);
}

export function whatsappRoutes(app: App): Route<DashReq>[] {
  return [
    ['GET', /^\/lead\/(\d+)\/whatsapp$/, async (r, m) => {
      const html = await page(app, r, Number(m[1]));
      if (!html) throw new ActionError('אין חנות כזו', 404);
      return { html, headers: { 'content-security-policy': connectCsp() } };
    }],
    ['POST', /^\/lead\/(\d+)\/whatsapp\/connect$/, async (r, m) => {
      const id = Number(m[1]);
      try {
        // The person who connects is who hears when the connection has to be made again (waStore.ts).
        const email = r.user.role === 'superadmin' ? null : r.user.email || null;
        const out = await connectWhatsapp(app, id, { code: r.form.code, phoneId: r.form.phone_number_id, wabaId: r.form.waba_id, businessId: r.form.business_id, event: r.form.event, by: r.user.name, email });
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
      await disconnectWhatsapp(app, id, r.user.name);
      return { redirect: `/lead/${id}/whatsapp`, message: 'הוואטסאפ נותק מתורן. בטלפון הוא ממשיך לעבוד כרגיל.' };
    }],
  ];
}
