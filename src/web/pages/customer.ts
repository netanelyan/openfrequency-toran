import type { App } from '../../app.ts';
import { now } from '../../core/clock.ts';
import { audit } from '../../db/log.ts';
import { J } from '../../db/index.ts';
import { enqueue } from '../../jobs/queue.ts';
import { forgetStorePrompt } from '../../agent/loop.ts';
import { displayName } from '../../ingest/brand.ts';
import { ofWhatsapp } from '../../offer.ts';
import { counted, monthOf, PLANS, planOf, prevMonth, usageOf, type PlanKey, type Usage } from '../../plans.ts';
import { channelStates, CHANNEL_HE, enabledChannels, messagingSql, storeAddress, type AnyChannel } from '../../channels/config.ts';
import { accountsLinks } from '../accounts.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { csrfField, dayHe, esc, icon, layout, postButton, shortDate, stamp, storeBadge } from '../ui.ts';
import { storesOf, type Scope } from '../workspace.ts';
import { conversationRow, ROW_SQL, STATE_SQL, WAITING_SQL, type InboxState } from '../inbox.ts';
import { waAccountOf, waBanner, waLine } from './whatsapp.ts';
import { waConnectReady } from '../../channels/meta.ts';
import { socialReady } from '../../channels/social.ts';
import { socialAccountOf, socialLine } from './social.ts';
import { INGESTIBLE_HE, canIngest } from '../../ingest/catalogue.ts';
import { mailDomainPanel } from './mailDomain.ts';
import { orderAccessOf } from '../../orders.ts';
import { ordersOn, ordersPanel } from './orders.ts';
import { autoPanel } from './auto.ts';
import { KIND_KEYS, KINDS } from '../../auto/messages.ts';
import { settingsOf } from '../../auto/send.ts';
import { setupStoreOf, storeState } from '../../setup.ts';

// The customer's dashboard (docs/customer.md): what openfrequency.co.il/toran sells a store owner, on the pages they
// sign in to. Today (what waits for them, the month in numbers, the store's channels), the inbox (pages/home.ts, with
// the website's three words for where a conversation stands), what Toran knows about the store and the owner's own
// answers, the plan with this month's conversations, and the store's channels. The operator's pages (leads, the
// review queue, the follow-ups, a lead's page) are not theirs; server.ts sends a customer from them to these.

const TZ = 'Asia/Jerusalem';
const MONTH_START = `(date_trunc('month', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}')`;
/** The two weeks after a store's first channel is connected, when we read its conversations with the owner. */
const FIRST_DAYS = 14;

type Store = { id: number; name: string; domain: string; slug: string | null; platform: string; config: any; demo_code: string | null; taken_down_at: string | null; ingested_at: string | null; live_at: string | null };

/** The stores a customer page is about: the workspace's, or for the operator every customer's (never their own leads). */
export async function myStores(app: App, sc: Scope): Promise<Store[]> {
  const rows = await app.db.query<any>(`SELECT s.id, s.name, s.domain, s.slug, s.platform, s.config, s.brand, s.brand_override, s.demo_code, s.taken_down_at, s.ingested_at,
      (SELECT MIN(connected_at) FROM channel_accounts a WHERE a.store_id = s.id) AS live_at
    FROM stores s WHERE ${storesOf(sc, 's')}${sc.operator ? ' AND s.workspace_id IS NOT NULL' : ''} ORDER BY s.id LIMIT 50`);
  return rows.map((s) => ({ ...s, name: displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain }));
}

const num = (n: number) => Number(n || 0).toLocaleString('en-US');
const support = (app: App) => {
  const n = ofWhatsapp(app.env);
  return n ? `https://wa.me/${n}` : null;
};
const writeUs = (app: App, label = 'לכתוב לנו בוואטסאפ', cls = 'btn sm') => (support(app) ? `<a class="${cls}" href="${esc(support(app)!)}" target="_blank" rel="noopener">${icon('send')}${label}</a>` : '');

/** Each of the website's four channels for one store: connected, on our demo number, or still to come. */
async function channelsOf(app: App, s: Store): Promise<{ ch: AnyChannel; on: boolean; text: string }[]> {
  const accounts = await app.db.query<{ channel: string; external_id: string }>("SELECT channel, external_id FROM channel_accounts WHERE store_id = $1 AND status = 'active'", [s.id]);
  const has = (ch: string) => accounts.find((a) => a.channel === ch);
  const code = enabledChannels(app.env);
  const states = await channelStates(app.db);
  const wa = await waAccountOf(app, s.id);
  const mail = has('email');
  return [
    { ch: 'whatsapp', on: wa?.status === 'active', text: waLine(wa && wa.status !== 'off' ? wa : null, s, waConnectReady(app.env)) },
    { ch: 'email', on: Boolean(mail), text: mail ? `מחובר, <bdi class="ltr">${esc(mail.external_id)}</bdi>` : code.has('email') && app.mail ? 'לא מחובר. מחברים בהגדרות.' : 'בקרוב' },
    ...(await Promise.all((['instagram', 'messenger'] as const).map(async (ch) => {
      const a = await socialAccountOf(app, s.id, ch);
      return { ch, on: a?.status === 'active', text: socialLine(a && a.status !== 'off' ? a : null, ch, s, socialReady(app.env, ch)) };
    }))),
  ];
}

const channelList = (rows: { ch: AnyChannel; on: boolean; text: string }[]) => `<dl class="kv">${rows.map((c) => `<dt>${esc(CHANNEL_HE[c.ch])}</dt><dd>${c.text}</dd>`).join('')}</dl>`;

/** The first two weeks, while they last: the date they end. */
function firstWeeks(stores: Store[]): number | null {
  const ends = stores.map((s) => (s.live_at ? new Date(s.live_at).getTime() + FIRST_DAYS * 86_400_000 : 0)).filter((t) => t > now());
  return ends.length ? Math.max(...ends) : null;
}

/** May this session add its workspace's store from /start (pages/start.ts)? A customer's own, not view-as, not the operator. */
const mayStart = (r: DashReq) => !r.scope.operator && !r.ctx.readOnly && Number(r.scope.workspaceId) > 0;

/**
 * A workspace with no store yet: its site being read (the page reloads itself when the job ends, static/app.js), a try
 * that failed, or nothing yet, with the way to add it at /start. View-as sees the words without the button.
 */
async function setupPage(app: App, r: DashReq, title: string, active: string) {
  const st = Number(r.scope.workspaceId) > 0 ? storeState(await setupStoreOf(app, Number(r.scope.workspaceId))) : null;
  const add = mayStart(r) ? `<a class="btn sm primary" href="/start">${icon('plus')}להוסיף את החנות</a>` : '';
  const actions = (first: string) => (first || support(app) ? `<p class="mt12 m0">${first}${writeUs(app)}</p>` : '');
  const box = st?.status === 'working'
    ? `<div class="empty" data-wait-job="${st.job}">${icon('clock')}<b>קוראים את האתר שלכם</b>תורן קורא את המוצרים, המחירים ודפי המדיניות. זה לוקח דקה או שתיים, והדף יתעדכן לבד.</div>`
    : st?.status === 'attention'
      ? `<div class="empty">${icon('alert')}<b>לא הצלחנו לקרוא את האתר</b>כדאי לבדוק שהכתובת נכונה ולנסות שוב. אם זה חוזר, כתבו לנו.${actions(mayStart(r) ? `<a class="btn sm primary" href="/start">${icon('refresh')}לנסות שוב</a>` : '')}</div>`
      : `<div class="empty">${icon('clock')}<b>החנות שלכם עוד בהקמה</b>${add ? 'כותבים את הכתובת של האתר, ותורן קורא ממנו את המוצרים ואת דפי המדיניות. אחר כך תראו כאן את השיחות, מה תורן יודע על החנות ואת החבילה.' : 'כשהחנות תתחבר, תראו כאן את השיחות, מה תורן יודע על החנות ואת החבילה.'}${actions(add)}</div>`;
  return layout({ ...r.ctx, title, active }, `<div class="head"><h1>${esc(title)}</h1></div>
${box}`);
}

/** On Today while the store's site is read for the first time, or cannot be: a banner above the rest. */
async function readingBanner(app: App, r: DashReq): Promise<string> {
  if (!(Number(r.scope.workspaceId) > 0)) return '';
  const st = storeState(await setupStoreOf(app, Number(r.scope.workspaceId)));
  if (st.status === 'working') return `<div class="banner info" data-wait-job="${st.job}">${icon('clock')}<div><b>קוראים את האתר שלכם</b><p>זה לוקח דקה או שתיים. אחר כך תראו ב<a href="/knowledge">מה תורן יודע</a> את המוצרים ואת דפי המדיניות שנקראו.</p></div></div>`;
  if (st.status === 'attention') return `<div class="banner warn">${icon('alert')}<div><b>לא הצלחנו לקרוא את האתר</b><p>${esc(st.detail)}</p></div>${writeUs(app)}</div>`;
  return '';
}

// ---- Today

async function today(app: App, r: DashReq) {
  const stores = await myStores(app, r.scope);
  if (!stores.length) return setupPage(app, r, 'היום', 'today');
  const reading = await readingBanner(app, r);
  const ids = stores.map((s) => s.id).join(', ');
  const many = stores.length > 1;
  const nameOf = new Map(stores.map((s) => [s.id, s.name]));
  const waiting = await app.db.query<any>(`SELECT ${ROW_SQL}, c.store_id FROM conversations c WHERE ${messagingSql('c.channel')} AND c.store_id IN (${ids}) AND ${WAITING_SQL} ORDER BY c.last_at DESC LIMIT 10`);
  const recent = await app.db.query<any>(`SELECT ${ROW_SQL}, c.store_id FROM conversations c WHERE ${messagingSql('c.channel')} AND c.store_id IN (${ids}) AND NOT ${WAITING_SQL} ORDER BY c.last_at DESC LIMIT 5`);
  const month = await app.db.one<Record<InboxState, number>>(`SELECT COUNT(*) FILTER (WHERE state = 'alone')::int AS alone, COUNT(*) FILTER (WHERE state = 'fixed')::int AS fixed, COUNT(*) FILTER (WHERE state = 'waiting')::int AS waiting
    FROM (SELECT ${STATE_SQL} AS state FROM conversations c WHERE ${messagingSql('c.channel')} AND c.store_id IN (${ids}) AND c.last_at >= ${MONTH_START}) x`);
  const usage = await usages(app, stores);
  const used = usage.reduce((a, u) => a + u.usage.thisMonth, 0);
  const cap = usage.reduce((a, u) => a + u.usage.cap, 0);
  const waitingAll = r.ctx.waiting?.chats ?? waiting.length;
  const row = (c: any) => conversationRow({ ...c, store: many ? nameOf.get(c.store_id) : null });
  const weeks = firstWeeks(stores);
  const channels = await Promise.all(stores.map(async (s) => ({ s, rows: await channelsOf(app, s) })));
  // A store's WhatsApp that has to be connected again (channels/waStore.ts) comes first: customers are waiting on it.
  const reconnect = (await Promise.all(stores.map(async (s) => waBanner(await waAccountOf(app, s.id), s.id)))).join('');

  const body = `<div class="head"><h1>היום</h1><p class="sub">${esc(dayHe(now()))}${many ? '' : ` · ${esc(stores[0].name)}`}</p></div>
${reading}${reconnect}
${weeks ? `<div class="banner info">${icon('chat')}<div><b>בשבועיים הראשונים אנחנו עוברים איתכם על השיחות</b><p>עד ${esc(shortDate(weeks))} אנחנו קוראים כל שיחה, ומתקנים איתכם מה שתורן ענה לא נכון או לא ידע. ${writeUs(app, 'לכתוב לנו על שיחה')}</p></div></div>` : ''}
<div class="kpis">
  <a class="kpi lead" href="/chats?state=waiting"><span class="l">${waitingAll === 1 ? 'שאלה מחכה לכם' : 'שאלות מחכות לכם'}</span><span class="v">${waitingAll}</span><span class="s">${waitingAll ? 'מה שאין עליו תשובה באתר, ותורן העביר אליכם' : 'כל מה שנשאל קיבל תשובה'}</span></a>
  <div class="kpi side">
    <a href="/plan"><span class="l">שיחות החודש</span><span class="cnt num ltr">${num(used)} / ${num(cap)}</span></a>
    <a href="/chats?state=alone"><span class="l">ענה לבד החודש</span><span class="cnt ${month?.alone ? 'ok' : 'zero'}">${month?.alone || 0}</span></a>
    <a href="/chats?state=fixed"><span class="l">תיקנתם החודש</span><span class="cnt ${month?.fixed ? 'sig' : 'zero'}">${month?.fixed || 0}</span></a>
  </div>
</div>
<section class="group"><header><h2>מחכות לכם</h2>${waitingAll > waiting.length ? `<a class="end small" href="/chats?state=waiting">כולן</a>` : ''}</header>
  ${waiting.length ? `<div class="list">${waiting.map(row).join('')}</div><p class="small muted mt8 m0">כשעונים ללקוח מהשיחה, אפשר לשמור את התשובה, ותורן יענה ככה בפעם הבאה.</p>` : `<div class="empty">${icon('check')}<b>אין שאלות שמחכות לכם</b>כשלקוח שואל משהו שאין עליו תשובה באתר, תורן אומר לו שהוא בודק, והשאלה מגיעה לכאן.</div>`}
</section>
<section class="group mt24"><header><h2>שיחות אחרונות</h2><a class="end small" href="/chats">כל השיחות</a></header>
  ${recent.length ? `<div class="list">${recent.map(row).join('')}</div>` : `<div class="empty">${icon('chat')}<b>עוד אין שיחות</b>שיחה מופיעה כאן מהרגע שלקוח כותב לחנות באחד הערוצים המחוברים.</div>`}
</section>
<section class="group mt24"><header><h2>הערוצים</h2><a class="end small" href="/settings#channels">הגדרות</a></header>
  ${channels.map(({ s, rows }) => `<div class="panel${many ? ' mt12' : ''}">${many ? `<header><h3>${esc(s.name)}</h3></header>` : ''}${channelList(rows)}</div>`).join('')}
</section>
<section class="group mt24"><header><h2>לשאול את תורן על החנות</h2></header>
  <div class="panel"><p class="m0">מה קרה היום, על מה לקוחות שואלים, מה אזל מהמלאי. תורן עונה לכם מתוך השיחות והאתר, ועושה משהו רק אחרי שתכתבו לו כן.</p><p class="mt12 m0"><a class="btn sm" href="/assistant">${icon('spark')}לעוזר</a></p></div>
</section>`;
  return layout({ ...r.ctx, title: 'היום', active: 'today' }, body);
}

async function usages(app: App, stores: Store[]): Promise<{ s: Store; usage: Usage; months: Map<string, number> }[]> {
  const n = await counted(app.db, stores.map((s) => s.id), { months: 3 });
  return stores.map((s) => ({ s, usage: usageOf(planOf(s.config), n.get(s.id)), months: n.get(s.id) || new Map() }));
}

// ---- What Toran knows

const ANSWERS_ALONE = ['מחיר, מבצע ומלאי של מוצר, ישר מדף המוצר', 'מידות, צבעים ומה שכתוב בתיאור', 'משלוחים, החזרות ותשלום, לפי דפי המדיניות שבאתר', 'אם יש בחנות מוצר מסוים', 'לקוחות שכותבים באנגלית'];
const LEAVES_YOU = ['שאלה שאין עליה תשובה באתר', 'בקשה להנחה או להחזר כספי', 'איפה הזמנה מסוימת נמצאת'];
// Once the store's orders are connected (pages/orders.ts), where an order is moves to what Toran answers alone.
const ORDER_ALONE = 'איפה ההזמנה, למי שנותן את המייל או הטלפון שבה';
const ORDER_LEAVES = 'שינוי, ביטול או החזרה של הזמנה';
const POLICY_HE: Record<string, string> = { shipping: 'משלוחים', returns: 'החזרות', payment: 'תשלום', contact: 'יצירת קשר', about: 'אודות', faq: 'שאלות', other: 'אחר' };

async function knowledge(app: App, r: DashReq, id: number) {
  const s = (await myStores(app, r.scope)).find((x) => x.id === id);
  if (!s) return null;
  // The setup checklist's "בודקים את התשובות" (src/setup.ts): the owner has looked, once there is something to see.
  // Only the store's own people count: not the operator, not view-as.
  if (!r.scope.operator && !r.ctx.readOnly && s.ingested_at) await app.db.query('UPDATE stores SET knowledge_seen_at = now() WHERE id = $1 AND knowledge_seen_at IS NULL', [id]);
  const pack = await app.db.one<any>('SELECT (SELECT COUNT(*)::int FROM products WHERE store_id = $1 AND gone_at IS NULL) AS products, (SELECT COUNT(*)::int FROM products WHERE store_id = $1 AND gone_at IS NULL AND available) AS available', [id]);
  const policies = await app.db.query<any>('SELECT id, kind, title, url, text, override_text FROM policies WHERE store_id = $1 ORDER BY kind, id', [id]);
  const mine = await app.db.query<any>('SELECT id, question, answer, site_answer, conversation_id, created_at FROM faqs WHERE store_id = $1 AND answer IS NOT NULL ORDER BY id DESC', [id]);
  const site = await app.db.query<any>('SELECT id, question, site_answer FROM faqs WHERE store_id = $1 AND answer IS NULL AND site_answer IS NOT NULL ORDER BY id', [id]);
  const job = await app.db.one<any>('SELECT status FROM jobs WHERE dedupe_key = $1 ORDER BY id DESC LIMIT 1', [`ingest:${id}`]);
  const reading = job && ['queued', 'running'].includes(job.status);
  const ro = r.ctx.readOnly;
  const orders = ordersOn(await orderAccessOf(app.db, id));
  const ordersBox = await ordersPanel(app, r, s, writeUs(app));

  const answer = (x: any) => `<form class="mt12" method="post" action="/lead/${id}/faq/${x.id}">${csrfField(r.ctx)}<label class="f">${esc(x.question)}${x.conversation_id ? `<small>מהתשובה שלכם <a href="/chat/${x.conversation_id}">בשיחה</a>, ${esc(shortDate(x.created_at))}</small>` : ''}<textarea name="answer" rows="2" dir="auto" maxlength="2000"${ro ? ' readonly' : ''}>${esc(x.answer)}</textarea></label>${ro ? '' : '<div class="row mt8"><button class="btn sm" type="submit">לשמור</button></div>'}</form>`;
  const body = `<div class="head"><div class="row">${storeBadge({ id: s.id, name: s.name, domain: s.domain })}<h1 class="title">מה תורן יודע על ${esc(s.name)}</h1></div><p class="sub">תורן עונה ללקוחות רק ממה שכתוב באתר ומהתשובות שלכם כאן. ${s.ingested_at ? `האתר נקרא לאחרונה ${esc(stamp(s.ingested_at))}, ונקרא שוב כל יום.` : 'האתר עוד לא נקרא.'}</p></div>
${reading ? `<div class="banner info">${icon('clock')}<div><b>קורא את האתר עכשיו</b><p>זה לוקח דקה או שתיים. מה שהשתנה באתר ייכנס לתשובות של תורן מיד אחרי.</p></div></div>` : ''}
<div class="cols">
  <div class="grid12">
    <section class="panel"><header><h2>מה הוא עונה לבד, ומה הוא משאיר לכם</h2></header>
      <h3 class="small mt8">עונה לבד</h3><ul class="m0">${(orders ? [...ANSWERS_ALONE, ORDER_ALONE] : ANSWERS_ALONE).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <h3 class="small mt16">משאיר לכם</h3><ul class="m0">${(orders ? LEAVES_YOU.map((x) => (x === LEAVES_YOU[2] ? ORDER_LEAVES : x)) : LEAVES_YOU).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <p class="small muted mt12 m0">כשאין באתר תשובה, הוא אומר ללקוח שהוא בודק, במקום לנחש, והשאלה מגיעה אליכם ל<a href="/chats?state=waiting">שיחות</a>.</p>
    </section>
    <section class="panel" id="answers"><header><h2>התשובות שלכם</h2><span class="end small muted">${mine.length}</span></header>
      <p class="small muted m0">תורן עונה לפי התשובות האלה לפני מה שכתוב באתר. מוחקים תשובה כששומרים אותה ריקה.</p>
      ${mine.length ? mine.map(answer).join('') : '<p class="muted mt12 m0">עוד אין. כשאתם עונים ללקוח על שאלה שתורן העביר אליכם, אפשר לשמור את התשובה, והיא נכנסת לכאן.</p>'}
      ${ro ? '' : `<details class="mt16"><summary class="btn sm">${icon('plus')}להוסיף שאלה ותשובה</summary><form class="mt12" method="post" action="/lead/${id}/faq">${csrfField(r.ctx)}<label class="f">השאלה, כמו שלקוח היה שואל<input type="text" name="question" dir="auto" required maxlength="300"></label><label class="f mt8">התשובה<textarea name="answer" rows="2" dir="auto" required maxlength="2000"></textarea></label><button class="btn sm mt8" type="submit">לשמור</button></form></details>`}
    </section>
    ${site.length ? `<section class="panel"><header><h2>שאלות ותשובות שנמצאו באתר</h2><span class="end small muted">${site.length}</span></header>
      <details><summary class="small">להציג</summary>${site.map((x) => `<form class="mt12" method="post" action="/lead/${id}/faq/${x.id}">${csrfField(r.ctx)}<label class="f">${esc(x.question)}<small>באתר: ${esc(String(x.site_answer).slice(0, 300))}</small>${ro ? '' : '<textarea name="answer" rows="2" dir="auto" maxlength="2000" placeholder="תשובה אחרת משלכם, אם זו באתר כבר לא נכונה"></textarea>'}</label>${ro ? '' : '<button class="btn sm mt8" type="submit">לשמור</button>'}</form>`).join('')}</details>
    </section>` : ''}
  </div>
  <div class="grid12">
    <section class="panel"><header><h2>מה נקרא מהאתר</h2></header>
      <dl class="kv"><dt>אתר</dt><dd><bdi class="ltr">${esc(s.domain)}</bdi></dd><dt>מוצרים</dt><dd>${num(pack?.products)}${pack?.products ? `, ${num(pack.available)} מהם במלאי` : ''}</dd><dt>דפי מדיניות</dt><dd>${policies.length}</dd><dt>התשובות שלכם</dt><dd>${mine.length}</dd></dl>
      ${ro || !canIngest(s.platform) ? '' : `<div class="row mt12">${postButton(r.ctx, `/lead/${id}/reread`, 'לקרוא את האתר שוב עכשיו', { cls: 'btn sm', iconName: 'refresh' })}</div><p class="small muted mt8 m0">שיניתם מחיר, מלאי או מדיניות באתר? תורן קורא את האתר כל יום, ואפשר גם עכשיו.</p>`}
    </section>
    ${ordersBox}
    <section class="panel"><header><h2>דפי המדיניות שתורן קורא</h2></header>
      ${policies.length ? policies.map((p) => `<details class="mt8"><summary><b>${esc(p.title)}</b> <span class="chip">${esc(POLICY_HE[p.kind] || p.kind)}</span>${p.override_text ? ' <span class="chip sig">הטקסט שלכם</span>' : ''}</summary>
        ${p.url ? `<p class="small mt8 m0"><a href="${esc(p.url)}" target="_blank" rel="noopener">${icon('ext')}בדף באתר</a></p>` : ''}
        <form method="post" action="/lead/${id}/policy/${p.id}" class="mt8">${csrfField(r.ctx)}<label class="f">הטקסט שתורן קורא במקום מה שבאתר. ריק, והוא קורא את האתר<textarea name="override_text" rows="6" dir="auto"${ro ? ' readonly' : ''}>${esc(p.override_text || '')}</textarea></label>
        <details class="mt8"><summary class="small">מה כתוב באתר</summary><blockquote class="q mt8">${esc(String(p.text).slice(0, 3000))}</blockquote></details>
        ${ro ? '' : '<button class="btn sm mt8" type="submit">לשמור</button>'}</form></details>`).join('') : '<p class="muted m0">לא נמצאו באתר דפי מדיניות, אז כל שאלה על משלוח, החזרה או תשלום מגיעה אליכם. אם יש לכם דף כזה, כתבו לנו את הכתובת שלו.</p>'}
    </section>
  </div>
</div>`;
  return layout({ ...r.ctx, title: `מה תורן יודע על ${s.name}`, active: 'knowledge' }, body);
}

// ---- The plan

/** Which channels each automatic message is on, across the account's stores (auto/send.ts): "בוואטסאפ ובמייל". */
async function autoOn(app: App, stores: Store[]): Promise<Record<string, string[]>> {
  const on: Record<string, Set<string>> = Object.fromEntries(KIND_KEYS.map((k) => [k, new Set<string>()]));
  for (const s of stores) {
    const st = await settingsOf(app, s.id);
    for (const k of KIND_KEYS) {
      if (st[k].whatsapp) on[k].add('וואטסאפ');
      if (st[k].email) on[k].add('מייל');
    }
  }
  return Object.fromEntries(KIND_KEYS.map((k) => [k, [...on[k]]]));
}

const INCLUDED = (app: App, live: string[], weeks: number | null, auto: Record<string, string[]>) => [
  { text: 'עונה ללקוחות 24/7 בערוצים הפעילים, מתוך מה שכתוב באתר שלכם', state: live.length ? `<span class="chip ok">פעיל ב${esc(live.join(' וב'))}</span>` : '<span class="chip ghost">מחכה לחיבור של ערוץ</span>' },
  { text: 'כל השיחות בתיבה אחת, ושאלה שאין עליה תשובה באתר מגיעה אליכם', state: '<a class="chip ok" href="/chats">פעיל</a>' },
  { text: 'תזכורות על עגלה נטושה, למי שהסכים לקבל מכם הודעות', state: auto.cart.length ? `<a class="chip ok" href="/settings#auto">פעיל ב${esc(auto.cart.join(' וב'))}</a>` : '<a class="chip ghost" href="/settings#auto">כבוי, מפעילים בהגדרות</a>' },
  { text: 'הודעות על תשלום ומשלוח, ובקשה לביקורת אחרי שההזמנה הגיעה', state: (['payment', 'shipping', 'review'] as const).some((k) => auto[k].length) ? `<a class="chip ok" href="/settings#auto">פעיל: ${esc((['payment', 'shipping', 'review'] as const).filter((k) => auto[k].length).map((k) => KINDS[k].he).join(', '))}</a>` : '<a class="chip ghost" href="/settings#auto">כבוי, מפעילים בהגדרות</a>' },
  { text: 'בשבועיים הראשונים אנחנו עוברים איתכם על השיחות ומתקנים מה שצריך', state: weeks ? `<span class="chip ok">עד ${esc(shortDate(weeks))}</span>` : '<span class="chip ghost">מתחיל כשהערוץ הראשון מתחבר</span>' },
];

const monthHe = (m: string) => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, month: 'long' }).format(new Date(`${m}-15T12:00:00Z`));

async function plan(app: App, r: DashReq) {
  const stores = await myStores(app, r.scope);
  if (!stores.length) return setupPage(app, r, 'החבילה', 'plan');
  const list = await usages(app, stores);
  const month = monthOf(now());
  const months = [month, prevMonth(month), prevMonth(prevMonth(month))];
  const live = new Set<string>();
  for (const s of stores) for (const c of await channelsOf(app, s)) if (c.on) live.add(CHANNEL_HE[c.ch]);
  const owner = r.user.role !== 'client_member';
  const links = accountsLinks(app.env);

  const storePanel = ({ s, usage, months: byMonth }: { s: Store; usage: Usage; months: Map<string, number> }) => {
    const pct = Math.min(10, Math.round((usage.thisMonth / usage.cap) * 10));
    return `<section class="panel"><header><h2>${stores.length > 1 ? `${esc(s.name)}, ` : ''}חבילת ${esc(PLANS[usage.plan].he)}</h2><span class="end chip">עד ${num(usage.cap)} שיחות בחודש</span></header>
  <div class="kpi lead flat"><span class="l">שיחות ב${esc(monthHe(month))}, עד היום</span><span class="v num">${num(usage.thisMonth)}</span><span class="s"><span class="vbar wide"><i class="w${pct}"></i></span> מתוך ${num(usage.cap)}</span></div>
  ${usage.note ? `<div class="banner ${usage.thisMonth > usage.cap ? 'warn' : 'info'} mt12">${icon('alert')}<div><p>${esc(usage.note)}</p></div>${usage.plan === 'big' && usage.thisMonth > usage.cap ? writeUs(app) : ''}</div>` : ''}
  <dl class="kv mt12">${months.slice(1).map((m) => `<dt>${esc(monthHe(m))}</dt><dd>${num(byMonth.get(m) || 0)} שיחות</dd>`).join('')}</dl>
</section>`;
  };

  const body = `<div class="head"><h1>החבילה</h1><p class="sub">כמה שיחות היו החודש, ומה יש בחבילה. המחיר, החשבוניות והתשלום נמצאים בחשבון שלכם ב-OpenFrequency.</p><div class="end"><a class="btn sm" href="${esc(links.home)}">${icon('ext')}לחשבון</a></div></div>
<div class="cols">
  <div class="grid12">
    ${list.map(storePanel).join('')}
    <section class="panel"><header><h2>מה יש בחבילה</h2></header>
      <ul class="keys">${INCLUDED(app, [...live], firstWeeks(stores), await autoOn(app, stores)).map((x) => `<li><span>${esc(x.text)}</span><span class="end">${x.state}</span></li>`).join('')}</ul>
    </section>
  </div>
  <div class="grid12">
    <section class="panel"><header><h2>מה נחשב שיחה</h2></header>
      <p class="m0">שיחה היא לקוח אחד שכתב לחנות באחד הערוצים שלה. כל עוד הוא ממשיך לכתוב, או חוזר תוך שבוע, זו אותה שיחה. במייל, שיחה היא שרשור אחד. שיחה נספרת בחודש שבו הלקוח כתב בה. שיחות על מספר הדמו שלנו לא נספרות.</p>
    </section>
    <section class="panel"><header><h2>כשמספר השיחות משתנה</h2></header>
      <p class="m0">חודש עמוס אחד לא עולה לכם יותר. רק אחרי חודשיים ברצף מעל ${num(PLANS.store.conversations)} שיחות, החנות עוברת לחבילה הגדולה, עד ${num(PLANS.big.conversations)} שיחות בחודש, ואנחנו כותבים לכם בוואטסאפ שבוע לפני. אחרי חודשיים ברצף מתחת ל-${num(PLANS.store.conversations)} שיחות, היא חוזרת לחבילת חנות.</p>
    </section>
    <section class="panel" id="stop"><header><h2>להפסיק</h2></header>
      <p class="m0">אין התחייבות, משלמים חודש בחודש. כדי להפסיק, כותבים לנו. תורן עונה עד סוף החודש האחרון ששילמתם, ומספר הוואטסאפ של החנות נשאר שלכם. את השיחות אנחנו שומרים עוד 30 יום, כדי שתוכלו להוריד אותן, ואחר כך מוחקים אותן.</p>
      <div class="row mt12">${writeUs(app)}${owner ? `<a class="btn sm" href="/export/conversations.csv">${icon('copy')}להוריד את כל השיחות</a>` : ''}</div>
      ${owner ? '<p class="small muted mt8 m0">קובץ CSV שנפתח באקסל: כל הודעה בשורה, עם הערוץ, הלקוח, השעה ומי כתב.</p>' : '<p class="small muted mt8 m0">את השיחות מוריד מי שפתח את החשבון.</p>'}
    </section>
  </div>
</div>`;
  return layout({ ...r.ctx, title: 'החבילה', active: 'plan' }, body);
}

// ---- The customer's settings: the store's channels, and the account

export async function customerSettings(app: App, r: DashReq) {
  const stores = await myStores(app, r.scope);
  const mailOn = enabledChannels(app.env).has('email') && Boolean(app.mail);
  const links = accountsLinks(app.env);
  const panels = await Promise.all(stores.map(async (s) => {
    const mail = mailOn ? await app.db.one<any>("SELECT external_id, status FROM channel_accounts WHERE store_id = $1 AND channel = 'email' ORDER BY id DESC LIMIT 1", [s.id]) : null;
    const on = mail?.status === 'active';
    const address = mailOn ? storeAddress(s, app.mail!.domain) : '';
    const email = !mailOn ? '' : on
      ? `<h3 class="small mt16">המייל</h3><p class="small m0">מעבירים לכתובת <bdi class="ltr">${esc(mail.external_id)}</bdi> את המייל של החנות, למשל ב-Gmail: הגדרות, "העברה ו-POP/IMAP", "הוספת כתובת להעברה". Gmail שולח לשם קוד אישור, והוא מופיע אצלכם בשיחות. תורן עונה משם בשם החנות.</p>${r.ctx.readOnly ? '' : `<div class="row mt8">${postButton(r.ctx, `/lead/${s.id}/channels/email`, 'לנתק את המייל', { cls: 'btn sm danger', fields: { on: '0' }, confirm: 'לנתק? מיילים שיגיעו לכתובת יישמרו, ותורן לא יענה עליהם.' })}</div>`}${await mailDomainPanel(app, r, s.id, mail.external_id)}`
      : `<h3 class="small mt16">המייל</h3><p class="small m0">החנות מקבלת כתובת משלה, <bdi class="ltr">${esc(address)}</bdi>, ומעבירה אליה את המייל שלה. תורן עונה משם בשם החנות, ומה שהוא לא יודע מגיע אליכם.</p>${r.ctx.readOnly ? '' : `<div class="row mt8">${postButton(r.ctx, `/lead/${s.id}/channels/email`, 'לחבר את המייל', { cls: 'btn sm primary', fields: { on: '1' } })}</div>`}`;
    return `<section class="panel" id="channels"><header><h2>הערוצים של ${esc(s.name)}</h2></header>${channelList(await channelsOf(app, s))}${email}
  <p class="small muted mt12 m0">רוצים לעצור את תורן בערוץ אחד, או בכולם? ${support(app) ? `<a href="${esc(support(app)!)}" target="_blank" rel="noopener">כתבו לנו בוואטסאפ</a>` : 'כתבו לנו'}, ואנחנו מכבים אותו. בשיחה אחת עוצרים אותו מכאן, כשעונים בה בעצמכם.</p></section>${await autoPanel(app, r, s)}`;
  }));
  const body = `<div class="head"><h1>הגדרות</h1></div>
<div class="cols">
  <div class="grid12">${panels.join('') || `<div class="empty">${icon('clock')}<b>החנות שלכם עוד בהקמה</b>הערוצים יופיעו כאן כשהחנות תתחבר.${mayStart(r) ? `<p class="mt12 m0"><a class="btn sm primary" href="/start">${icon('plus')}להוסיף את החנות</a></p>` : ''}</div>`}</div>
  <div class="grid12">
    <section class="panel"><header><h2>החשבון</h2></header><p class="small m0">מי בחשבון, מספרי הוואטסאפ שמהם כותבים לעוזר, החבילה והחשבוניות נמצאים בחשבון שלכם ב-OpenFrequency.</p><div class="row mt12"><a class="btn sm" href="${esc(links.home)}">${icon('ext')}לחשבון</a></div></section>
    <a class="btn ghost" href="${esc(r.ctx.logout || '/')}">${icon('logout')}יציאה</a>
  </div>
</div>
<p class="ver">תורן · גרסה 0.1</p>`;
  return layout({ ...r.ctx, title: 'הגדרות', active: 'settings' }, body);
}

// ---- The export: every conversation, for the owner to keep

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  // A cell a spreadsheet would run as a formula starts with a quote instead.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const ROLE_HE: Record<string, string> = { customer: 'לקוח', agent: 'תורן', owner: 'אתם', system: 'הערה' };

async function exportCsv(app: App, r: DashReq) {
  const stores = await myStores(app, r.scope);
  const ids = stores.map((s) => s.id);
  const nameOf = new Map(stores.map((s) => [s.id, s.name]));
  const rows = ids.length
    ? await app.db.query<any>(`SELECT c.id AS conversation, c.store_id, c.channel, c.peer, c.meta->>'subject' AS subject, m.at, m.role, m.text FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE ${messagingSql('c.channel')} AND c.store_id IN (${ids.join(', ')}) ORDER BY c.id, m.id`)
    : [];
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const lines = [['חנות', 'שיחה', 'ערוץ', 'לקוח', 'נושא', 'שעה', 'מי כתב', 'הודעה'].join(',')];
  for (const x of rows) lines.push([nameOf.get(x.store_id), x.conversation, CHANNEL_HE[x.channel as AnyChannel] || x.channel, x.peer, x.subject, fmt.format(new Date(x.at)), ROLE_HE[x.role] || x.role, x.text].map(csvCell).join(','));
  await audit(app.db, { actor: r.user.name, action: 'export_conversations', detail: { stores: ids, messages: rows.length } });
  return { body: Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8'), type: 'text/csv; charset=utf-8', headers: { 'content-disposition': `attachment; filename="toran-conversations-${monthOf(now())}.csv"` } };
}

/** The customer's way into a page about one store: one store goes straight to it, more than one gets a list. */
async function pick(app: App, r: DashReq, path: string, title: string, active: string) {
  const stores = await myStores(app, r.scope);
  if (stores.length === 1) return { redirect: `/lead/${stores[0].id}/${path}` };
  if (!stores.length) return { html: await setupPage(app, r, title, active) };
  return { html: layout({ ...r.ctx, title, active }, `<div class="head"><h1>${esc(title)}</h1></div><div class="list">${stores.map((s) => `<a href="/lead/${s.id}/${path}">${storeBadge({ id: s.id, name: s.name, domain: s.domain })}<span class="t"><b>${esc(s.name)}</b><small class="ltr">${esc(s.domain)}</small></span><span class="go">${icon('chev')}</span></a>`).join('')}</div>`) };
}

export { today as customerToday };

export function customerRoutes(app: App): Route<DashReq>[] {
  return [
    ['GET', /^\/knowledge$/, (r) => pick(app, r, 'knowledge', 'מה תורן יודע', 'knowledge')],
    ['GET', /^\/lead\/(\d+)\/knowledge$/, async (r, m) => {
      const html = await knowledge(app, r, Number(m[1]));
      if (!html) throw new ActionError('אין חנות כזו', 404);
      return { html };
    }],
    ['POST', /^\/lead\/(\d+)\/reread$/, async (r, m) => {
      const id = Number(m[1]);
      const s = await app.db.one<{ platform: string }>('SELECT platform FROM stores WHERE id = $1', [id]);
      if (!canIngest(s?.platform)) throw new ActionError(`כרגע תורן קורא רק חנויות ${INGESTIBLE_HE}.`);
      // A rescrape: the store's knowledge again, and the demo page the operator approved left as it is.
      await enqueue(app.db, 'rescrape', { storeId: id }, { dedupeKey: `ingest:${id}` });
      await audit(app.db, { actor: r.user.name, action: 'reread', storeId: id });
      return { redirect: `/lead/${id}/knowledge`, message: 'קורא את האתר. זה לוקח דקה או שתיים.' };
    }],
    ['GET', /^\/plan$/, async (r) => ({ html: await plan(app, r) })],
    ['GET', /^\/export\/conversations\.csv$/, async (r) => {
      if (r.user.role === 'client_member') throw new ActionError('את השיחות מוריד מי שפתח את החשבון.', 403);
      return exportCsv(app, r);
    }],
    // "טיפלתי בזה": what waits in a conversation is handled without an answer from here (the owner called, or it needs nothing).
    ['POST', /^\/chat\/(\d+)\/settle$/, async (r, m) => {
      const id = Number(m[1]);
      await app.db.query('UPDATE conversations SET settled_upto = COALESCE((SELECT MAX(id) FROM messages WHERE conversation_id = $1), 0) WHERE id = $1', [id]);
      await audit(app.db, { actor: r.user.name, action: 'settle', detail: { conversationId: id } });
      return { redirect: `/chat/${id}`, message: 'סומן שטיפלתם. השיחה כבר לא מחכה לכם.' };
    }],
    // The store's plan (plans.ts): the operator's, on the store's page.
    ['POST', /^\/lead\/(\d+)\/plan$/, async (r, m) => {
      const id = Number(m[1]);
      const p: PlanKey = r.form.plan === 'big' ? 'big' : 'store';
      await app.db.query('UPDATE stores SET config = config || $2::jsonb, updated_at = now() WHERE id = $1', [id, J({ plan: p })]);
      forgetStorePrompt(id);
      await audit(app.db, { actor: r.user.name, action: 'plan', storeId: id, detail: { plan: p } });
      return { redirect: `/lead/${id}#plan`, message: `החנות בחבילת ${PLANS[p].he}.` };
    }],
  ];
}
