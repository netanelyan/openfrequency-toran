import type { App } from '../../app.ts';
import { displayName } from '../../ingest/brand.ts';
import { KEYS, isSet } from '../../core/env.ts';
import { now } from '../../core/clock.ts';
import { enqueue } from '../../jobs/queue.ts';
import { audit } from '../../db/log.ts';
import { contactTarget, pitchUrl, reminderMessage } from '../../outreach.ts';
import { getOffer, offerReady, priceSentence, setOffer, type Offer } from '../../offer.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { ago, csrfField, esc, icon, layout, postButton, stamp, storeBadge, tokenNum, usd } from '../ui.ts';
import { addForm, leadRow } from './leads.ts';
import { opsSections } from './ops.ts';
import { storeIdIn, storesOf } from '../workspace.ts';
import { ALL_CHANNELS, CHANNEL_HE, channelStates, enabledChannels, MESSAGING, messagingSql, setChannelState, type ChannelState } from '../../channels/config.ts';
import { ownerReply, PAUSE_HOURS, replyState, resumeAgent } from '../../channels/owner.ts';

// Today (for the operator, their dashboard on top: pages/ops.ts), the inbox (every channel's conversations, and the owner's reply in each), the follow-up queue and the settings. Every list is the session's workspace's (workspace.ts);
// the offer, lead discovery, the keys and developer mode are the whole server's, so only the operator sees them.

async function today(app: App, r: DashReq) {
  const w = storesOf(r.scope);
  const c = await app.db.one<any>(`SELECT
    (SELECT COUNT(*)::int FROM stores WHERE status = 'page_ready' AND approved_at IS NULL AND ${w}) AS review,
    (SELECT COUNT(*)::int FROM stores WHERE approved_at IS NOT NULL AND sent_at IS NULL AND status <> 'skipped' AND ${w}) AS ready,
    (SELECT COUNT(*)::int FROM stores WHERE followup_due_at <= now() AND followup_sent_at IS NULL AND status IN ('sent', 'opened') AND ${w}) AS due,
    (SELECT COUNT(*)::int FROM stores WHERE qualified AND status = 'new' AND ${w}) AS fresh,
    (SELECT COUNT(*)::int FROM stores WHERE opened_at > now() - interval '7 days' AND ${w}) AS opened,
    (SELECT COUNT(*)::int FROM stores WHERE demo_started_at > now() - interval '7 days' AND ${w}) AS demos`);
  const ready = await app.db.query<any>(`SELECT * FROM stores WHERE approved_at IS NOT NULL AND sent_at IS NULL AND status <> 'skipped' AND ${w} ORDER BY score DESC LIMIT 8`);
  const fresh = await app.db.query<any>(`SELECT * FROM stores WHERE qualified AND status = 'new' AND ${w} ORDER BY score DESC LIMIT 6`);
  const down = await app.db.query<any>(`SELECT * FROM stores WHERE takedown_asked_at IS NOT NULL AND taken_down_at IS NULL AND ${w} ORDER BY takedown_asked_at DESC`);
  const hand = await app.db.query<any>(`SELECT c.id, c.handoffs, c.misses, c.last_at, s.id AS store_id, s.name, s.domain, s.brand, (SELECT handoff->>'summary' FROM messages WHERE conversation_id = c.id AND handoff IS NOT NULL ORDER BY id DESC LIMIT 1) AS summary FROM conversations c JOIN stores s ON s.id = c.store_id WHERE ${messagingSql('c.channel')} AND c.handoffs > 0 AND c.last_at > now() - interval '3 days' AND ${storesOf(r.scope, 's')} ORDER BY c.last_at DESC LIMIT 6`);
  const lead = c.review ? { n: c.review, l: c.review === 1 ? 'דף מחכה לבדיקה' : 'דפים מחכים לבדיקה', href: '/review', s: 'דף שמאשרים עובר לשליחה' } : c.ready ? { n: c.ready, l: c.ready === 1 ? 'מוכן לשליחה' : 'מוכנים לשליחה', href: '#ready', s: 'שולחים ידנית ומסמנים שנשלח' } : { n: c.fresh, l: c.fresh === 1 ? 'ליד חדש שמתאים' : 'לידים חדשים שמתאימים', href: '/leads?status=new', s: 'אפשר לבנות להם דף' };
  // The operator's dashboard holds who to write to (its list takes the place of "ready to send" below).
  const ops = r.scope.operator ? await opsSections(app, r) : '';
  const body = `<div class="head"><h1>היום</h1><p class="sub">${esc(new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(now())))}</p></div>
${ops}
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
${ops ? '' : `<section class="group mt24" id="ready"><header><h2>מוכנים לשליחה</h2></header>${ready.length ? `<div class="panel">${ready.map((s) => leadRow(s, `<a class="btn sm" href="/lead/${s.id}">${icon('send')}לשליחה</a>`)).join('')}</div>` : `<div class="empty">${icon('send')}<b>אין דפים שמחכים לשליחה</b>דף נכנס לכאן אחרי שמאשרים אותו.</div>`}</section>`}
<section class="group"><header><h2>לידים חדשים שמתאימים</h2><a class="end small" href="/leads?status=new">כולם</a></header>${fresh.length ? `<div class="panel">${fresh.map((s) => leadRow(s, s.platform === 'shopify' ? postButton(r.ctx, `/lead/${s.id}/build`, 'לבנות דף', { cls: 'btn sm' }) : '')).join('')}</div>` : `<div class="empty">${icon('leads')}<b>אין לידים חדשים</b>אפשר להריץ חיפוש בהגדרות.</div>`}</section>`;
  return layout({ ...r.ctx, title: 'היום', active: 'today' }, body);
}

async function chats(app: App, r: DashReq) {
  const filter = r.url.searchParams.get('filter') || '';
  const storeId = Number(r.url.searchParams.get('store') || 0);
  const shown = MESSAGING.filter((ch) => enabledChannels(app.env).has(ch));
  const channel = (shown as string[]).includes(r.url.searchParams.get('channel') || '') ? r.url.searchParams.get('channel')! : '';
  const where = [messagingSql('c.channel'), storesOf(r.scope, 's')];
  const params: unknown[] = [];
  if (channel) {
    params.push(channel);
    where.push(`c.channel = $${params.length}`);
  }
  if (filter === 'handoff') where.push('c.handoffs > 0');
  if (filter === 'miss') where.push('c.misses > 0');
  if (storeId) {
    params.push(storeId);
    where.push(`c.store_id = $${params.length}`);
  }
  const rows = await app.db.query<any>(`SELECT c.*, s.name, s.domain, s.brand, s.id AS sid, (SELECT COUNT(*)::int FROM messages WHERE conversation_id = c.id) AS n, (SELECT text FROM messages WHERE conversation_id = c.id AND role = 'customer' ORDER BY id DESC LIMIT 1) AS last_q FROM conversations c JOIN stores s ON s.id = c.store_id WHERE ${where.join(' AND ')} ORDER BY c.last_at DESC LIMIT 100`, params);
  const link = (o: Record<string, string>) => `/chats?${new URLSearchParams(Object.entries({ filter, channel, store: storeId ? String(storeId) : '', ...o }).filter(([, v]) => v))}`;
  const tab = (f: string, label: string) => `<a href="${link({ filter: f })}"${filter === f ? ' aria-current="true"' : ''}>${label}</a>`;
  const chTab = (ch: string, label: string) => `<a href="${link({ channel: ch })}"${channel === ch ? ' aria-current="true"' : ''}>${label}</a>`;
  const paused = (c: any) => c.agent_paused_until && new Date(c.agent_paused_until).getTime() > now();
  const body = `<div class="head"><h1>שיחות</h1><p class="sub">כל השיחות, מכל הערוצים. באדום שיחות שתורן העביר אליך. בכתום שיחות שבהן נמחק משפט לפני השליחה, כי היה בו מחיר או הבטחה שלא הגיעו מהאתר.</p></div>
<nav class="tabs">${tab('', 'הכול')}${tab('handoff', 'עם העברה')}${tab('miss', 'עם פספוס')}</nav>
${shown.length > 1 ? `<nav class="tabs mt8">${chTab('', 'כל הערוצים')}${shown.map((ch) => chTab(ch, CHANNEL_HE[ch])).join('')}</nav>` : ''}
${rows.length ? `<div class="list">${rows.map((c) => `<a href="/chat/${c.id}"><span class="ico ${c.handoffs ? 'bad' : c.misses ? 'warn' : 'ok'}">${icon(c.handoffs ? 'hand' : 'chat')}</span><span class="t"><b>${esc(c.brand?.name || c.name || c.domain)} · ${esc((c.last_q || c.meta?.subject || '').replace(/\n/g, ' ').slice(0, 70))}</b><small><span class="chip">${esc(CHANNEL_HE[c.channel as keyof typeof CHANNEL_HE] || c.channel)}</span> · ${c.n} הודעות · ${esc(ago(c.last_at))}${c.handoffs ? ` · ${c.handoffs} העברות` : ''}${c.misses ? ` · ${c.misses} פספוסים` : ''}${paused(c) ? ' · <span class="chip sig">אצלך</span>' : ''} · <bdi class="ltr">${esc(maskPeer(c.channel, c.peer))}</bdi></small></span><span class="go">${icon('chev')}</span></a>`).join('')}</div>` : `<div class="empty">${icon('chat')}<b>עוד אין שיחות</b>שיחה מופיעה כאן כשמישהו שולח קוד דמו למספר, או כותב למייל של חנות שמחוברת.</div>`}`;
  return layout({ ...r.ctx, title: 'שיחות', active: 'chats' }, body);
}

/** WhatsApp's own markup, as the phone shows it: _italic_ and *bold* (applied to already escaped text). */
const waMarkup = (html: string) => html.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<i>$2</i>').replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<b>$2</b>');

const maskPhone = (p: string | null) => (p ? `+${p.slice(0, 5)}•••${p.slice(-3)}` : '');
/** The customer, as the inbox shows them: a phone or an address, partly hidden. */
const maskPeer = (channel: string, p: string | null) => {
  if (!p) return '';
  if (channel !== 'email') return maskPhone(p);
  const [user, domain] = p.split('@');
  return `${user.slice(0, 2)}•••@${domain || ''}`;
};

const BLOCKED_HE: Record<string, string> = {
  window_closed: 'עברו יותר מ־24 שעות מההודעה האחרונה של הלקוח. בוואטסאפ אפשר לענות אחרי זה רק בתבנית שמטא אישרה, ולתורן עוד אין תבניות, אז מכאן אי אפשר לענות בשיחה הזו.',
  suppressed: 'מייל לכתובת הזו חזר או סומן כספאם, אז לא שולחים אליה יותר.',
  no_customer: 'הלקוח עוד לא כתב בשיחה הזו, אז אין למי לענות.',
  channel_off: 'הערוץ של השיחה הזו כבוי בשרת (TORAN_CHANNELS), אז אי אפשר לשלוח ממנו.',
};

const RULE_HE: Record<string, string> = { price: 'מחיר שלא הגיע מהנתונים', stock: 'מלאי שלא הגיע מהנתונים', delivery: 'זמן משלוח שלא הגיע מהנתונים', promise: 'הבטחה להנחה או להחזר', superlative: 'סופרלטיב', continuation: 'המשך של משפט שנחתך' };

async function chat(app: App, r: DashReq, id: number) {
  const c = await app.db.one<any>('SELECT c.*, s.name, s.domain, s.brand, s.id AS sid FROM conversations c JOIN stores s ON s.id = c.store_id WHERE c.id = $1', [id]);
  if (!c) return null;
  const msgs = await app.db.query<any>('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id', [id]);
  const cost = await app.db.one<any>('SELECT COALESCE(SUM(api_usd), 0)::float AS api, COALESCE(SUM(usd), 0)::float AS usd FROM usage WHERE conversation_id = $1', [id]);
  const markup = (t: string) => (c.channel === 'whatsapp' ? waMarkup(esc(t)) : esc(t));
  const out = msgs.map((m) => {
    const cls = m.role === 'agent' ? `agent${m.handoff ? ' hand' : m.guard?.length ? ' flag' : ''}` : m.role === 'owner' ? 'owner' : m.role === 'system' ? `system${m.handoff ? ' hand' : ''}` : 'customer';
    const notes = m.role === 'agent' ? [
      ...(m.tools || []).map((t: any) => `<span>${icon('search')} ${esc(t.name)} ${esc(JSON.stringify(t.input)).slice(0, 120)}</span>`),
      ...(m.guard || []).filter((g: any) => g.rule !== 'continuation').map((g: any) => `<span class="warn">${icon('alert')} נמחק לפני השליחה (${esc(RULE_HE[g.rule] || g.rule)}): "${esc(g.sentence)}"</span>`),
      ...(m.handoff ? [`<span class="bad">${icon('hand')} הועבר אליך (${esc(m.handoff.reason)}): ${esc(m.handoff.summary)}</span>`] : []),
    ] : m.role === 'owner' ? [`<span>${icon('send')} נשלח מכאן${m.author ? ` (${esc(m.author)})` : ''}</span>`]
    : m.role === 'customer' ? [
      ...(m.automated ? [`<span class="warn">${icon('alert')} הודעה אוטומטית (${esc(m.automated)}), ותורן לא ענה עליה</span>`] : []),
      ...((m.attachments || []).length ? [`<span>קבצים: ${(m.attachments as any[]).map((a) => `${esc(a.name)} (${Math.max(1, Math.round((Number(a.size) || 0) / 1024))}KB)`).join(', ')}</span>`] : []),
    ] : [];
    return `<div class="b ${cls}">${markup(m.text)}<span class="at">${esc(stamp(m.at))}</span></div>${notes.length ? `<div class="note${m.role === 'customer' ? ' start' : ''}">${notes.join('')}</div>` : ''}`;
  });
  const st = await replyState(app, id);
  const ch = CHANNEL_HE[c.channel as keyof typeof CHANNEL_HE] || c.channel;
  const pausedNote = st.pausedUntil ? `<div class="row"><p class="small m0">ענית בשיחה הזו, אז תורן לא עונה בה עד ${esc(stamp(st.pausedUntil))}. כל הודעה שמגיעה עד אז מחכה לך כאן.</p>${r.ctx.readOnly ? '' : postButton(r.ctx, `/chat/${id}/resume`, 'להחזיר לתורן', { cls: 'btn sm' })}</div>` : '';
  const windowNote = st.windowEnds ? `אפשר לענות עד ${esc(stamp(st.windowEnds))}, 24 שעות מההודעה האחרונה של הלקוח. ` : '';
  const replyBox = (MESSAGING as string[]).includes(c.channel) ? `<section class="panel mt16" id="reply"><header><h2>לענות ללקוח</h2><span class="end chip">${esc(ch)}</span></header>
  ${pausedNote}
  ${st.canReply && !r.ctx.readOnly ? `<form method="post" action="/chat/${id}/reply" class="${st.pausedUntil ? 'mt12' : ''}">${csrfField(r.ctx)}<textarea name="text" rows="4" dir="auto" required maxlength="4000" class="wide" aria-label="התשובה שלך"></textarea><div class="row mt8"><button class="btn primary sm" type="submit">${icon('send')}לשלוח ב${esc(ch)}</button></div></form>
  <p class="small muted mt8 m0">${windowNote}אחרי שעונים מכאן, תורן לא עונה בשיחה הזו ${PAUSE_HOURS} שעות מההודעה האחרונה שלך.</p>` : st.canReply ? '<p class="muted m0">במצב צפייה אי אפשר לשלוח.</p>' : `<p class="muted m0">${esc(BLOCKED_HE[st.reason || ''] || '')}</p>`}
</section>` : '';
  const subject = c.channel === 'email' && c.meta?.subject ? ` · "${esc(c.meta.subject)}"` : '';
  const body = `<a class="back" href="/chats">${icon('chev')}שיחות</a>
<div class="head"><div class="row">${storeBadge({ id: c.sid, name: c.brand?.name || c.name, domain: c.domain })}<h1 class="title">${esc(c.brand?.name || c.name || c.domain)}</h1></div><p class="sub">${esc(ch)} · <bdi class="ltr">${esc(maskPeer(c.channel, c.peer) || c.channel)}</bdi>${subject} · התחילה ${esc(stamp(c.started_at))} · ${c.handoffs} העברות · ${c.misses} פספוסים · ${r.ctx.dev ? `${usd(cost?.api, 4)} במחירי API` : `${tokenNum(cost?.api)} טוקנים`}</p><div class="end"><a class="btn sm" href="/lead/${c.sid}">לליד</a></div></div>
<section class="panel"><div class="chat">${out.join('')}</div></section>
${replyBox}`;
  return layout({ ...r.ctx, title: 'שיחה', active: 'chat' }, body);
}

async function followups(app: App, r: DashReq) {
  const due = await app.db.query<any>(`SELECT * FROM stores WHERE sent_at IS NOT NULL AND followup_sent_at IS NULL AND status IN ('sent', 'opened') AND ${storesOf(r.scope)} ORDER BY followup_due_at`);
  const done = await app.db.query<any>(`SELECT * FROM stores WHERE followup_sent_at IS NOT NULL AND ${storesOf(r.scope)} ORDER BY followup_sent_at DESC LIMIT 20`);
  const row = (s: any) => {
    const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
    const isDue = s.followup_due_at && new Date(s.followup_due_at).getTime() <= now();
    const t = contactTarget(s);
    const text = reminderMessage({ storeName: name, url: pitchUrl(app.env, s.slug) });
    return `<article class="card rcard" data-item>
  <div class="who">${storeBadge(s)}<div><h3><a href="/lead/${s.id}">${esc(name)}</a></h3><small>נשלח ${esc(ago(s.sent_at))}${s.opened_at ? ` · נפתח ${esc(ago(s.opened_at))}` : ' · עוד לא נפתח'} · ${isDue ? '<b>התזכורת מוכנה</b>' : `התזכורת ב־${esc(stamp(s.followup_due_at))}`}</small></div></div>
  ${isDue ? `<div class="flags"><textarea id="rem-${s.id}" rows="4" dir="rtl" class="wide">${esc(text)}</textarea></div>
  <div class="actions"><button class="btn primary" type="button" data-copy="#rem-${s.id}" ${t.href ? `data-open="${esc(t.href)}"` : ''} data-done="התזכורת הועתקה">${icon('copy')}${esc(t.label)}</button>${postButton(r.ctx, `/lead/${s.id}/followup-sent`, 'שלחתי', { cls: 'btn', ajax: 'remove' })}${postButton(r.ctx, `/lead/${s.id}/skip`, 'לוותר', { cls: 'btn ghost', ajax: 'remove', fields: { reason: 'בלי תזכורת' } })}</div>` : '<div class="actions"></div>'}
</article>`;
  };
  const body = `<div class="head"><h1>מעקב</h1><p class="sub">לכל חנות תזכורת אחת, ארבעה ימים אחרי ההודעה הראשונה ולא בשבת. אחרי התזכורת לא כותבים יותר.</p></div>
${due.length ? `<div class="cards">${due.map(row).join('')}</div>` : `<div class="empty">${icon('clock')}<b>אין תזכורות שמחכות</b>תזכורת נכנסת לכאן אחרי שמסמנים שהודעה נשלחה.</div>`}
${done.length ? `<section class="group mt24"><header><h2>כבר קיבלו תזכורת</h2></header><div class="panel">${done.map((s) => leadRow(s)).join('')}</div></section>` : ''}`;
  return layout({ ...r.ctx, title: 'מעקב', active: 'followups' }, body);
}

async function settings(app: App, r: DashReq) {
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
    ${dev ? `<section class="panel dev" id="dev"><header><h2>מצב מפתח</h2></header><dl class="kv"><dt>מודל</dt><dd class="ltr">${esc(app.llm.backend)} · ${esc(app.env.TORAN_MODEL_AGENT || 'claude-opus-5-5')}</dd><dt>וואטסאפ</dt><dd class="ltr">${esc(app.wa.kind)}</dd><dt>מסד נתונים</dt><dd class="ltr">${esc(app.db.kind)}</dd></dl><form method="post" action="/settings/dev" class="mt12">${csrfField(r.ctx)}<input type="hidden" name="on" value="0"><button class="btn sm" type="submit">לסגור מצב מפתח</button></form></section>` : ''}
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
      if (!text) throw new ActionError('התשובה ריקה.');
      const d = await ownerReply(app, Number(m[1]), text, r.user.name);
      if (!d.ok) throw new ActionError(BLOCKED_HE[d.reason] || 'לא נשלח.');
      return { redirect: `/chat/${m[1]}#reply`, message: `נשלח. תורן לא עונה בשיחה הזו ${PAUSE_HOURS} שעות.` };
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
      const offer: Offer = { monthly: num(r.form.monthly, 1), vat, setup: num(r.form.setup, 0), city };
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
