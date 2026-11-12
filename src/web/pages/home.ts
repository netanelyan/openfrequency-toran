import type { App } from '../../app.ts';
import { displayName } from '../../ingest/brand.ts';
import { KEYS, isSet } from '../../core/env.ts';
import { now } from '../../core/clock.ts';
import { enqueue } from '../../jobs/queue.ts';
import { audit } from '../../db/log.ts';
import { contactTarget, pitchUrl, reminderMessage } from '../../outreach.ts';
import { getOffer, offerReady, priceSentence, setOffer, type Offer } from '../../offer.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { ago, csrfField, dayLine, esc, icon, layout, postButton, stamp, storeBadge, timeHe, tokenNum, usd } from '../ui.ts';
import { installCard, installPanel } from '../install.ts';
import { addForm, leadRow } from './leads.ts';
import { selling, storeIdIn, storesOf } from '../workspace.ts';
import { ALL_CHANNELS, CHANNEL_HE, channelStates, enabledChannels, MESSAGING, messagingSql, setChannelState, type ChannelState } from '../../channels/config.ts';
import { ownerReply, PAUSE_HOURS, replyState, resumeAgent } from '../../channels/owner.ts';
import { GraphError, TOKEN_GONE } from '../../channels/meta.ts';
import { questionOf } from '../../assistant/index.ts';
import { forgetStorePrompt } from '../../agent/loop.ts';
import { agentEffort, agentModel } from '../../agent/llm/index.ts';
import { avatar, channelLogo, channelTag, conversationRow, filesHtml, maskPeer, peerLabel, ROW_SQL, STATE_HE, STATE_SQL, stateChip, WAITING_SQL, whyHe, type InboxState } from '../inbox.ts';
import { checkUpload, fileOf, MAX_BYTES } from '../../channels/files.ts';
import { apartCustomer, candidates, otherConversations, sameCustomer } from '../../channels/customers.ts';
import { customerSettings, customerToday } from './customer.ts';
import { canIngest } from '../../ingest/catalogue.ts';
import { MESSAGES } from '../../auto/messages.ts';
import { outreachLive } from '../../ops/outreach.ts';
import { REASON_HE, summaryHe } from '../../agent/guard.ts';

// Today, the inbox (every channel's conversations, the owner's reply in each with a file where the channel takes one,
// the files customers sent, and the customer's other conversations), the follow-up queue and the settings. Every list is the session's workspace's (workspace.ts);
// the offer, lead discovery, the keys and developer mode are the whole server's, so only the operator sees them.

async function today(app: App, r: DashReq) {
  // A customer's Today is what openfrequency.co.il sells them (pages/customer.ts); this one is the operator's.
  if (!r.ctx.operator) return customerToday(app, r);
  // What there is to sell is leads only: a customer's own store (workspace.ts selling) is not one of them.
  const w = `${storesOf(r.scope)} AND ${selling()}`;
  const c = await app.db.one<any>(`SELECT
    (SELECT COUNT(*)::int FROM stores WHERE status = 'page_ready' AND approved_at IS NULL AND ${w}) AS review,
    (SELECT COUNT(*)::int FROM stores WHERE approved_at IS NOT NULL AND sent_at IS NULL AND status <> 'skipped' AND ${w}) AS ready,
    (SELECT COUNT(*)::int FROM stores WHERE followup_due_at <= now() AND followup_sent_at IS NULL AND status IN ('sent', 'opened') AND ${w}) AS due,
    (SELECT COUNT(*)::int FROM stores WHERE qualified AND status = 'new' AND ${w}) AS fresh,
    (SELECT COUNT(*)::int FROM stores WHERE opened_at > now() - interval '7 days' AND ${w}) AS opened,
    (SELECT COUNT(*)::int FROM stores WHERE demo_started_at > now() - interval '7 days' AND ${w}) AS demos`);
  const ready = await app.db.query<any>(`SELECT * FROM stores WHERE approved_at IS NOT NULL AND sent_at IS NULL AND status <> 'skipped' AND ${w} ORDER BY score DESC LIMIT 8`);
  const fresh = await app.db.query<any>(`SELECT * FROM stores WHERE qualified AND status = 'new' AND ${w} ORDER BY score DESC LIMIT 6`);
  const down = await app.db.query<any>(`SELECT * FROM stores WHERE takedown_asked_at IS NOT NULL AND taken_down_at IS NULL AND ${storesOf(r.scope)} ORDER BY takedown_asked_at DESC`);
  const hand = await app.db.query<any>(`SELECT c.id, c.handoffs, c.misses, c.last_at, s.id AS store_id, s.name, s.domain, s.brand, (SELECT handoff->>'summary' FROM messages WHERE conversation_id = c.id AND handoff IS NOT NULL ORDER BY id DESC LIMIT 1) AS summary FROM conversations c JOIN stores s ON s.id = c.store_id WHERE ${messagingSql('c.channel')} AND c.handoffs > 0 AND c.last_at > now() - interval '3 days' AND ${storesOf(r.scope, 's')} ORDER BY c.last_at DESC LIMIT 6`);
  const lead = c.review ? { n: c.review, l: c.review === 1 ? 'דף מחכה לבדיקה' : 'דפים מחכים לבדיקה', href: '/review', s: 'דף שמאשרים עובר לשליחה' } : c.ready ? { n: c.ready, l: c.ready === 1 ? 'מוכן לשליחה' : 'מוכנים לשליחה', href: '#ready', s: 'שולחים ידנית ומסמנים שנשלח' } : { n: c.fresh, l: c.fresh === 1 ? 'ליד חדש שמתאים' : 'לידים חדשים שמתאימים', href: '/leads?status=new', s: 'אפשר לבנות להם דף' };
  const body = `<div class="head"><h1>היום</h1><p class="sub">${esc(new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(now())))}</p></div>
<div class="kpis">
  <a class="kpi lead" href="${lead.href}"><span class="l">${lead.l}</span><span class="v">${lead.n}</span><span class="s">${lead.s}</span></a>
  <div class="kpi side">
    <a href="/review"><span class="l">לבדיקה</span><span class="cnt ${c.review ? 'sig' : 'zero'}">${c.review}</span></a>
    <a href="#ready"><span class="l">מוכנים לשליחה</span><span class="cnt ${c.ready ? 'sig' : 'zero'}">${c.ready}</span></a>
    <a href="/followups"><span class="l">תזכורות להיום</span><span class="cnt ${c.due ? 'sig' : 'zero'}">${c.due}</span></a>
    <div><span class="l">נפתחו השבוע · דמו התחיל</span><span class="cnt ${c.opened ? 'ok' : 'zero'}">${c.opened} · ${c.demos}</span></div>
  </div>
</div>
${addForm(r)}
${down.length ? `<section class="group mt24"><header><h2>ביקשו להוריד את העמוד</h2></header><div class="panel">${down.map((s) => leadRow(s, postButton(r.ctx, `/lead/${s.id}/takedown`, 'להוריד', { cls: 'btn sm danger', confirm: 'להוריד את העמוד? הקישור והקוד של הדמו יפסיקו לעבוד.' }))).join('')}</div><p class="small muted mt8 m0">מישהו לחץ על "להוריד את העמוד הזה". כשההודעה שלהם מגיעה בוואטסאפ, מורידים את העמוד מכאן.</p></section>` : ''}
${hand.length ? `<section class="group mt24"><header><h2>העברות אליך</h2><a class="end small" href="/chats?filter=handoff">כל השיחות</a></header><div class="list">${hand.map((h) => `<a href="/chat/${h.id}"><span class="ico bad">${icon('hand')}</span><span class="t"><b>${esc(h.brand?.name || h.name || h.domain)}: ${esc(h.summary || 'תורן העביר שיחה')}</b><small>${esc(ago(h.last_at))}</small></span><span class="go">${icon('chev')}</span></a>`).join('')}</div></section>` : ''}
${installCard(r.ctx.install)}
<section class="group mt24" id="ready"><header><h2>מוכנים לשליחה</h2></header>${ready.length ? `<div class="panel">${ready.map((s) => leadRow(s, `<a class="btn sm" href="/lead/${s.id}">${icon('send')}לשליחה</a>`)).join('')}</div>` : `<div class="empty">${icon('send')}<b>אין דפים שמחכים לשליחה</b>דף נכנס לכאן אחרי שמאשרים אותו.</div>`}</section>
<section class="group"><header><h2>לידים חדשים שמתאימים</h2><a class="end small" href="/leads?status=new">כולם</a></header>${fresh.length ? `<div class="panel">${fresh.map((s) => leadRow(s, canIngest(s.platform) ? postButton(r.ctx, `/lead/${s.id}/build`, 'לבנות דף', { cls: 'btn sm' }) : '')).join('')}</div>` : `<div class="empty">${icon('leads')}<b>אין לידים חדשים</b>אפשר להריץ חיפוש בהגדרות.</div>`}</section>`;
  return layout({ ...r.ctx, title: 'היום', active: 'today' }, body);
}

/**
 * The inbox's list, as a mail client has it: a search, where each conversation stands (with how many), the channels,
 * and the conversations newest first. The same list is the /chats page and, on a wide screen, the column beside an open
 * conversation (`current`); its filters ride along on every link, so opening one keeps the list as it was.
 */
async function inboxPane(app: App, r: DashReq, current = 0) {
  const sp = r.url.searchParams;
  const op = r.ctx.operator;
  const filter = op && ['handoff', 'miss'].includes(sp.get('filter') || '') ? sp.get('filter')! : '';
  const storeId = Number(sp.get('store') || 0);
  // The chat on the store's site (channels/web.ts) is a tab only where one of the stores here has it on.
  const web = Boolean(await app.db.one(`SELECT 1 FROM channel_accounts a JOIN stores s ON s.id = a.store_id WHERE a.channel = 'web' AND ${storesOf(r.scope, 's')} LIMIT 1`));
  const shown = MESSAGING.filter((ch) => (ch === 'web' ? web : enabledChannels(app.env).has(ch)));
  const channel = (shown as string[]).includes(sp.get('channel') || '') ? sp.get('channel')! : '';
  const q = String(sp.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const state = (Object.keys(STATE_HE) as InboxState[]).includes(sp.get('state') as InboxState) ? (sp.get('state') as InboxState) : '';
  // Everything but where it stands, so the tabs can say how many each has.
  const where = [messagingSql('c.channel'), storesOf(r.scope, 's')];
  const params: unknown[] = [];
  if (channel) {
    params.push(channel);
    where.push(`c.channel = $${params.length}`);
  }
  if (storeId) {
    params.push(storeId);
    where.push(`c.store_id = $${params.length}`);
  }
  if (q) {
    // The customer's name, number or address, an email's subject, or a word anyone wrote in it.
    params.push(`%${q.replace(/[\\%_]/g, (x) => `\\${x}`)}%`);
    const n = `$${params.length}`;
    where.push(`(c.peer ILIKE ${n} OR c.meta->>'name' ILIKE ${n} OR c.meta->>'subject' ILIKE ${n} OR EXISTS (SELECT 1 FROM messages w WHERE w.conversation_id = c.id AND w.text ILIKE ${n}))`);
  }
  const counts = (await app.db.one<Record<'all' | InboxState, number>>(`SELECT COUNT(*)::int AS all, COUNT(*) FILTER (WHERE st = 'waiting')::int AS waiting, COUNT(*) FILTER (WHERE st = 'alone')::int AS alone, COUNT(*) FILTER (WHERE st = 'fixed')::int AS fixed
    FROM (SELECT ${STATE_SQL} AS st FROM conversations c JOIN stores s ON s.id = c.store_id WHERE ${where.join(' AND ')}) x`, params))!;
  if (state === 'waiting') where.push(WAITING_SQL);
  else if (state) where.push(`${STATE_SQL} = '${state}'`);
  if (filter === 'handoff') where.push('c.handoffs > 0');
  if (filter === 'miss') where.push('c.misses > 0');
  const list = await app.db.query<any>(`SELECT ${ROW_SQL}, c.store_id, c.handoffs, c.misses, c.agent_paused_until, s.name, s.domain, s.brand, s.brand_override FROM conversations c JOIN stores s ON s.id = c.store_id WHERE ${where.join(' AND ')} ORDER BY c.last_at DESC LIMIT 100`, params);
  const stores = op ? 2 : (await app.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM stores WHERE ${storesOf(r.scope)}`))?.n || 0;

  const keep = { filter, state, channel, store: storeId ? String(storeId) : '', q };
  const qsOf = (o: Record<string, string>) => {
    const s = new URLSearchParams(Object.entries({ ...keep, ...o }).filter(([, v]) => v)).toString();
    return s ? `?${s}` : '';
  };
  const link = (o: Record<string, string>) => `/chats${qsOf(o)}`;
  const cur = (on: boolean) => (on ? ' aria-current="true"' : '');
  const n = (x: number) => `<span class="n num">${x}</span>`;
  const tab = (f: string, label: string) => `<a href="${link({ filter: f, state: '' })}"${cur(filter === f && !state)}>${label}${f ? '' : n(counts.all)}</a>`;
  const stTab = (st: InboxState) => `<a href="${link({ state: st, filter: '' })}"${cur(state === st)}${st === 'waiting' && counts.waiting ? ' class="hot"' : ''}>${STATE_HE[st][0]}${n(counts[st])}</a>`;
  const chTab = (ch: string, label: string) => `<a href="${link({ channel: ch })}"${cur(channel === ch)}>${ch ? channelLogo(ch, { label: false }) : ''}${label}</a>`;
  const hidden = Object.entries({ ...keep, q: '' }).filter(([, v]) => v).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('');
  const paused = (c: any) => c.agent_paused_until && new Date(c.agent_paused_until).getTime() > now();
  const noteOf = (c: any) => (op ? [c.handoffs ? `${c.handoffs} העברות` : '', c.misses ? `${c.misses} פספוסים` : '', paused(c) ? 'אצלך' : ''].filter(Boolean).join(' · ') : '') || null;
  const rows = list.map((c) => conversationRow({ ...c, store: stores > 1 ? displayName(c.brand_override?.name, c.brand?.name, c.name) || c.domain : null, note: noteOf(c) }, { current: c.id === current, qs: qsOf({}) }));
  const empty = q ? `<div class="ib-none">${icon('search')}<b>לא נמצאו שיחות</b>אין שיחה עם "${esc(q)}". אפשר לחפש שם, מספר, מייל או מילה מתוך ההודעות.</div>`
    : state === 'waiting' ? `<div class="ib-none">${icon('check')}<b>אין שאלות שמחכות לכם</b>כשתורן לא מוצא תשובה באתר, השאלה מגיעה לכאן.</div>`
    : `<div class="ib-none">${icon('chat')}<b>${op ? 'עוד אין שיחות' : 'אין כאן שיחות'}</b>${op ? 'שיחה מופיעה כאן כשמישהו שולח קוד דמו למספר, או כותב למייל של חנות שמחוברת.' : 'שיחה מופיעה כאן מהרגע שלקוח כותב לחנות באחד הערוצים המחוברים.'}</div>`;
  const html = `<aside class="ib-pane" aria-label="השיחות">
  <div class="ib-tools">
    <form class="ib-search" method="get" action="/chats" role="search">${icon('search')}<input type="search" name="q" value="${esc(q)}" placeholder="חיפוש לפי שם, מספר או מילה" aria-label="חיפוש בשיחות" maxlength="80">${hidden}</form>
    <nav class="seg" aria-label="איפה השיחה עומדת">${tab('', 'הכול')}${stTab('waiting')}${stTab('alone')}${stTab('fixed')}</nav>
    ${op ? `<nav class="ib-ch" aria-label="סינון">${tab('handoff', 'עם העברה')}${tab('miss', 'עם פספוס')}</nav>` : ''}
    ${shown.length > 1 ? `<nav class="ib-ch" aria-label="ערוץ">${chTab('', 'כל הערוצים')}${shown.map((ch) => chTab(ch, CHANNEL_HE[ch])).join('')}</nav>` : ''}
  </div>
  <div class="ib-list">${rows.join('') || empty}</div>
</aside>`;
  return { html, back: link({}), shown };
}

async function chats(app: App, r: DashReq) {
  const pane = await inboxPane(app, r);
  const where = pane.shown.length > 1 ? `ב${pane.shown.map((ch) => CHANNEL_HE[ch]).join(', ב')}` : 'בוואטסאפ';
  const sub = r.ctx.operator ? 'כל השיחות, מכל הערוצים, עם ההעברות והפספוסים של כל אחת.' : `מה שלקוחות כותבים ${where} מגיע לכאן. ליד כל שיחה רואים מה קרה איתה: תורן ענה לבד, היא מחכה לכם, או שעניתם בה בעצמכם.`;
  const body = `<div class="head ib-head"><h1>שיחות</h1><p class="sub">${sub}</p></div>
<div class="inbox">${pane.html}<section class="ib-read ib-blank" aria-hidden="true">${icon('chat')}<b>בוחרים שיחה מהרשימה</b><span>היא נפתחת כאן, עם התשובה ללקוח מתחתיה.</span></section></div>`;
  return layout({ ...r.ctx, title: 'שיחות', active: 'chats', wide: true }, body);
}

/** WhatsApp's own markup, as the phone shows it: _italic_ and *bold* (applied to already escaped text). */
const waMarkup = (html: string) => html.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<i>$2</i>').replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<b>$2</b>');

/** Why a send failed, for the owner: a connection Meta no longer takes (its code 190, meta.ts TOKEN_GONE), a provider that refused, or none that answered. */
export function sendFailedHe(e: any, ch: string): string {
  if (e instanceof GraphError && e.code === TOKEN_GONE) return BLOCKED_HE.reconnect;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND/i.test(String(e?.message || e))) return `לא הצלחנו להגיע ל${ch} כרגע, ולא נשלח כלום. התשובה נשארה כאן, ואפשר לנסות שוב בעוד רגע.`;
  return `${ch} לא קיבל את ההודעה${e instanceof GraphError && e.code ? ` (קוד ${e.code})` : ''}. התשובה נשארה כאן. אפשר לנסות שוב בעוד רגע, ואם זה חוזר, לענות ללקוח ישירות או לכתוב לנו.`;
}

const BLOCKED_HE: Record<string, string> = {
  window_closed: 'עברו יותר מ־24 שעות מההודעה האחרונה של הלקוח. בוואטסאפ אפשר לענות אחרי זה רק בתבנית שמטא אישרה, ולתורן עוד אין תבניות, אז מכאן אי אפשר לענות בשיחה הזו.',
  suppressed: 'מייל לכתובת הזו חזר או סומן כספאם, אז לא שולחים אליה יותר.',
  no_files: 'בערוץ הזה אפשר לשלוח מכאן רק טקסט, בלי קבצים.',
  no_customer: 'הלקוח עוד לא כתב בשיחה הזו, אז אין למי לענות.',
  channel_off: 'הערוץ של השיחה הזו כבוי בשרת (TORAN_CHANNELS), אז אי אפשר לשלוח ממנו.',
  reconnect: 'החיבור של הוואטסאפ לתורן הסתיים, אז מכאן אי אפשר לשלוח. אפשר לענות ללקוח מהטלפון, ולחבר מחדש בהגדרות.',
};

/** Messenger and Instagram past their window: Meta lets nothing more go out until the customer writes again. */
const DM_CLOSED: Record<string, string> = {
  messenger: 'עבר יותר מדי זמן מההודעה האחרונה של הלקוח, ו־Meta לא מאפשרת לענות במסנג׳ר אחרי זה. כשהלקוח יכתוב שוב, אפשר לענות מכאן.',
  instagram: 'עבר יותר מדי זמן מההודעה האחרונה של הלקוח, ו־Meta לא מאפשרת לענות באינסטגרם אחרי זה. כשהלקוח יכתוב שוב, אפשר לענות מכאן.',
};

const AUTO_HE: Record<string, string> = Object.fromEntries(Object.entries(MESSAGES).map(([k, v]) => [k, v.he]));

const RULE_HE: Record<string, string> = { price: 'מחיר שלא הגיע מהנתונים', stock: 'מלאי שלא הגיע מהנתונים', delivery: 'זמן משלוח שלא הגיע מהנתונים', promise: 'הבטחה להנחה או להחזר', superlative: 'סופרלטיב', claim: 'עובדה שלא הגיעה מהנתונים', continuation: 'המשך של משפט שנחתך' };

async function chat(app: App, r: DashReq, id: number) {
  const c = await app.db.one<any>(`SELECT c.*, ${STATE_SQL} AS state, s.name, s.domain, s.brand, s.id AS sid FROM conversations c JOIN stores s ON s.id = c.store_id WHERE c.id = $1`, [id]);
  if (!c) return null;
  // The operator reads the agent's workings (its tool calls, the cost); a customer reads the conversation and where it stands.
  const op = r.ctx.operator;
  const msgs = await app.db.query<any>('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id', [id]);
  const cost = await app.db.one<any>('SELECT COALESCE(SUM(api_usd), 0)::float AS api, COALESCE(SUM(usd), 0)::float AS usd FROM usage WHERE conversation_id = $1', [id]);
  const markup = (t: string) => (c.channel === 'whatsapp' ? waMarkup(esc(t)) : esc(t));
  const customerName = peerLabel(c.channel, c.peer, c.meta?.name);
  // As a messaging app shows a thread: a line for each day, and the writer's name over each run of their messages.
  let day = '';
  let lastRole = '';
  const out = msgs.map((m) => {
    const d = dayLine(m.at);
    const sep = d !== day ? `<div class="day"><span>${esc(d)}</span></div>` : '';
    if (sep) lastRole = '';
    day = d;
    const writer = m.role === 'customer' ? customerName : m.role === 'agent' ? 'תורן' : m.role === 'owner' ? m.author || (op ? 'מכאן' : 'אתם') : '';
    const label = writer && m.role !== lastRole ? `<div class="who-l ${m.role === 'customer' ? 'start' : 'end'}"><bdi>${esc(writer)}</bdi></div>` : '';
    lastRole = m.role;
    return sep + label + bubble(m);
  });
  function bubble(m: any) {
    const cls = m.role === 'agent' ? `agent${m.handoff ? ' hand' : m.guard?.length ? ' flag' : ''}` : m.role === 'owner' ? 'owner' : m.role === 'system' ? `system${m.handoff ? ' hand' : ''}` : 'customer';
    const notes = m.role === 'agent' ? [
      // A message Toran sent by itself (auto/send.ts), or its answer to "הסר".
      ...(m.auto ? [`<span>${icon('send')} ${m.auto === 'opt_out' ? 'תשובה אוטומטית ללקוח שביקש להסיר' : `הודעה אוטומטית: ${esc(AUTO_HE[m.auto] || m.auto)}`}</span>`] : []),
      ...(op ? m.tools || [] : []).map((t: any) => `<span>${icon('search')} ${esc(t.name)} ${esc(JSON.stringify(t.input)).slice(0, 120)}</span>`),
      ...(m.guard || []).filter((g: any) => g.rule !== 'continuation').map((g: any) => `<span class="warn">${icon('alert')} נמחק לפני השליחה (${esc(RULE_HE[g.rule] || g.rule)}): "${esc(g.sentence)}"</span>`),
      ...(m.handoff ? [op ? `<span class="bad">${icon('hand')} הועבר אליך (${esc(REASON_HE[m.handoff.reason] || m.handoff.reason)}): ${esc(summaryHe(m.handoff.summary || ''))}</span>` : `<span class="bad">${icon('hand')} תורן העביר את זה אליכם${/[\u0590-\u05FF]/.test(summaryHe(m.handoff.summary || '')) ? `: ${esc(summaryHe(m.handoff.summary || ''))}` : ''}</span>`] : []),
    ] : m.role === 'owner' ? [`<span>${icon('send')} נשלח מכאן</span>`]
    : m.role === 'customer' ? [
      // Why it was not answered is the operator's to read ("no-reply address", "dmarc=fail"); the owner reads plain words.
      ...(m.automated ? [`<span class="warn">${icon('alert')} הודעה אוטומטית${op ? ` (${esc(m.automated)})` : ''}, ותורן לא ענה עליה</span>`] : []),
    ] : [];
    return `<div class="b ${cls}">${markup(m.text)}${filesHtml(id, m.attachments)}<time class="at" datetime="${esc(new Date(m.at).toISOString())}" title="${esc(stamp(m.at))}">${esc(timeHe(m.at))}</time></div>${notes.length ? `<div class="note${m.role === 'customer' ? ' start' : ''}">${notes.join('')}</div>` : ''}`;
  }
  const st = await replyState(app, id);
  const ch = CHANNEL_HE[c.channel as keyof typeof CHANNEL_HE] || c.channel;
  const pausedNote = st.pausedUntil ? `<div class="row"><p class="small m0">${op ? 'ענית' : 'עניתם'} בשיחה הזו, אז תורן לא עונה בה עד ${esc(stamp(st.pausedUntil))}. כל הודעה שמגיעה עד אז מחכה ${op ? 'לך' : 'לכם'} כאן.</p>${r.ctx.readOnly ? '' : postButton(r.ctx, `/chat/${id}/resume`, 'להחזיר לתורן', { cls: 'btn sm' })}</div>` : '';
  const windowNote = st.windowEnds ? `אפשר לענות עד ${esc(stamp(st.windowEnds))}, ${st.windowHours && st.windowHours > 24 ? `${Math.round(st.windowHours / 24)} ימים` : '24 שעות'} מההודעה האחרונה של הלקוח. ` : '';
  // A question Toran handed over: the owner's answer can stay with Toran for next time ("מה שתענו הוא יזכור לפעם הבאה").
  const waiting = c.state === 'waiting';
  const asked = waiting ? await questionOf(app, id) : null;
  const learned = await app.db.query<{ question: string }>('SELECT question FROM faqs WHERE conversation_id = $1 ORDER BY id', [id]);
  const learn = waiting && asked ? `<label class="row small mt8"><input type="checkbox" name="learn" value="1" checked> לשמור את התשובה, ותורן יענה ככה בפעם הבאה ששואלים את זה</label>
<label class="f mt8">השאלה, כמו שתורן ישמור אותה<input type="text" name="question" value="${esc(asked.slice(0, 300))}" maxlength="300" dir="auto"></label>` : '';
  const settle = waiting && !r.ctx.readOnly ? `<div class="row mt12">${postButton(r.ctx, `/chat/${id}/settle`, 'טיפלתי בזה בלי לענות מכאן', { cls: 'btn sm ghost', iconName: 'check' })}</div>` : '';
  // The answer, as a mail client's composer: the box under the thread, the file and the send on its bar, what it costs
  // (Toran steps back) and until when it can go in small words under it.
  const mb = MAX_BYTES / 1024 / 1024;
  const fileField = st.files ? `<label class="cmp-file" title="תמונה או PDF, עד ${mb}MB. תורן עצמו לא שולח קבצים.">${icon('clip')}<span data-file-name>לצרף קובץ</span><input class="sr" type="file" name="file" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf" data-max="${mb * 1024 * 1024}" data-too-big="הקובץ גדול מ־${mb}MB. אפשר לצרף קובץ קטן יותר."></label>` : '';
  const replyBox = (MESSAGING as string[]).includes(c.channel) ? `<div class="th-compose" id="reply"><h2 class="sr">לענות ללקוח</h2>
  ${pausedNote ? `<div class="th-paused">${pausedNote}</div>` : ''}
  ${st.canReply && !r.ctx.readOnly ? `<form method="post" action="/chat/${id}/reply" data-ajax="reply"${st.files ? ' enctype="multipart/form-data"' : ''} class="composer"><div class="cmp-box">${csrfField(r.ctx)}<textarea name="text" rows="2" dir="auto"${st.files ? '' : ' required'} maxlength="4000" placeholder="התשובה ${op ? 'שלך' : 'שלכם'}, ב${esc(ch)}" aria-label="התשובה ${op ? 'שלך' : 'שלכם'}"></textarea>
<div class="cmp-bar">${fileField}<button class="btn primary sm" type="submit">${icon('send')}לשלוח ב${esc(ch)}</button></div></div>${learn ? `<div class="cmp-learn">${learn}</div>` : ''}<p class="small bad mt8 m0" data-error role="alert" hidden></p></form>
  <p class="small muted mt8 m0">${windowNote}${st.from ? `התשובה יוצאת מהכתובת <bdi class="ltr">${esc(st.from)}</bdi>. ` : ''}אחרי שעונים מכאן, תורן לא עונה בשיחה הזו ${PAUSE_HOURS} שעות מההודעה האחרונה ${op ? 'שלך' : 'שלכם'}.</p>` : st.canReply ? '<p class="muted m0">במצב צפייה אי אפשר לשלוח.</p>' : `<p class="th-closed">${icon('alert')}<span>${esc((st.reason === 'window_closed' && DM_CLOSED[c.channel]) || BLOCKED_HE[st.reason || ''] || '')}</span></p>`}
  ${settle}
  ${learned.length ? `<p class="small mt12 m0">${icon('book')} תורן שמר מהשיחה הזו את התשובה ל"${esc(learned.map((x) => x.question).join('", "'))}". <a href="/lead/${c.sid}/knowledge#answers">${op ? 'לתשובות של החנות' : 'לתשובות שלכם'}</a></p>` : ''}
</div>` : '';
  const many = op || ((await app.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM stores WHERE ${storesOf(r.scope)}`))?.n || 0) > 1;
  const pane = await inboxPane(app, r, id);
  const subject = c.channel === 'email' && c.meta?.subject ? `<p class="th-subj">${icon('mail')}<bdi>${esc(c.meta.subject)}</bdi></p>` : '';
  const facts = [
    channelTag(c.channel) + (c.channel === 'whatsapp' && !c.account_id ? '<span class="chip ghost">דמו</span>' : ''),
    stateChip(c.state),
    ...(many ? [`<span class="chip">${esc(c.brand?.name || c.name || c.domain)}</span>`] : []),
    `<span class="chip">התחילה ${esc(stamp(c.started_at))}</span>`,
    ...(op ? [`<span class="chip">${c.handoffs} העברות · ${c.misses} פספוסים · ${r.ctx.dev ? `${usd(cost?.api, 4)} במחירי API` : `${tokenNum(cost?.api)} טוקנים`}</span>`] : []),
  ];
  const thread = `<section class="ib-read thread" aria-labelledby="th-name">
<header class="th-head"><a class="th-back" href="${esc(pane.back)}" aria-label="חזרה לשיחות">${icon('chev')}</a>${avatar(`${c.channel}:${c.peer || c.id}`, c.meta?.name, c.channel, { cls: 'av lg', label: false })}
<div class="th-who"><h1 class="title" id="th-name"><bdi>${esc(customerName)}</bdi></h1><p class="th-facts">${facts.join('')}</p></div>
<div class="end">${op ? `<a class="btn sm" href="/lead/${c.sid}">לליד</a>` : `<a class="btn sm" href="/lead/${c.sid}/knowledge">${icon('book')}<span>מה הוא יודע</span></a>`}</div></header>
${subject}
<div class="th-body"><div class="chat">${out.join('')}</div></div>
${replyBox}
</section>`;
  const body = `<div class="inbox open">${pane.html}${thread}</div>
${await customerPanel(app, r, id)}`;
  return layout({ ...r.ctx, title: customerName, active: 'chat', wide: true }, body);
}

/**
 * The customer's other conversations on the store's channels, with why each is theirs; "זה אותו לקוח" joins another
 * one, "זה לא אותו לקוח" splits one off (channels/customers.ts). Nothing here is shown to the agent.
 */
async function customerPanel(app: App, r: DashReq, id: number) {
  const others = await otherConversations(app, id, ROW_SQL);
  const pick = r.ctx.readOnly ? [] : await candidates(app, id, others.map((o) => o.id), ROW_SQL);
  if (!others.length && !pick.length) return '';
  const label = (c: any) => `${CHANNEL_HE[c.channel as keyof typeof CHANNEL_HE] || c.channel} · ${maskPeer(c.channel, c.peer, c.name) || 'לקוח'} · ${String(c.last_q || c.subject || '').replace(/\s+/g, ' ').slice(0, 50)}`;
  const linked = others.filter((o) => o.why !== 'same');
  const apart = linked.length && !r.ctx.readOnly ? `<details class="mt12"><summary class="small">אחת השיחות האלה של מישהו אחר?</summary><div class="row mt8">${linked.map((o) => postButton(r.ctx, `/chat/${id}/apart`, `זה לא אותו לקוח: ${esc(label(o))}`, { cls: 'btn sm ghost', fields: { other: String(o.id) } })).join('')}</div></details>` : '';
  const same = pick.length ? `<form method="post" action="/chat/${id}/same" class="row mt12">${csrfField(r.ctx)}<select name="other" aria-label="שיחה אחרת של אותו לקוח">${pick.map((c) => `<option value="${Number(c.id)}">${esc(label(c))}</option>`).join('')}</select><button class="btn sm" type="submit">${icon('check')}זה אותו לקוח</button></form>` : '';
  return `<section class="panel mt16" id="customer"><header><h2>הלקוח הזה בשיחות אחרות</h2></header>
  ${others.length ? `<div class="list">${others.map((o) => conversationRow({ ...(o as any), note: whyHe(o.why, o.channel) })).join('')}</div>` : '<p class="muted m0">אין ללקוח הזה שיחות אחרות שאנחנו יודעים עליהן.</p>'}
  ${apart}${same}
  <p class="small muted mt12 m0">שיחות מתחברות רק כשאותו מייל או אותו טלפון מופיעים בשתיהן, או כשמחברים אותן כאן. כשתורן עונה, הוא לא קורא את השיחות האחרות.</p>
</section>`;
}

async function followups(app: App, r: DashReq) {
  const due = await app.db.query<any>(`SELECT * FROM stores WHERE sent_at IS NOT NULL AND followup_sent_at IS NULL AND status IN ('sent', 'opened') AND ${storesOf(r.scope)} AND ${selling()} ORDER BY followup_due_at`);
  const done = await app.db.query<any>(`SELECT * FROM stores WHERE followup_sent_at IS NOT NULL AND ${storesOf(r.scope)} AND ${selling()} ORDER BY followup_sent_at DESC LIMIT 20`);
  // The reminder goes from our number at one press, as the approved template (ops/outreach.ts), when the store lists
  // a WhatsApp; copying it to send from the phone stays beside it.
  const live = await outreachLive(app);
  const row = (s: any) => {
    const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
    const isDue = s.followup_due_at && new Date(s.followup_due_at).getTime() <= now();
    const t = contactTarget(s);
    const text = reminderMessage({ storeName: name, url: pitchUrl(app.env, s.slug) });
    const pitch = live && s.contact_whatsapp;
    return `<article class="card rcard" data-item>
  <div class="who">${storeBadge(s)}<div><h3><a href="/lead/${s.id}">${esc(name)}</a></h3><small>נשלח ${esc(ago(s.sent_at))}${s.opened_at ? ` · נפתח ${esc(ago(s.opened_at))}` : ' · עוד לא נפתח'} · ${isDue ? '<b>התזכורת מוכנה</b>' : `התזכורת ב־${esc(stamp(s.followup_due_at))}`}</small></div></div>
  ${isDue ? `<div class="flags"><textarea id="rem-${s.id}" rows="4" dir="rtl" class="wide">${esc(text)}</textarea></div>
  <div class="actions">${pitch ? postButton(r.ctx, `/lead/${s.id}/wa-send`, 'לשלוח בוואטסאפ מהמספר שלנו', { cls: 'btn primary', ajax: 'remove', confirm: 'לשלוח את התזכורת עכשיו בוואטסאפ מהמספר שלנו? לחצו שוב כדי לשלוח' }) : ''}<button class="btn${pitch ? '' : ' primary'}" type="button" data-copy="#rem-${s.id}"${t.href ? `data-open="${esc(t.href)}"` : ''} data-done="התזכורת הועתקה">${icon('copy')}${esc(t.label)}</button>${postButton(r.ctx, `/lead/${s.id}/followup-sent`, 'שלחתי', { cls: 'btn', ajax: 'remove' })}${postButton(r.ctx, `/lead/${s.id}/skip`, 'לוותר', { cls: 'btn ghost', ajax: 'remove', fields: { reason: 'בלי תזכורת' } })}</div>` : '<div class="actions"></div>'}
</article>`;
  };
  const body = `<div class="head"><h1>מעקב</h1><p class="sub">לכל חנות תזכורת אחת, ארבעה ימים אחרי ההודעה הראשונה ולא בשבת. אחרי התזכורת לא כותבים יותר.</p></div>
${due.length ? `<div class="cards">${due.map(row).join('')}</div>` : `<div class="empty">${icon('clock')}<b>אין תזכורות שמחכות</b>תזכורת נכנסת לכאן אחרי שמסמנים שהודעה נשלחה.</div>`}
${done.length ? `<section class="group mt24"><header><h2>כבר קיבלו תזכורת</h2></header><div class="panel">${done.map((s) => leadRow(s)).join('')}</div></section>` : ''}`;
  return layout({ ...r.ctx, title: 'מעקב', active: 'followups' }, body);
}

async function settings(app: App, r: DashReq) {
  if (!r.ctx.operator) return customerSettings(app, r);
  const costs = await app.db.query<any>(`SELECT s.id, s.name, s.domain, s.brand,
      COALESCE(SUM(u.api_usd) FILTER (WHERE u.kind = 'llm'), 0)::float AS llm_api, COALESCE(SUM(u.usd) FILTER (WHERE u.kind = 'llm'), 0)::float AS llm_paid,
      COALESCE(SUM(u.usd) FILTER (WHERE u.kind = 'bsp'), 0)::float AS bsp, COALESCE(SUM(u.units) FILTER (WHERE u.kind = 'bsp'), 0)::int AS msgs,
      (SELECT COUNT(*)::int FROM conversations c WHERE c.store_id = s.id AND ${messagingSql('c.channel')}) AS demos
    FROM stores s JOIN usage u ON u.store_id = s.id WHERE ${storesOf(r.scope, 's')} GROUP BY s.id ORDER BY llm_api DESC LIMIT 40`);
  const tot = await app.db.one<any>(`SELECT COALESCE(SUM(usd), 0)::float AS paid, COALESCE(SUM(api_usd) FILTER (WHERE kind = 'llm'), 0)::float AS api, COALESCE(SUM(units) FILTER (WHERE kind = 'search'), 0)::int AS searches FROM usage WHERE at >= date_trunc('month', now()) AND ${storeIdIn(r.scope, 'store_id')}`);
  const op = r.scope.operator;
  const runs = op ? await app.db.query<any>('SELECT * FROM discovery_runs ORDER BY id DESC LIMIT 8') : [];
  const keys = KEYS.map((k) => `<li><code>${k.name}</code><span>${esc(k.he)}</span><span class="end chip ${isSet(k.name, app.env) ? 'ok' : 'ghost'}">${isSet(k.name, app.env) ? 'מוגדר' : 'חסר'}</span></li>`).join('');
  const offer = await getOffer(app.db);
  const dev = r.ctx.dev;
  const money = (x: number) => (dev ? usd(x, 3) : `${tokenNum(x)}`);
  const body = `<div class="head"><h1>הגדרות</h1><p class="sub">החודש: ${dev ? `${usd(tot?.paid, 2)} שולם, ${usd(tot?.api, 2)} במחירי API` : `${tokenNum(tot?.api)} טוקנים`}, ${tot?.searches || 0} חיפושים.</p></div>
<div class="cols">
  <div class="grid12">
    <section class="panel" id="costs"><header><h2>עלות לפי חנות</h2><span class="end small muted">${dev ? 'דולרים' : 'טוקנים (דולר = 100)'}</span></header>
      ${costs.length ? `<div class="scrollx"><table class="table stack"><thead><tr><th>חנות</th><th>מודל</th><th>וואטסאפ</th><th>שיחות</th><th>לשיחה</th></tr></thead><tbody>${costs.map((c) => `<tr><td data-k="חנות"><a href="/lead/${c.id}">${esc(c.brand?.name || c.name || c.domain)}</a></td><td class="n" data-k="מודל">${money(c.llm_api)}${dev && c.llm_paid ? ` (שולם ${usd(c.llm_paid, 3)})` : ''}</td><td class="n" data-k="וואטסאפ">${money(c.bsp)} · ${c.msgs} הודעות</td><td class="n" data-k="שיחות">${c.demos}</td><td class="n" data-k="לשיחה">${c.demos ? money((c.llm_api + c.bsp) / c.demos) : '-'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted m0">עוד אין עלויות.</p>'}
      <p class="small muted mt12 m0">בפיתוח המודל רץ על המנוי, אז "מודל" הוא מה שאותה קריאה הייתה עולה ב־API. בפרודקשן זה מה שמשולם.</p>
    </section>
    ${op ? `<section class="panel"><header><h2>חיפוש לידים</h2></header>
      <form class="row" method="post" action="/settings/discover">${csrfField(r.ctx)}<select name="source"><option value="storecensus">ספריית חנויות Shopify בישראל</option><option value="crawl">קישורים בין חנויות</option><option value="brave">חיפוש Brave</option><option value="seeds">רשימה מ־private/seeds.txt</option></select><input type="number" name="from" value="1" min="1" max="500" aria-label="מעמוד" class="small"><button class="btn sm" type="submit">${icon('search')}להריץ</button></form>
      <div class="list mt12">${runs.map((x) => `<a href="#"><span class="ico">${icon('search')}</span><span class="t"><b>${esc(x.source)} · ${x.stats?.leads ?? 0} לידים חדשים (${x.stats?.qualified ?? 0} מתאימים)</b><small>${esc(stamp(x.started_at))} · ${x.stats?.candidates ?? 0} מועמדים · ${x.stats?.failed ?? 0} נכשלו${x.finished_at ? '' : ' · רץ עכשיו'}</small></span></a>`).join('') || '<p class="muted">עוד לא רץ חיפוש.</p>'}</div>
    </section>` : ''}
  </div>
  <div class="grid12">
    ${op ? `${offerPanel(r, offer)}
    ${channelsPanel(r, await channelStates(app.db), enabledChannels(app.env))}
    <section class="panel"><header><h2>מפתחות</h2></header><ul class="keys">${keys}</ul><p class="small muted mt12 m0">הערכים נשמרים ב־<span class="ltr">private/.env</span> בלבד ולא מוצגים כאן.</p></section>` : ''}
    <section class="panel"><header><h2>המותג</h2></header><a class="btn sm" href="/brand">לדף המותג</a></section>
    ${installPanel(r.ctx.install)}
    ${dev ? `<section class="panel dev" id="dev"><header><h2>מצב מפתח</h2></header><dl class="kv"><dt>מודל</dt><dd class="ltr">${esc(app.llm.backend)} · ${esc(agentModel(app.env))} · ${esc(agentEffort(app.env))}</dd><dt>וואטסאפ</dt><dd class="ltr">${esc(app.wa.kind)}</dd><dt>מסד נתונים</dt><dd class="ltr">${esc(app.db.kind)}</dd></dl><form method="post" action="/settings/dev" class="mt12">${csrfField(r.ctx)}<input type="hidden" name="on" value="0"><button class="btn sm" type="submit">לסגור מצב מפתח</button></form></section>` : ''}
    <a class="btn ghost" href="${esc(r.ctx.logout || '/')}">${icon('logout')}יציאה</a>
  </div>
</div>
${op ? `<form class="ver" method="post" action="/settings/dev" data-devtap>${csrfField(r.ctx)}<input type="hidden" name="on" value="1">תורן · גרסה 0.1</form>` : '<p class="ver">תורן · גרסה 0.1</p>'}`;
  return layout({ ...r.ctx, title: 'הגדרות', active: 'settings' }, body);
}

/** Each channel's state as the website shows it (GET /channels.json); a channel whose code is off stays off. */
function channelsPanel(r: DashReq, states: Record<string, ChannelState>, on: Set<string>) {
  const label: Record<ChannelState, string> = { off: 'כבוי', demo: 'דמו', live: 'פעיל' };
  const row = (c: string) => `<label class="f mt8">${esc(CHANNEL_HE[c as keyof typeof CHANNEL_HE])}${on.has(c) ? '' : '<small>הקוד של הערוץ הזה עוד כבוי בשרת, אז הוא נשאר כבוי.</small>'}<select name="${c}"${on.has(c) ? '' : ' disabled'}>${(['off', 'demo', 'live'] as ChannelState[]).map((v) => `<option value="${v}"${states[c] === v ? ' selected' : ''}>${label[v]}</option>`).join('')}</select></label>`;
  return `<section class="panel" id="channels"><header><h2>ערוצים</h2></header>
  <form method="post" action="/settings/channels">${csrfField(r.ctx)}${ALL_CHANNELS.map(row).join('')}<button class="btn sm mt12" type="submit">לשמור</button></form>
  <p class="small muted mt12 m0">מה שנבחר כאן מופיע באתר: ערוץ שלא פעיל מסומן שם "בקרוב". "פעיל" בוחרים רק כשחנות שמשלמת יכולה לקבל בו את תורן.</p>
</section>`;
}

/** The offer every pitch page quotes: one place, and until it is set every page waits (offer.ts). */
function offerPanel(r: DashReq, o: Offer) {
  const vat = (v: string, label: string) => `<option value="${v}"${o.vat === v ? ' selected' : ''}>${label}</option>`;
  return `<section class="panel" id="offer"><header><h2>המחיר בדפי הדמו</h2><span class="end chip ${offerReady(o) ? 'ok' : 'bad'}">${offerReady(o) ? 'מוגדר' : 'חסר, הדפים מחכים'}</span></header>
  <form method="post" action="/settings/offer">${csrfField(r.ctx)}
    <label class="f">מחיר לחודש, בשקלים<input type="number" name="monthly" min="1" max="100000" step="1" inputmode="numeric" value="${o.monthly ?? ''}"></label>
    <label class="f mt8">מחיר לחודש של חבילת חנות גדולה, בשקלים<small>1,500 שיחות בחודש. ריק: הדף מציג רק את החבילה של 300 שיחות.</small><input type="number" name="bigMonthly" min="1" max="100000" step="1" inputmode="numeric" value="${o.bigMonthly ?? ''}"></label>
    <label class="f mt8">מע״מ<select name="vat">${vat('', 'עוד לא נקבע')}${vat('included', 'כולל מע״מ')}${vat('excluded', 'לא כולל מע״מ')}</select></label>
    <label class="f mt8">דמי הקמה, בשקלים<small>0 אם אין. ריק אם עוד לא נקבע.</small><input type="number" name="setup" min="0" max="100000" step="1" inputmode="numeric" value="${o.setup ?? ''}"></label>
    <label class="f mt8">העיר בתחתית הדף<input type="text" name="city" maxlength="40" value="${esc(o.city)}" dir="rtl"></label>
    <button class="btn sm mt12" type="submit">לשמור</button>
  </form>
  <p class="small muted mt12 m0">ככה זה כתוב בדף: ${priceSentence(o, (s) => `<mark>${esc(s)}</mark>`, esc)}</p>
</section>`;
}

export function homeRoutes(app: App): Route<DashReq>[] {
  return [
    ['GET', /^\/$/, async (r) => ({ html: await today(app, r) })],
    ['GET', /^\/chats$/, async (r) => ({ html: await chats(app, r) })],
    ['GET', /^\/chat\/(\d+)$/, async (r, m) => {
      const html = await chat(app, r, Number(m[1]));
      if (!html) throw new ActionError('אין שיחה כזו', 404);
      return { html };
    }],
    ['POST', /^\/chat\/(\d+)\/reply$/, async (r, m) => {
      const text = String(r.form.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 4000);
      const upload = (r.files || []).find((f) => f.field === 'file' && f.bytes.length);
      const checked = upload ? checkUpload(upload.name, upload.bytes) : null;
      if (checked && !checked.ok) throw new ActionError(checked.he);
      if (!text && !checked) throw new ActionError('התשובה ריקה.');
      const id = Number(m[1]);
      // A send the channel refuses or never answers is said in Hebrew, and the owner's text stays in the box (the form
      // posts in the background, app.js): the provider's own words go to the log (PRA-FE-003).
      let d: Awaited<ReturnType<typeof ownerReply>>;
      try {
        d = await ownerReply(app, id, text, r.user.name, checked?.ok ? [checked.file] : []);
      } catch (e: any) {
        app.log(`[inbox] reply in conversation ${id} failed: ${e?.message || e}`);
        const c = await app.db.one<{ channel: string }>('SELECT channel FROM conversations WHERE id = $1', [id]);
        throw new ActionError(sendFailedHe(e, CHANNEL_HE[c?.channel as keyof typeof CHANNEL_HE] || 'הערוץ'), 502);
      }
      if (!d.ok) throw new ActionError(BLOCKED_HE[d.reason] || 'לא נשלח.');
      // Kept for next time: the question as the owner left it, and their answer (the agent prefers it to the site's).
      const question = String(r.form.question || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (r.form.learn === '1' && text && question.length >= 2) {
        const c = await app.db.one<{ store_id: number }>('SELECT store_id FROM conversations WHERE id = $1', [id]);
        await app.db.query('INSERT INTO faqs (store_id, question, answer, conversation_id) VALUES ($1, $2, $3, $4)', [c!.store_id, question, text.slice(0, 2000), id]);
        await app.db.query('UPDATE stores SET updated_at = now() WHERE id = $1', [c!.store_id]);
        forgetStorePrompt(c!.store_id);
        await audit(app.db, { actor: r.user.name, action: 'learn', storeId: c!.store_id, detail: { conversationId: id } });
        return { redirect: `/chat/${id}#reply`, message: `נשלח, ותורן שמר את התשובה לפעם הבאה. בשיחה הזו הוא לא עונה ${PAUSE_HOURS} שעות.` };
      }
      return { redirect: `/chat/${id}#reply`, message: `נשלח. תורן לא עונה בשיחה הזו ${PAUSE_HOURS} שעות.` };
    }],
    // A file in a conversation (server.ts has checked the conversation is the session's): an image shows, a PDF downloads.
    ['GET', /^\/chat\/(\d+)\/file\/(\d+)$/, async (_r, m) => {
      const f = await fileOf(app, Number(m[1]), Number(m[2]));
      if (!f) throw new ActionError('אין קובץ כזה', 404);
      const image = f.row.type.startsWith('image/');
      return { body: f.bytes, type: f.row.type, headers: { 'content-disposition': `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.row.name)}`, 'cache-control': 'private, max-age=3600', 'content-security-policy': "default-src 'none'; sandbox" } };
    }],
    ['POST', /^\/chat\/(\d+)\/same$/, async (r, m) => {
      const id = Number(m[1]);
      if (!(await sameCustomer(app, id, Number(r.form.other) || 0, r.user.name))) throw new ActionError('אי אפשר לחבר את השיחות האלה. מחברים רק שתי שיחות של אותה חנות, בערוצים שלה.');
      return { redirect: `/chat/${id}#customer`, message: 'חובר. השיחות של הלקוח מופיעות עכשיו אחת ליד השנייה.' };
    }],
    ['POST', /^\/chat\/(\d+)\/apart$/, async (r, m) => {
      const id = Number(m[1]);
      if (!(await apartCustomer(app, id, Number(r.form.other) || 0, r.user.name))) throw new ActionError('אי אפשר להפריד את השיחה הזו.');
      return { redirect: `/chat/${id}#customer`, message: 'הופרד. השיחה הזו כבר לא מופיעה כאן.' };
    }],
    ['POST', /^\/chat\/(\d+)\/resume$/, async (r, m) => {
      await resumeAgent(app, Number(m[1]), r.user.name);
      return { redirect: `/chat/${m[1]}`, message: 'תורן עונה שוב בשיחה הזו, מההודעה הבאה.' };
    }],
    ['POST', /^\/settings\/channels$/, async (r) => {
      const on = enabledChannels(app.env);
      for (const c of ALL_CHANNELS) {
        if (!on.has(c) || !r.form[c]) continue;
        try {
          await setChannelState(app.db, app.env, c, r.form[c]);
        } catch (e: any) {
          throw new ActionError(String(e?.message || e));
        }
      }
      await audit(app.db, { actor: r.user.name, action: 'channels', detail: await channelStates(app.db) });
      return { redirect: '/settings#channels', message: 'נשמר. האתר רואה את השינוי בתוך חמש דקות.' };
    }],
    ['GET', /^\/followups$/, async (r) => ({ html: await followups(app, r) })],
    ['GET', /^\/settings$/, async (r) => ({ html: await settings(app, r) })],
    ['POST', /^\/settings\/offer$/, async (r) => {
      const num = (v: unknown, min: number) => {
        const s = String(v ?? '').trim();
        if (!s) return null;
        const n = Number(s);
        if (!Number.isInteger(n) || n < min || n > 100_000) throw new ActionError('המספר לא תקין. כותבים שקלים שלמים, בלי נקודה.');
        return n;
      };
      const vat = r.form.vat === 'included' || r.form.vat === 'excluded' ? r.form.vat : null;
      const city = String(r.form.city || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'אשדוד';
      // The big plan (offer.ts bigMonthly): shown beside the store plan on a pitch page once Toran is on sale; empty keeps it off.
      const offer: Offer = { monthly: num(r.form.monthly, 1), vat, setup: num(r.form.setup, 0), city, ...('bigMonthly' in r.form ? { bigMonthly: num(r.form.bigMonthly, 1) } : {}) };
      await setOffer(app.db, offer);
      await audit(app.db, { actor: r.user.name, action: 'offer', detail: offer });
      return { redirect: '/settings#offer', message: offerReady(offer) ? 'המחיר נשמר. דפים שאין להם חוסר אחר יכולים להיפתח.' : 'נשמר. עד שהמחיר, המע״מ ודמי ההקמה קבועים, הדפים מחכים.' };
    }],
    ['POST', /^\/settings\/discover$/, async (r) => {
      const source = ['storecensus', 'crawl', 'brave', 'seeds'].includes(r.form.source) ? r.form.source : 'storecensus';
      if (source === 'brave' && !isSet('BRAVE_API_KEY', app.env)) throw new ActionError('חסר BRAVE_API_KEY בקובץ private/.env');
      const job = await enqueue(app.db, 'discover', { source, from: Math.max(1, Number(r.form.from) || 1) }, { dedupeKey: `discover:${source}`, maxAttempts: 1 });
      await audit(app.db, { actor: r.user.name, action: 'discover', detail: { source } });
      return { message: `החיפוש רץ (${job}). התוצאות יופיעו בלידים.` };
    }],
  ];
}
