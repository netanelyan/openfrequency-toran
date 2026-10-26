import type { App } from '../../app.ts';
import { displayName } from '../../ingest/brand.ts';
import { enabledChannels } from '../../channels/config.ts';
import { socialReady, type Social } from '../../channels/social.ts';
import { adminCookieDomain, beginConnect, CHANNEL_NAME, disconnectSocial, pagesToPick, pickPage } from '../../channels/socialStore.ts';
import { isCompany } from '../../company.ts';
import { ConnectError } from '../../channels/waStore.ts';
import { GraphError } from '../../channels/meta.ts';
import { SecretError } from '../../core/secrets.ts';
import { ActionError, DASH_CSP, viaAdminReq, type DashReq, type Route } from '../server.ts';
import { csrfField, esc, icon, layout, postButton, stamp, storeBadge } from '../ui.ts';

// A store connects its Facebook Page (Messenger) or Instagram account (channels/social.ts, socialStore.ts): the page
// under /lead/<id>/messenger and /lead/<id>/instagram, which server.ts opens to the store's own workspace (and our
// company store's to the operator, on /admin: operatorConnects), and
// 404 while TORAN_CHANNELS does not list the channel. Before the button, what to check so Meta's login does not stop
// halfway; the button sends the browser to Meta's login, which comes back to /meta/oauth/<channel> (public.ts) and
// then here, with what happened. Someone who manages more than one Page picks the store's here.
//
// The form's answer is a redirect to facebook.com or instagram.com, so this page's form-action lets those in.

const connectCsp = () => DASH_CSP.replace("form-action 'self'", "form-action 'self' https://www.facebook.com https://www.instagram.com");

export type SocialRow = { id: number; status: string; name: string | null; meta: any; connected_at: string };

export async function socialAccountOf(app: App, storeId: number, channel: Social): Promise<SocialRow | null> {
  return app.db.one<SocialRow>("SELECT id, status, name, meta, connected_at FROM channel_accounts WHERE store_id = $1 AND channel = $2 ORDER BY (status <> 'off') DESC, id DESC LIMIT 1", [storeId, channel]);
}

const WHAT: Record<Social, string> = { messenger: 'את הדף בפייסבוק', instagram: 'את האינסטגרם' };

/** One line on the store's Page or Instagram, for Today, Settings and the lead page. */
export function socialLine(a: SocialRow | null, channel: Social, s: { id: number }, ready: boolean): string {
  const name = a?.name ? `<bdi>${esc(a.name)}</bdi>` : '';
  if (a?.status === 'active') return `מחובר${name ? `, ${name}` : ''}. תורן עונה בו.`;
  if (a?.status === 'error') return `החיבור${name ? ` של ${name}` : ''} נעצר, ותורן לא עונה בו. <a href="/lead/${s.id}/${channel}">לחבר שוב</a>`;
  return ready ? `<a href="/lead/${s.id}/${channel}">לחבר ${WHAT[channel]}</a>` : 'בקרוב';
}

const ERRORS: Record<string, string> = {
  state: 'הקישור הזה כבר לא עובד. אפשר לחבר שוב.',
  expired: 'עבר יותר מדי זמן מאז שלחצתם על הכפתור. אפשר לחבר שוב.',
  browser: 'החיבור התחיל בדפדפן אחר. לוחצים על הכפתור באותו דפדפן שבו מאשרים.',
  cancelled: 'החלון נסגר בלי אישור. אפשר לנסות שוב.',
  no_pages: 'לא מצאנו דף בפייסבוק שהחשבון הזה מנהל. נכנסים עם החשבון שמנהל את הדף של החנות.',
  taken: 'החשבון הזה כבר מחובר לחנות אחרת בתורן. אם זו טעות, כתבו לנו.',
  meta: 'Meta לא השלימה את החיבור. אפשר לנסות שוב בעוד כמה דקות, ואם זה חוזר, כתבו לנו.',
};

const BEFORE: Record<Social, string[]> = {
  messenger: [
    'לחנות יש דף עסקי בפייסבוק, ולקוחות יכולים לשלוח לו הודעות.',
    'נכנסים עם חשבון הפייסבוק שמנהל את הדף, או שיש לו הרשאה לענות בו להודעות.',
  ],
  instagram: [
    'החשבון של החנות באינסטגרם הוא חשבון מקצועי (עסקי או של יוצר). אם הוא אישי, עוברים למקצועי בהגדרות של אינסטגרם, בחינם.',
    'בהגדרות של אינסטגרם, בהודעות, מאפשרים גישה להודעות לכלים מחוברים. בלי זה Meta לא מעבירה לתורן את ההודעות.',
    'נכנסים עם שם המשתמש והסיסמה של החשבון של החנות.',
  ],
};

const STEPS: Record<Social, string[]> = {
  messenger: ['נכנסים לפייסבוק.', 'מאשרים לתורן לקרוא את ההודעות של הדף ולענות בהן.', 'אם יש לכם כמה דפים, בוחרים כאן את הדף של החנות.'],
  instagram: ['נכנסים לאינסטגרם עם החשבון של החנות.', 'מאשרים לתורן לקרוא את ההודעות של החשבון ולענות בהן.'],
};

const OWN_REPLY: Record<Social, string> = {
  messenger: 'כשאתם עונים ללקוח בעצמכם, מתיבת ההודעות של הדף או מ־Meta Business Suite, תורן מפסיק לענות בשיחה הזו, ורואים את התשובה גם כאן, בשיחות.',
  instagram: 'כשאתם עונים ללקוח בעצמכם מהאפליקציה של אינסטגרם, תורן מפסיק לענות בשיחה הזו, ורואים את התשובה גם כאן, בשיחות.',
};

const WINDOW = 'Meta מאפשרת לענות רק עד 24 שעות מההודעה האחרונה של הלקוח. אחרי זה תורן לא עונה, ומה שנשאר פתוח מחכה לכם בשיחות.';

async function page(app: App, r: DashReq, id: number, channel: Social) {
  const s = await app.db.one<any>('SELECT id, name, domain, platform, brand, brand_override FROM stores WHERE id = $1', [id]);
  if (!s) return null;
  const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
  const a = await socialAccountOf(app, id, channel);
  const ready = socialReady(app.env, channel);
  const ro = r.ctx.readOnly;
  const live = a && a.status !== 'off';
  const q = r.url.searchParams;
  const ch = CHANNEL_NAME[channel];

  const banner = q.get('connected') === '1' && a?.status === 'active'
    ? `<div class="banner info">${icon('check')}<div><b>מחובר</b><p>תורן עונה מעכשיו ללקוחות שכותבים ל${esc(a.name || ch)}.</p></div></div>`
    : q.get('error') ? `<div class="banner bad">${icon('alert')}<div><b>החיבור לא הצליח</b><p>${esc(ERRORS[q.get('error')!] || ERRORS.meta)}</p></div></div>` : '';

  const pick = channel === 'messenger' && q.get('pick') && !ro ? await pagesToPick(app, id, q.get('pick')!, r.user.id) : null;
  const picker = pick?.length
    ? `<section class="panel"><header><h2>באיזה דף תורן יענה?</h2></header>
  <form method="post" action="/lead/${id}/messenger/pick">${csrfField(r.ctx)}<input type="hidden" name="state" value="${esc(q.get('pick')!)}">
    ${pick.map((p, i) => `<label class="row mt8"><input type="radio" name="page" value="${esc(p.id)}"${i === 0 ? ' checked' : ''}> <bdi>${esc(p.name)}</bdi></label>`).join('')}
    <div class="row mt12"><button class="btn primary" type="submit">${icon('check')}לחבר את הדף</button></div>
  </form>
</section>`
    : q.get('pick') ? `<div class="banner bad">${icon('alert')}<div><b>הבחירה כבר לא פתוחה</b><p>עבר יותר מדי זמן מהכניסה לפייסבוק. אפשר לחבר שוב.</p></div></div>` : '';

  const button = ro
    ? '<p class="muted mt12 m0">במצב צפייה אי אפשר לחבר.</p>'
    : r.scope.operator && !operatorConnects(app, r, s)
      ? `<p class="muted mt12 m0">${!isCompany(s) ? 'את זה מחברת החנות מהדשבורד שלה, עם החשבון שמנהל את הדף או את האינסטגרם.' : viaAdminReq(r.req) ? 'כדי לחבר מכאן, OF_ACCOUNTS_URL ו־PUBLIC_BASE_URL צריכים להיות באותו דומיין.' : 'את החנות שלנו מחברים מ־/admin באתר של החשבונות.'}</p>`
      : ready
        ? `<form class="mt16" method="post" action="/lead/${id}/${channel}/connect">${csrfField(r.ctx)}<button class="btn primary" type="submit">${icon('chat')}לחבר ${esc(WHAT[channel])}</button></form>`
        : '<p class="muted mt12 m0">החיבור עוד לא פתוח בשרת. כתבו לנו, ונחבר יחד.</p>';

  const state = live
    ? `<section class="panel"><header><h2>${esc(ch)} של ${esc(name)}</h2><span class="end chip ${a!.status === 'active' ? 'ok' : 'bad'}">${a!.status === 'active' ? 'מחובר' : 'נעצר'}</span></header>
  <p class="m0">${socialLine(a, channel, s, ready)}</p>
  <dl class="kv mt12"><dt>${channel === 'messenger' ? 'הדף' : 'החשבון'}</dt><dd><bdi>${esc(a!.name || '-')}</bdi></dd><dt>חובר</dt><dd>${esc(stamp(a!.connected_at))}</dd></dl>
  <p class="small mt12 m0">${esc(OWN_REPLY[channel])}</p>
  <p class="small mt8 m0">${esc(WINDOW)}</p>
  ${ro ? '' : `<div class="row mt12">${postButton(r.ctx, `/lead/${id}/${channel}/disconnect`, `לנתק את ה${ch} מתורן`, { cls: 'btn sm danger', confirm: `לנתק? תורן יפסיק לענות ב${ch}. ${channel === 'messenger' ? 'הדף' : 'החשבון'} עצמו ממשיך לעבוד כרגיל.` })}</div>`}
</section>`
    : `<section class="panel"><header><h2>לפני שמחברים</h2></header>
  <ul class="m0">${BEFORE[channel].map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
</section>
<section class="panel mt16"><header><h2>${channel === 'messenger' ? 'מה קורה בחלון של פייסבוק' : 'מה קורה בחלון של אינסטגרם'}</h2></header>
  <ol class="m0">${STEPS[channel].map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
  <p class="small mt12 m0">${esc(OWN_REPLY[channel])}</p>
  <p class="small mt8 m0">${esc(WINDOW)}</p>
  ${button}
</section>`;

  const body = `<a class="back" href="/settings#channels">${icon('chev')}הגדרות</a>
<div class="head"><div class="row">${storeBadge({ id: s.id, name, domain: s.domain })}<h1 class="title">${esc(ch)} של ${esc(name)}</h1></div><p class="sub">${channel === 'messenger' ? 'מחברים את הדף של החנות בפייסבוק, ותורן עונה ללקוחות שכותבים לו במסנג׳ר.' : 'מחברים את החשבון של החנות באינסטגרם, ותורן עונה ללקוחות שכותבים לו בהודעות.'}</p></div>
${banner}
${picker}
${state}`;
  return layout({ ...r.ctx, title: `${ch} של ${name}`, active: 'settings' }, body);
}

/**
 * Our company store's Page and Instagram are ours: the operator connects them, from /admin, where the cookie can be
 * set for the domain Toran's own name shares (socialStore.ts adminCookieDomain). Every other store connects its own.
 */
const operatorConnects = (app: App, r: DashReq, s: { platform?: string | null }) => isCompany(s) && viaAdminReq(r.req) && Boolean(adminCookieDomain(app.env));

const channelOf = (app: App, raw: string): Social => {
  const c = raw as Social;
  if (!enabledChannels(app.env).has(c)) throw new ActionError('לא נמצא', 404);
  return c;
};

export function socialRoutes(app: App): Route<DashReq>[] {
  return [
    ['GET', /^\/lead\/(\d+)\/(messenger|instagram)$/, async (r, m) => {
      const html = await page(app, r, Number(m[1]), channelOf(app, m[2]));
      if (!html) throw new ActionError('אין חנות כזו', 404);
      return { html, headers: { 'content-security-policy': connectCsp() } };
    }],
    ['POST', /^\/lead\/(\d+)\/(messenger|instagram)\/connect$/, async (r, m) => {
      const id = Number(m[1]);
      const channel = channelOf(app, m[2]);
      let domain: string | null = null;
      if (r.scope.operator) {
        const s = await app.db.one<{ platform: string | null }>('SELECT platform FROM stores WHERE id = $1', [id]);
        if (!s || !operatorConnects(app, r, s)) throw new ActionError('את זה מחברת החנות מהדשבורד שלה.', 403);
        domain = adminCookieDomain(app.env);
      }
      try {
        const { url, cookie } = await beginConnect(app, id, channel, r.user, { secure: r.secure, domain });
        return { redirect: url, headers: { 'set-cookie': cookie } };
      } catch (e: any) {
        if (e instanceof ConnectError) throw new ActionError(e.he);
        throw e;
      }
    }],
    ['POST', /^\/lead\/(\d+)\/messenger\/pick$/, async (r, m) => {
      const id = Number(m[1]);
      channelOf(app, 'messenger');
      try {
        await pickPage(app, id, String(r.form.state || ''), String(r.form.page || ''), r.user);
        return { redirect: '/lead/' + id + '/messenger?connected=1' };
      } catch (e: any) {
        if (e instanceof ConnectError) throw new ActionError(e.he);
        app.log(`[fb] pick for store ${id} failed: ${e?.message || e}`);
        if (e instanceof GraphError || e instanceof SecretError) throw new ActionError(ERRORS.meta);
        throw e;
      }
    }],
    ['POST', /^\/lead\/(\d+)\/(messenger|instagram)\/disconnect$/, async (r, m) => {
      const id = Number(m[1]);
      const channel = channelOf(app, m[2]);
      await disconnectSocial(app, id, channel, r.user.name);
      return { redirect: `/lead/${id}/${channel}`, message: `ה${CHANNEL_NAME[channel]} נותק מתורן.` };
    }],
  ];
}
