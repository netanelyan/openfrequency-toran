import type { App } from '../../app.ts';
import { KEYS, isSet } from '../../core/env.ts';
import { now } from '../../core/clock.ts';
import { enqueue } from '../../jobs/queue.ts';
import { audit } from '../../db/log.ts';
import { contactTarget, pitchUrl, reminderMessage } from '../../outreach.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { ago, csrfField, esc, icon, layout, postButton, stamp, storeBadge, tokenNum, usd } from '../ui.ts';
import { addForm, leadRow } from './leads.ts';

// Today, the chats, the follow-up queue and the settings.

async function today(app: App, r: DashReq) {
  const c = await app.db.one<any>(`SELECT
    (SELECT COUNT(*)::int FROM stores WHERE status = 'page_ready' AND approved_at IS NULL) AS review,
    (SELECT COUNT(*)::int FROM stores WHERE approved_at IS NOT NULL AND sent_at IS NULL AND status <> 'skipped') AS ready,
    (SELECT COUNT(*)::int FROM stores WHERE followup_due_at <= now() AND followup_sent_at IS NULL AND status IN ('sent', 'opened')) AS due,
    (SELECT COUNT(*)::int FROM stores WHERE qualified AND status = 'new') AS fresh,
    (SELECT COUNT(*)::int FROM stores WHERE opened_at > now() - interval '7 days') AS opened,
    (SELECT COUNT(*)::int FROM stores WHERE demo_started_at > now() - interval '7 days') AS demos`);
  const ready = await app.db.query<any>("SELECT * FROM stores WHERE approved_at IS NOT NULL AND sent_at IS NULL AND status <> 'skipped' ORDER BY score DESC LIMIT 8");
  const fresh = await app.db.query<any>("SELECT * FROM stores WHERE qualified AND status = 'new' ORDER BY score DESC LIMIT 6");
  const hand = await app.db.query<any>("SELECT c.id, c.handoffs, c.misses, c.last_at, s.id AS store_id, s.name, s.domain, s.brand, (SELECT handoff->>'summary' FROM messages WHERE conversation_id = c.id AND handoff IS NOT NULL ORDER BY id DESC LIMIT 1) AS summary FROM conversations c JOIN stores s ON s.id = c.store_id WHERE c.channel = 'whatsapp' AND c.handoffs > 0 AND c.last_at > now() - interval '3 days' ORDER BY c.last_at DESC LIMIT 6");
  const lead = c.review ? { n: c.review, l: c.review === 1 ? 'דף מחכה לבדיקה' : 'דפים מחכים לבדיקה', href: '/review', s: 'דף שמאשרים עובר לשליחה' } : c.ready ? { n: c.ready, l: c.ready === 1 ? 'מוכן לשליחה' : 'מוכנים לשליחה', href: '#ready', s: 'מעתיקים את ההודעה, שולחים, מסמנים' } : { n: c.fresh, l: c.fresh === 1 ? 'ליד חדש שמתאים' : 'לידים חדשים שמתאימים', href: '/leads?status=new', s: 'אפשר לבנות להם דף' };
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
${hand.length ? `<section class="group mt24"><header><h2>העברות אליך</h2><a class="end small" href="/chats?filter=handoff">כל השיחות</a></header><div class="list">${hand.map((h) => `<a href="/chat/${h.id}"><span class="ico bad">${icon('hand')}</span><span class="t"><b>${esc(h.brand?.name || h.name || h.domain)}: ${esc(h.summary || 'העוזר העביר שיחה')}</b><small>${esc(ago(h.last_at))}</small></span><span class="go">${icon('chev')}</span></a>`).join('')}</div></section>` : ''}
<section class="group mt24" id="ready"><header><h2>מוכנים לשליחה</h2></header>${ready.length ? `<div class="panel">${ready.map((s) => leadRow(s, `<a class="btn sm" href="/lead/${s.id}">${icon('send')}לשליחה</a>`)).join('')}</div>` : `<div class="empty">${icon('send')}<b>אין דפים שמחכים לשליחה</b>דף נכנס לכאן אחרי שמאשרים אותו.</div>`}</section>
<section class="group"><header><h2>לידים חדשים שמתאימים</h2><a class="end small" href="/leads?status=new">כולם</a></header>${fresh.length ? `<div class="panel">${fresh.map((s) => leadRow(s, s.platform === 'shopify' ? postButton(r.ctx, `/lead/${s.id}/build`, 'לבנות דף', { cls: 'btn sm' }) : '')).join('')}</div>` : `<div class="empty">${icon('leads')}<b>אין לידים חדשים</b>אפשר להריץ חיפוש בהגדרות.</div>`}</section>`;
  return layout({ ...r.ctx, title: 'היום', active: 'today' }, body);
}

async function chats(app: App, r: DashReq) {
  const filter = r.url.searchParams.get('filter') || '';
  const storeId = Number(r.url.searchParams.get('store') || 0);
  const where = ["c.channel = 'whatsapp'"];
  const params: unknown[] = [];
  if (filter === 'handoff') where.push('c.handoffs > 0');
  if (filter === 'miss') where.push('c.misses > 0');
  if (storeId) {
    params.push(storeId);
    where.push(`c.store_id = $${params.length}`);
  }
  const rows = await app.db.query<any>(`SELECT c.*, s.name, s.domain, s.brand, s.id AS sid, (SELECT COUNT(*)::int FROM messages WHERE conversation_id = c.id) AS n, (SELECT text FROM messages WHERE conversation_id = c.id AND role = 'customer' ORDER BY id DESC LIMIT 1) AS last_q FROM conversations c JOIN stores s ON s.id = c.store_id WHERE ${where.join(' AND ')} ORDER BY c.last_at DESC LIMIT 100`, params);
  const tab = (f: string, label: string) => `<a href="/chats?${new URLSearchParams({ ...(f ? { filter: f } : {}), ...(storeId ? { store: String(storeId) } : {}) })}"${filter === f ? ' aria-current="true"' : ''}>${label}</a>`;
  const body = `<div class="head"><h1>שיחות</h1><p class="sub">כל שיחות הדמו בוואטסאפ. העברות אליך באדום, משפטים שהשומר חתך בכתום.</p></div>
<nav class="tabs">${tab('', 'הכול')}${tab('handoff', 'עם העברה')}${tab('miss', 'עם פספוס')}</nav>
${rows.length ? `<div class="list">${rows.map((c) => `<a href="/chat/${c.id}"><span class="ico ${c.handoffs ? 'bad' : c.misses ? 'warn' : 'ok'}">${icon(c.handoffs ? 'hand' : 'chat')}</span><span class="t"><b>${esc(c.brand?.name || c.name || c.domain)} · ${esc((c.last_q || '').replace(/\n/g, ' ').slice(0, 70))}</b><small>${c.n} הודעות · ${esc(ago(c.last_at))}${c.handoffs ? ` · ${c.handoffs} העברות` : ''}${c.misses ? ` · ${c.misses} פספוסים` : ''} · <bdi class="ltr">${esc(maskPhone(c.peer))}</bdi></small></span><span class="go">${icon('chev')}</span></a>`).join('')}</div>` : `<div class="empty">${icon('chat')}<b>עוד אין שיחות</b>שיחה מופיעה כאן כשמישהו שולח קוד דמו למספר.</div>`}`;
  return layout({ ...r.ctx, title: 'שיחות', active: 'chats' }, body);
}

/** WhatsApp's own markup, as the phone shows it: _italic_ and *bold* (applied to already escaped text). */
const waMarkup = (html: string) => html.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<i>$2</i>').replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<b>$2</b>');

const maskPhone = (p: string | null) => (p ? `+${p.slice(0, 5)}•••${p.slice(-3)}` : '');

const RULE_HE: Record<string, string> = { price: 'מחיר שלא הגיע מהנתונים', stock: 'מלאי שלא הגיע מהנתונים', delivery: 'זמן משלוח שלא הגיע מהנתונים', promise: 'הבטחה להנחה או להחזר', superlative: 'סופרלטיב', continuation: 'המשך של משפט שנחתך' };

async function chat(app: App, r: DashReq, id: number) {
  const c = await app.db.one<any>('SELECT c.*, s.name, s.domain, s.brand, s.id AS sid FROM conversations c JOIN stores s ON s.id = c.store_id WHERE c.id = $1', [id]);
  if (!c) return null;
  const msgs = await app.db.query<any>('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id', [id]);
  const cost = await app.db.one<any>('SELECT COALESCE(SUM(api_usd), 0)::float AS api, COALESCE(SUM(usd), 0)::float AS usd FROM usage WHERE conversation_id = $1', [id]);
  const out = msgs.map((m) => {
    const cls = m.role === 'agent' ? `agent${m.handoff ? ' hand' : m.guard?.length ? ' flag' : ''}` : 'customer';
    const notes = m.role === 'agent' ? [
      ...(m.tools || []).map((t: any) => `<span>${icon('search')} ${esc(t.name)} ${esc(JSON.stringify(t.input)).slice(0, 120)}</span>`),
      ...(m.guard || []).filter((g: any) => g.rule !== 'continuation').map((g: any) => `<span class="warn">${icon('alert')} השומר חתך (${esc(RULE_HE[g.rule] || g.rule)}): "${esc(g.sentence)}"</span>`),
      ...(m.handoff ? [`<span class="bad">${icon('hand')} הועבר אליך (${esc(m.handoff.reason)}): ${esc(m.handoff.summary)}</span>`] : []),
    ] : [];
    return `<div class="b ${cls}">${waMarkup(esc(m.text))}<span class="at">${esc(stamp(m.at))}</span></div>${notes.length ? `<div class="note">${notes.join('')}</div>` : ''}`;
  });
  const body = `<a class="back" href="/chats">${icon('chev')}שיחות</a>
<div class="head"><div class="row">${storeBadge({ id: c.sid, name: c.brand?.name || c.name, domain: c.domain })}<h1 class="title">${esc(c.brand?.name || c.name || c.domain)}</h1></div><p class="sub"><bdi class="ltr">${esc(maskPhone(c.peer) || c.channel)}</bdi> · התחילה ${esc(stamp(c.started_at))} · ${c.handoffs} העברות · ${c.misses} פספוסים · ${r.ctx.dev ? `${usd(cost?.api, 4)} במחירי API` : `${tokenNum(cost?.api)} טוקנים`}</p><div class="end"><a class="btn sm" href="/lead/${c.sid}">לליד</a></div></div>
<section class="panel"><div class="chat">${out.join('')}</div></section>`;
  return layout({ ...r.ctx, title: 'שיחה', active: 'chat' }, body);
}

async function followups(app: App, r: DashReq) {
  const due = await app.db.query<any>("SELECT * FROM stores WHERE sent_at IS NOT NULL AND followup_sent_at IS NULL AND status IN ('sent', 'opened') ORDER BY followup_due_at");
  const done = await app.db.query<any>('SELECT * FROM stores WHERE followup_sent_at IS NOT NULL ORDER BY followup_sent_at DESC LIMIT 20');
  const row = (s: any) => {
    const name = s.brand?.name || s.name || s.domain;
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
      (SELECT COUNT(*)::int FROM conversations c WHERE c.store_id = s.id AND c.channel = 'whatsapp') AS demos
    FROM stores s JOIN usage u ON u.store_id = s.id GROUP BY s.id ORDER BY llm_api DESC LIMIT 40`);
  const tot = await app.db.one<any>("SELECT COALESCE(SUM(usd), 0)::float AS paid, COALESCE(SUM(api_usd) FILTER (WHERE kind = 'llm'), 0)::float AS api, COALESCE(SUM(units) FILTER (WHERE kind = 'search'), 0)::int AS searches FROM usage WHERE at >= date_trunc('month', now())");
  const runs = await app.db.query<any>('SELECT * FROM discovery_runs ORDER BY id DESC LIMIT 8');
  const keys = KEYS.map((k) => `<li><code>${k.name}</code><span>${esc(k.he)}</span><span class="end chip ${isSet(k.name, app.env) ? 'ok' : 'ghost'}">${isSet(k.name, app.env) ? 'מוגדר' : 'חסר'}</span></li>`).join('');
  const dev = r.ctx.dev;
  const money = (x: number) => (dev ? usd(x, 3) : `${tokenNum(x)}`);
  const body = `<div class="head"><h1>הגדרות</h1><p class="sub">החודש: ${dev ? `${usd(tot?.paid, 2)} שולם, ${usd(tot?.api, 2)} במחירי API` : `${tokenNum(tot?.api)} טוקנים`}, ${tot?.searches || 0} חיפושים.</p></div>
<div class="cols">
  <div class="grid12">
    <section class="panel" id="costs"><header><h2>עלות לפי חנות</h2><span class="end small muted">${dev ? 'דולרים' : 'טוקנים (דולר = 100)'}</span></header>
      ${costs.length ? `<div class="scrollx"><table class="table stack"><thead><tr><th>חנות</th><th>מודל</th><th>וואטסאפ</th><th>שיחות</th><th>לשיחה</th></tr></thead><tbody>${costs.map((c) => `<tr><td data-k="חנות"><a href="/lead/${c.id}">${esc(c.brand?.name || c.name || c.domain)}</a></td><td class="n" data-k="מודל">${money(c.llm_api)}${dev && c.llm_paid ? ` (שולם ${usd(c.llm_paid, 3)})` : ''}</td><td class="n" data-k="וואטסאפ">${money(c.bsp)} · ${c.msgs} הודעות</td><td class="n" data-k="שיחות">${c.demos}</td><td class="n" data-k="לשיחה">${c.demos ? money((c.llm_api + c.bsp) / c.demos) : '-'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted m0">עוד אין עלויות.</p>'}
      <p class="small muted mt12 m0">בפיתוח המודל רץ על המנוי, אז "מודל" הוא מה שאותה קריאה הייתה עולה ב־API. בפרודקשן זה מה שמשולם.</p>
    </section>
    <section class="panel"><header><h2>חיפוש לידים</h2></header>
      <form class="row" method="post" action="/settings/discover">${csrfField(r.ctx)}<select name="source"><option value="storecensus">ספריית חנויות Shopify בישראל</option><option value="crawl">קישורים בין חנויות</option><option value="brave">חיפוש Brave</option><option value="seeds">רשימה מ־private/seeds.txt</option></select><input type="number" name="from" value="1" min="1" max="500" aria-label="מעמוד" class="small"><button class="btn sm" type="submit">${icon('search')}להריץ</button></form>
      <div class="list mt12">${runs.map((x) => `<a href="#"><span class="ico">${icon('search')}</span><span class="t"><b>${esc(x.source)} · ${x.stats?.leads ?? 0} לידים חדשים (${x.stats?.qualified ?? 0} מתאימים)</b><small>${esc(stamp(x.started_at))} · ${x.stats?.candidates ?? 0} מועמדים · ${x.stats?.failed ?? 0} נכשלו${x.finished_at ? '' : ' · רץ עכשיו'}</small></span></a>`).join('') || '<p class="muted">עוד לא רץ חיפוש.</p>'}</div>
    </section>
  </div>
  <div class="grid12">
    <section class="panel"><header><h2>מפתחות</h2></header><ul class="keys">${keys}</ul><p class="small muted mt12 m0">הערכים נשמרים ב־<span class="ltr">private/.env</span> בלבד ולא מוצגים כאן.</p></section>
    <section class="panel"><header><h2>המותג</h2></header><a class="btn sm" href="/brand">לדף המותג</a></section>
    ${dev ? `<section class="panel dev" id="dev"><header><h2>מצב מפתח</h2></header><dl class="kv"><dt>מודל</dt><dd class="ltr">${esc(app.llm.backend)} · ${esc(app.env.TORAN_MODEL_AGENT || 'claude-opus-5-5')}</dd><dt>וואטסאפ</dt><dd class="ltr">${esc(app.wa.kind)}</dd><dt>מסד נתונים</dt><dd class="ltr">${esc(app.db.kind)}</dd></dl><form method="post" action="/settings/dev" class="mt12">${csrfField(r.ctx)}<input type="hidden" name="on" value="0"><button class="btn sm" type="submit">לסגור מצב מפתח</button></form></section>` : ''}
    <form method="post" action="/logout">${csrfField(r.ctx)}<button class="btn ghost" type="submit">${icon('logout')}יציאה</button></form>
  </div>
</div>
<form class="ver" method="post" action="/settings/dev" data-devtap>${csrfField(r.ctx)}<input type="hidden" name="on" value="1">תורן · גרסה 0.1</form>`;
  return layout({ ...r.ctx, title: 'הגדרות', active: 'settings' }, body);
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
    ['GET', /^\/followups$/, async (r) => ({ html: await followups(app, r) })],
    ['GET', /^\/settings$/, async (r) => ({ html: await settings(app, r) })],
    ['POST', /^\/settings\/discover$/, async (r) => {
      const source = ['storecensus', 'crawl', 'brave', 'seeds'].includes(r.form.source) ? r.form.source : 'storecensus';
      if (source === 'brave' && !isSet('BRAVE_API_KEY', app.env)) throw new ActionError('חסר BRAVE_API_KEY בקובץ private/.env');
      const job = await enqueue(app.db, 'discover', { source, from: Math.max(1, Number(r.form.from) || 1) }, { dedupeKey: `discover:${source}`, maxAttempts: 1 });
      await audit(app.db, { actor: r.user.name, action: 'discover', detail: { source } });
      return { message: `החיפוש רץ (${job}). התוצאות יופיעו בלידים.` };
    }],
  ];
}
