import type { App } from '../../app.ts';
import { displayName } from '../../ingest/brand.ts';
import { audit, event } from '../../db/log.ts';
import { enqueue } from '../../jobs/queue.ts';
import { homeUrl, canonicalDomain } from '../../core/urls.ts';
import { now } from '../../core/clock.ts';
import { pageStats } from '../../pitch/track.ts';
import { pitchGaps } from '../../pitch/ready.ts';
import { contactTarget, firstMessage, followupDue, pitchUrl, reminderMessage } from '../../outreach.ts';
import { PLANS, planOf, type PlanKey } from '../../plans.ts';
import { waAccountOf, waBanner, waLine } from './whatsapp.ts';
import { waConnectReady } from '../../channels/meta.ts';
import { SOCIAL, socialReady } from '../../channels/social.ts';
import { socialAccountOf, socialLine } from './social.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { storesOf } from '../workspace.ts';
import { CHANNEL_HE, enabledChannels, messagingSql, storeAddress } from '../../channels/config.ts';
import { ago, csrfField, esc, icon, layout, PLATFORM_HE, postButton, scoreNum, stamp, STATUS_HE, STATUS_ORDER, statusChip, storeBadge, vbar, tokenNum } from '../ui.ts';
import { canIngest } from '../../ingest/catalogue.ts';
import { mailDomainPanel } from './mailDomain.ts';

// Leads: the list (by status, with the score and what was found), adding one by URL,
// and one lead's page: its score's parts, its contacts, its pitch page and what the
// owner did with it, the message to copy, the one reminder, the timeline. The list is the session's workspace's;
// one lead's page and actions are checked in server.ts before they run. Adding a store is the operator's.

const FACTOR_HE: Record<string, string> = { platform: 'פלטפורמה', catalogue: 'קטלוג', hebrew: 'עברית', whatsapp: 'וואטסאפ', email: 'מייל', phone: 'טלפון', alive: 'פעילות', israeli: 'ישראלי', chain: 'רשת', restricted: 'קטגוריה' };

export function leadRow(r: any, extra = '') {
  const n = r.signals?.productCount;
  const contact = [r.contact_whatsapp && 'וואטסאפ', r.contact_email && 'מייל', !r.contact_whatsapp && !r.contact_email && r.contact_phone && 'טלפון'].filter(Boolean).join(' · ') || 'אין דרך ליצור קשר';
  return `<div class="qrow" data-item>
  ${storeBadge(r)}
  <a class="tx" href="/lead/${r.id}"><b>${esc(r.name || r.domain)}</b><span class="small"><bdi class="ltr">${esc(r.domain)}</bdi> · ${esc(PLATFORM_HE[r.platform] || r.platform)}${n != null ? ` · ${n}${r.signals?.productCountCapped ? '+' : ''} מוצרים` : ''} · ${contact}</span></a>
  <span class="meta">${statusChip(r.status, Boolean(r.approved_at))}</span>
  <span class="sc">${scoreNum(r.score, r.qualified)}</span>${extra}
</div>`;
}

async function leadsPage(app: App, r: DashReq) {
  const status = r.url.searchParams.get('status') || '';
  const all = r.url.searchParams.get('all') === '1';
  const q = (r.url.searchParams.get('q') || '').trim();
  const counts = Object.fromEntries((await app.db.query<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM stores WHERE ${storesOf(r.scope)} ${all ? '' : 'AND qualified'} GROUP BY status`)).map((x) => [x.status, x.n]));
  const total = Object.values(counts).reduce((s: number, n: any) => s + Number(n), 0);
  const where: string[] = [storesOf(r.scope)];
  const params: unknown[] = [];
  if (!all) where.push('qualified');
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(lower(domain) LIKE $${params.length} OR lower(COALESCE(name, '')) LIKE $${params.length})`);
  }
  const rows = await app.db.query<any>(`SELECT * FROM stores ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY score DESC, id LIMIT 300`, params);
  const tab = (s: string, label: string, n: number) => `<a href="/leads?${new URLSearchParams({ ...(s ? { status: s } : {}), ...(all ? { all: '1' } : {}) })}"${status === s ? ' aria-current="true"' : ''}>${label} <span class="n">${n}</span></a>`;
  const body = `<div class="head"><h1>לידים</h1><p class="sub">${all ? 'כל החנויות שנמצאו, גם אלה שלא עברו את הסף.' : 'החנויות שעברו את הסף, מהציון הגבוה לנמוך.'} <a href="/leads?${new URLSearchParams({ ...(status ? { status } : {}), ...(all ? {} : { all: '1' }) })}">${all ? 'רק המתאימים' : 'להציג את כולם'}</a></p></div>
${addForm(r)}
<nav class="tabs mt16" aria-label="סטטוס">${tab('', 'הכול', total)}${STATUS_ORDER.map((s) => tab(s, STATUS_HE[s][0], counts[s] || 0)).join('')}</nav>
<form class="inline-form mt12" method="get" action="/leads">${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ''}${all ? '<input type="hidden" name="all" value="1">' : ''}<input type="search" name="q" value="${esc(q)}" placeholder="חיפוש לפי שם או דומיין"><button class="btn" type="submit">${icon('search')}חיפוש</button></form>
<section class="panel mt16">${rows.length ? rows.map((x) => leadRow(x)).join('') : `<div class="empty">${icon('leads')}<b>אין כאן לידים</b>אפשר להוסיף חנות לפי כתובת, או להריץ חיפוש בהגדרות.</div>`}</section>`;
  return layout({ ...r.ctx, title: 'לידים', active: 'leads' }, body);
}

export function addForm(r: DashReq) {
  if (!r.scope.operator) return '';
  return `<form class="panel inline-form" method="post" action="/leads/add">${csrfField(r.ctx)}<input type="url" name="url" placeholder="https://store.co.il" aria-label="כתובת של חנות" required inputmode="url" dir="ltr"><button class="btn primary" type="submit">${icon('plus')}להוסיף ולבנות דף</button></form>`;
}

/** The store's own channels: its email address, connected or not, and the automated mail that came to it (Gmail's forwarding confirmation lands there). */
function channelsPanel(r: DashReq, id: number, account: any, address: string, automatedMail: any[], wa: string, social: string, ownDomain = '') {
  const on = account?.status === 'active';
  return `<section class="panel" id="channels"><header><h2>ערוצים של החנות</h2></header>
  <dl class="kv"><dt>וואטסאפ</dt><dd>${wa}</dd>${social}<dt>מייל</dt><dd>${on ? `<bdi class="ltr">${esc(account.external_id)}</bdi> · <span class="chip ok">מחובר</span>` : '<span class="chip ghost">לא מחובר</span>'}</dd></dl>
  ${on ? `<p class="small mt12 m0">מעבירים לכתובת הזו את המייל של החנות, למשל ב־Gmail: הגדרות, "העברה ו־POP/IMAP", "הוספת כתובת להעברה". Gmail שולח לכתובת קוד אישור, והוא מופיע כאן למטה ובשיחות. תורן עונה משם בשם החנות.</p>
  ${automatedMail.length ? `<div class="list mt12">${automatedMail.map((m) => `<a href="/chat/${m.id}"><span class="ico warn">${icon('alert')}</span><span class="t"><b>${esc(m.subject || 'מייל אוטומטי')}</b><small>${esc(ago(m.at))} · מייל אוטומטי, תורן לא ענה</small></span></a>`).join('')}</div>` : ''}
  <div class="row mt12">${postButton(r.ctx, `/lead/${id}/channels/email`, 'לנתק את המייל', { cls: 'btn sm danger', fields: { on: '0' }, confirm: 'לנתק? מיילים שיגיעו לכתובת יישמרו, ותורן לא יענה עליהם.' })}</div>${ownDomain}`
  : `<p class="small mt12 m0">החנות מקבלת כתובת משלה, <bdi class="ltr">${esc(address)}</bdi>, ומעבירה אליה את המייל שלה. תורן עונה משם בשם החנות, ומה שהוא לא יודע עובר אליך.</p>
  <div class="row mt12">${postButton(r.ctx, `/lead/${id}/channels/email`, 'לחבר מייל', { cls: 'btn sm primary', fields: { on: '1' } })}</div>`}
</section>`;
}

async function leadPage(app: App, r: DashReq, id: number) {
  const s = await app.db.one<any>('SELECT * FROM stores WHERE id = $1', [id]);
  if (!s) return null;
  const stats = await pageStats(app, id);
  const pack = await app.db.one<any>("SELECT (SELECT COUNT(*)::int FROM products WHERE store_id = $1 AND gone_at IS NULL) AS products, (SELECT COUNT(*)::int FROM policies WHERE store_id = $1) AS policies, (SELECT COUNT(*)::int FROM faqs WHERE store_id = $1) AS faqs", [id]);
  const convs = await app.db.query<any>(`SELECT c.*, (SELECT text FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_text FROM conversations c WHERE store_id = $1 AND ${messagingSql('channel')} ORDER BY last_at DESC LIMIT 10`, [id]);
  const mailOn = enabledChannels(app.env).has('email') && Boolean(app.mail);
  const mailAccount = mailOn ? await app.db.one<any>("SELECT id, external_id, status, connected_at FROM channel_accounts WHERE store_id = $1 AND channel = 'email' ORDER BY id DESC LIMIT 1", [id]) : null;
  const automatedMail = mailAccount ? await app.db.query<any>("SELECT c.id, c.meta->>'subject' AS subject, m.at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.account_id = $1 AND m.automated IS NOT NULL ORDER BY m.id DESC LIMIT 3", [mailAccount.id]) : [];
  const events = await app.db.query<any>("SELECT kind, at, data FROM events WHERE store_id = $1 AND kind NOT IN ('scroll', 'wa_in', 'wa_out', 'mail_in', 'mail_out', 'fb_in', 'fb_out', 'ig_in', 'ig_out') ORDER BY at DESC LIMIT 25", [id]);
  const cost = await app.db.one<any>("SELECT COALESCE(SUM(usd), 0)::float AS usd, COALESCE(SUM(api_usd), 0)::float AS api, COALESCE(SUM(in_tokens + cache_read + cache_write), 0)::int AS tin, COALESCE(SUM(out_tokens), 0)::int AS tout FROM usage WHERE store_id = $1", [id]);
  const job = await app.db.one<any>("SELECT id, status, progress, last_error FROM jobs WHERE dedupe_key = $1 ORDER BY id DESC LIMIT 1", [`ingest:${id}`]);
  // Messenger and Instagram, where their code is on (TORAN_CHANNELS).
  let social = '';
  for (const ch of SOCIAL.filter((c) => enabledChannels(app.env).has(c))) {
    const a = await socialAccountOf(app, id, ch);
    social += `<dt>${esc(CHANNEL_HE[ch])}</dt><dd>${socialLine(a && a.status !== 'off' ? a : null, ch, s, socialReady(app.env, ch))}</dd>`;
  }
  const url = s.slug ? pitchUrl(app.env, s.slug) : null;
  const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
  const target = contactTarget(s);
  const ready = s.page_built_at && s.approved_at;

  const parts = (s.score_breakdown || []).map((f: any) => `<li class="${f.points < 0 ? 'neg' : ''}"><span>${esc(FACTOR_HE[f.factor] || f.factor)}</span>${f.max ? vbar(f.points, f.max) : '<span></span>'}<b>${f.points}${f.max ? `/${f.max}` : ''}</b><span class="ev" dir="auto">${esc(f.evidence)}</span></li>`).join('');

  const sendBox = () => {
    if (s.taken_down_at) return '<p class="muted m0">העמוד הוסר, ולא כותבים להם יותר.</p>';
    if (!s.page_built_at) return `<p class="muted m0">עוד אין דף. ${canIngest(s.platform) ? 'אפשר לבנות אותו מכאן.' : `עם ${esc(PLATFORM_HE[s.platform] || s.platform)} זה עוד לא עובד, רק עם Shopify, WooCommerce ו־Wix.`}</p>`;
    if (!s.approved_at) return `<p class="muted m0">הדף מחכה לבדיקה שלך לפני שאפשר לשלוח אותו. <a href="/lead/${id}/review">לבדיקה</a></p>`;
    if (!s.sent_at) {
      const text = firstMessage({ storeName: name, url: url! });
      return `<label class="f">ההודעה הראשונה<textarea id="first-msg" rows="6" dir="rtl">${esc(text)}</textarea></label>
<div class="row mt12"><button class="btn primary" type="button" data-copy="#first-msg" ${target.href ? `data-open="${esc(target.href)}"` : ''} data-done="ההודעה הועתקה">${icon('copy')}${esc(target.label)}</button>${postButton(r.ctx, `/lead/${id}/sent`, 'שלחתי', { cls: 'btn', iconName: 'send' })}</div>
<p class="small muted mt8 m0">${target.kind ? `נשלח ל${target.kind === 'whatsapp' ? 'וואטסאפ של החנות' : `מייל ${esc(s.contact_email)}`}.` : 'לא נמצאה דרך ליצור קשר באתר.'} את ההודעה שולחים ידנית מהטלפון, ואחר כך לוחצים "שלחתי".</p>`;
    }
    if (!s.followup_sent_at && ['sent', 'opened'].includes(s.status)) {
      const due = s.followup_due_at ? new Date(s.followup_due_at).getTime() : followupDue(new Date(s.sent_at).getTime());
      const text = reminderMessage({ storeName: name, url: url! });
      return `<p class="m0">נשלח ${esc(ago(s.sent_at))}. ${due <= now() ? '<b>הגיע הזמן לתזכורת האחת.</b>' : `התזכורת האחת תהיה מוכנה ב־${esc(stamp(due))}.`}</p>
${due <= now() ? `<label class="f mt12">התזכורת<textarea id="rem-msg" rows="4" dir="rtl">${esc(text)}</textarea></label><div class="row mt12"><button class="btn primary" type="button" data-copy="#rem-msg" ${target.href ? `data-open="${esc(target.href)}"` : ''} data-done="התזכורת הועתקה">${icon('copy')}${esc(target.label)}</button>${postButton(r.ctx, `/lead/${id}/followup-sent`, 'שלחתי את התזכורת', { cls: 'btn' })}</div>` : ''}`;
    }
    return `<p class="muted m0">נשלח ${esc(ago(s.sent_at))}${s.followup_sent_at ? `, והתזכורת ${esc(ago(s.followup_sent_at))}. מכאן לא כותבים להם יותר.` : '.'}</p>`;
  };

  const statusForm = `<form class="row" method="post" action="/lead/${id}/status">${csrfField(r.ctx)}<select name="status" aria-label="סטטוס">${STATUS_ORDER.map((x) => `<option value="${x}"${x === s.status ? ' selected' : ''}>${STATUS_HE[x][0]}</option>`).join('')}</select><button class="btn sm" type="submit">לעדכן</button></form>`;

  const body = `<a class="back" href="/leads">${icon('chev')}לידים</a>
<div class="head"><div class="row">${storeBadge(s, 'initial lg')}<div><h1 class="title">${esc(name)}</h1></div></div>
  <p class="sub"><a href="${esc(s.url)}" target="_blank" rel="noopener"><bdi class="ltr">${esc(s.domain)}</bdi></a> · ${esc(PLATFORM_HE[s.platform] || s.platform)} · ${statusChip(s.status, Boolean(s.approved_at))}${s.reject_reason ? ` · <span class="chip bad">${esc(s.reject_reason)}</span>` : ''}</p>
  <div class="end">${url ? `<a class="btn sm" href="${esc(url)}?preview=1" target="_blank" rel="noopener">${icon('eye')}הדף</a>` : ''}${s.page_built_at ? `<a class="btn sm" href="/lead/${id}/review">${icon('edit')}בדיקה ועריכה</a>` : ''}</div>
</div>
${job && ['queued', 'running'].includes(job.status) ? `<div class="banner info" data-wait-job="${job.id}">${icon('clock')}<div><b>בעבודה</b><p data-progress>${esc(job.progress || 'בתור')}</p></div></div>` : ''}
${job?.status === 'failed' ? `<div class="banner bad">${icon('alert')}<div><b>הקריאה האחרונה של האתר נכשלה</b><p>${esc(job.last_error || '')}</p></div></div>` : ''}
${s.taken_down_at ? `<div class="banner bad">${icon('alert')}<div><b>העמוד הוסר ${esc(stamp(s.taken_down_at))}</b><p>הקישור כבר לא עובד, הקוד של הדמו כבוי, ולא כותבים להם יותר.</p></div></div>` : s.takedown_asked_at ? `<div class="banner warn">${icon('alert')}<div><b>לחצו על "להוריד את העמוד הזה" ${esc(stamp(s.takedown_asked_at))}</b><p>אם הגיעה מהם הודעה בוואטסאפ, מורידים את העמוד מכאן. הלחיצה לבד עוד לא מורידה אותו.</p></div>${postButton(r.ctx, `/lead/${id}/takedown`, 'להוריד את העמוד', { cls: 'btn sm danger', confirm: 'להוריד את העמוד? הקישור והקוד של הדמו יפסיקו לעבוד.' })}</div>` : ''}
${waBanner(await waAccountOf(app, id), id)}
<div class="cols">
  <div class="grid12">
    <section class="panel"><header><h2>שליחה</h2></header>${sendBox()}</section>
    <section class="panel"><header><h2>הציון</h2><span class="end">${scoreNum(s.score, s.qualified)}</span></header><ul class="parts">${parts}</ul></section>
    ${mailOn ? channelsPanel(r, id, mailAccount, storeAddress(s, app.mail!.domain), automatedMail, waLine(await waAccountOf(app, id).then((a) => (a && a.status !== 'off' ? a : null)), s, waConnectReady(app.env)), social, mailAccount?.status === 'active' ? await mailDomainPanel(app, r, id, mailAccount.external_id) : '') : `<section class="panel" id="channels"><header><h2>ערוצים של החנות</h2></header><dl class="kv"><dt>וואטסאפ</dt><dd>${waLine(await waAccountOf(app, id).then((a) => (a && a.status !== 'off' ? a : null)), s, waConnectReady(app.env))}</dd>${social}</dl></section>`}
    <section class="panel"><header><h2>שיחות</h2><a class="end small" href="/chats?store=${id}">כולן</a></header>
      ${convs.length ? `<div class="list">${convs.map((c) => `<a href="/chat/${c.id}"><span class="ico ${c.handoffs ? 'bad' : c.misses ? 'warn' : ''}">${icon(c.handoffs ? 'hand' : 'chat')}</span><span class="t"><b>${esc((c.last_text || '').replace(/\n/g, ' ').slice(0, 80))}</b><small>${esc(CHANNEL_HE[c.channel as keyof typeof CHANNEL_HE] || c.channel)} · ${esc(ago(c.last_at))}${c.handoffs ? ` · ${c.handoffs} העברות` : ''}${c.misses ? ` · ${c.misses} פספוסים` : ''}</small></span></a>`).join('')}</div>` : '<p class="muted m0">עוד אין שיחות.</p>'}
    </section>
  </div>
  <div class="grid12">
    <section class="panel"><header><h2>הדף</h2></header>
      ${s.page_built_at ? `<dl class="kv"><dt>כתובת</dt><dd><a href="${esc(url!)}?preview=1" target="_blank" rel="noopener"><bdi class="ltr">${esc(url!)}</bdi></a></dd><dt>קוד דמו</dt><dd class="ltr">${esc(s.demo_code)}</dd><dt>נפתח</dt><dd>${stats?.opens ? `${stats.opens} פעמים, ${stats.visitors} אנשים, אחרון ${esc(ago(stats.last))}` : 'עוד לא'}</dd><dt>גלילה</dt><dd>${stats?.depth ? `עד ${stats.depth}%` : '-'}</dd><dt>לחיצות על הדמו</dt><dd>${stats?.clicks || 0}</dd><dt>הדמו התחיל</dt><dd>${s.demo_started_at ? esc(stamp(s.demo_started_at)) : 'עוד לא'}</dd></dl>` : '<p class="muted m0">עוד לא נבנה.</p>'}
      <div class="row mt16">${canIngest(s.platform) ? postButton(r.ctx, `/lead/${id}/build`, s.page_built_at ? 'לקרוא את האתר מחדש' : 'לבנות דף', { cls: s.page_built_at ? 'btn sm' : 'btn primary sm', iconName: 'refresh' }) : ''}${s.status !== 'skipped' ? postButton(r.ctx, `/lead/${id}/skip`, 'לדלג', { cls: 'btn sm danger', confirm: 'לדלג על החנות?' }) : ''}${s.page_built_at && !s.taken_down_at ? postButton(r.ctx, `/lead/${id}/takedown`, 'להוריד את העמוד', { cls: 'btn sm', confirm: 'להוריד את העמוד? הקישור והקוד של הדמו יפסיקו לעבוד.' }) : ''}</div>
    </section>
    <section class="panel"><header><h2>מה נמצא באתר</h2></header>
      <dl class="kv">
        <dt>וואטסאפ</dt><dd>${s.contact_whatsapp ? `<bdi class="ltr">+${esc(s.contact_whatsapp)}</bdi>` : s.signals?.whatsappWidget ? `כפתור צ׳אט (${esc(s.signals.whatsappWidget)})` : 'לא נמצא'}</dd>
        <dt>מייל</dt><dd>${s.contact_email ? `<bdi class="ltr">${esc(s.contact_email)}</bdi>` : 'לא נמצא'}</dd>
        <dt>טלפון</dt><dd>${s.contact_phone ? `<bdi class="ltr">+${esc(s.contact_phone)}</bdi>` : 'לא נמצא'}</dd>
        <dt>ידע</dt><dd>${pack?.products ? `${pack.products} מוצרים · ${pack.policies} דפי מדיניות · ${pack.faqs} שאלות` : 'עוד לא נקרא'}</dd>
        <dt>נמצא דרך</dt><dd>${esc(s.source)}${s.source_detail?.query ? ` · "${esc(s.source_detail.query)}"` : ''}${s.source_detail?.from ? ` · מ־<bdi class="ltr">${esc(s.source_detail.from)}</bdi>` : ''}</dd>
        <dt>עלות עד עכשיו</dt><dd>${r.ctx.dev ? `$${Number(cost?.usd || 0).toFixed(3)} (במחירי API: $${Number(cost?.api || 0).toFixed(3)})` : `${tokenNum(cost?.api)} טוקנים`} · ${Number(cost?.tin || 0).toLocaleString('en-US')} טוקני קלט, ${Number(cost?.tout || 0).toLocaleString('en-US')} פלט</dd>
      </dl>
    </section>
    <section class="panel"><header><h2>סטטוס</h2></header>${statusForm}
      <form class="mt12" method="post" action="/lead/${id}/notes">${csrfField(r.ctx)}<label class="f">הערות<textarea name="notes" rows="3" dir="auto">${esc(s.notes || '')}</textarea></label><button class="btn sm mt8" type="submit">לשמור</button></form>
    </section>
    ${s.workspace_id ? `<section class="panel" id="plan"><header><h2>החבילה של הלקוח</h2></header>
      <form class="row" method="post" action="/lead/${id}/plan">${csrfField(r.ctx)}<select name="plan" aria-label="חבילה">${(Object.keys(PLANS) as PlanKey[]).map((k) => `<option value="${k}"${planOf(s.config) === k ? ' selected' : ''}>${esc(PLANS[k].he)}, עד ${PLANS[k].conversations.toLocaleString('en-US')} שיחות</option>`).join('')}</select><button class="btn sm" type="submit">לשמור</button></form>
      <p class="small muted mt8 m0">הלקוח רואה את החבילה ואת השיחות של החודש בעמוד "החבילה". המחיר והחשבוניות נשארים ב-accounts.</p>
    </section>` : ''}
    <section class="panel"><header><h2>מה קרה</h2></header><ol class="trace">${events.map((e) => `<li class="ok"><b>${esc(EVENT_HE[e.kind] || e.kind)}</b> <span class="d">${esc(stamp(e.at))}</span></li>`).join('') || '<li>עוד כלום</li>'}</ol></section>
  </div>
</div>${ready ? '' : ''}`;
  return layout({ ...r.ctx, title: name, active: 'lead' }, body);
}

const EVENT_HE: Record<string, string> = { lead_found: 'נמצא', ingest: 'האתר נקרא', page_built: 'הדף נבנה', approved: 'אושר', sent: 'נשלח', followup_sent: 'נשלחה תזכורת', page_open: 'הדף נפתח', demo_click: 'לחצו על הדמו', demo_bound: 'הדמו התחיל', handoff: 'העברה אליך', guard_cut: 'משפט נמחק לפני השליחה', takedown_click: 'לחצו על "להוריד את העמוד הזה"', owner_reply: 'ענית ללקוח', held: 'הודעה חיכתה לך, ותורן לא ענה', mail_automated: 'הגיע מייל אוטומטי', mail_blocked: 'מייל לא נשלח', wa_blocked: 'הודעה לא נשלחה', taken_down: 'העמוד הוסר', rescrape: 'רענון יומי', status: 'שינוי סטטוס', skipped: 'דילגת' };

export function leadRoutes(app: App): Route<DashReq>[] {
  const store = async (id: string) => {
    const s = await app.db.one<any>('SELECT * FROM stores WHERE id = $1', [Number(id)]);
    if (!s) throw new ActionError('אין חנות כזו', 404);
    return s;
  };
  return [
    ['GET', /^\/leads$/, async (r) => ({ html: await leadsPage(app, r) })],
    ['GET', /^\/lead\/(\d+)$/, async (r, m) => {
      const html = await leadPage(app, r, Number(m[1]));
      if (!html) throw new ActionError('אין ליד כזה', 404);
      return { html };
    }],
    ['POST', /^\/leads\/add$/, async (r) => {
      const url = homeUrl(r.form.url || '');
      if (!url || !canonicalDomain(url)) throw new ActionError('זו לא כתובת של אתר');
      const domain = canonicalDomain(url)!;
      const existing = await app.db.one<{ id: number }>('SELECT id FROM stores WHERE domain = $1', [domain]);
      if (existing) {
        await enqueue(app.db, 'ingest', { storeId: existing.id }, { dedupeKey: `ingest:${existing.id}` });
        return { redirect: `/lead/${existing.id}`, message: 'החנות כבר ברשימה. אני קורא את האתר שלה מחדש.' };
      }
      await app.db.query("DELETE FROM seen_domains WHERE domain = $1 AND verdict = 'failed'", [domain]);
      const job = await enqueue(app.db, 'add_store', { url, by: r.user.name }, { dedupeKey: `add:${domain}`, maxAttempts: 1 });
      await audit(app.db, { actor: r.user.name, action: 'add_store', detail: { url } });
      return { redirect: `/job/${job}`, message: 'בודק את החנות' };
    }],
    ['GET', /^\/job\/(\d+)$/, async (r, m) => {
      const j = await app.db.one<any>('SELECT * FROM jobs WHERE id = $1', [Number(m[1])]);
      if (!j) throw new ActionError('אין עבודה כזו', 404);
      const storeId = j.result?.storeId;
      if (j.status === 'done' && storeId) return { redirect: `/lead/${storeId}` };
      const body = `<div class="head"><h1>${j.status === 'failed' ? 'זה לא הצליח' : 'עובד על זה'}</h1><p class="sub"><bdi class="ltr">${esc(j.payload?.url || '')}</bdi></p></div>
${j.status === 'failed' ? `<div class="banner bad">${icon('alert')}<div><b>לא הצלחתי להוסיף את החנות</b><p>${esc(j.last_error || '')}</p></div><a class="btn sm" href="/leads">חזרה</a></div>` : j.status === 'done' ? `<div class="banner warn">${icon('alert')}<div><b>החנות נוספה, בלי דף</b><p>${esc(j.result?.why || '')}</p></div></div>` : `<div class="panel" data-wait-job="${j.id}"><p class="m0"><b data-progress>${esc(j.progress || 'בתור')}</b></p><p class="small muted mt8 m0">בודק את האתר, קורא את המוצרים והמדיניות, ובונה את הדף ואת שיחת הדוגמה. זה לוקח דקה או שתיים. הדף יתרענן לבד.</p></div>`}`;
      return { html: layout({ ...r.ctx, title: 'מוסיף חנות', active: 'add' }, body) };
    }],
    ['POST', /^\/lead\/(\d+)\/channels\/email$/, async (r, m) => {
      const s = await store(m[1]);
      if (!enabledChannels(app.env).has('email') || !app.mail) throw new ActionError('המייל עוד כבוי בשרת (TORAN_CHANNELS).');
      const address = storeAddress(s, app.mail.domain);
      if (r.form.on === '1') {
        const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
        const taken = await app.db.one<{ store_id: number }>("SELECT store_id FROM channel_accounts WHERE channel = 'email' AND external_id = $1", [address]);
        if (taken && taken.store_id !== s.id) throw new ActionError('הכתובת הזו כבר שייכת לחנות אחרת.');
        await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', $2, $3, $4) ON CONFLICT (channel, external_id) DO UPDATE SET status = 'active', kind = EXCLUDED.kind, name = EXCLUDED.name, connected_at = now()", [s.id, app.mail.kind, address, name]);
      } else {
        await app.db.query("UPDATE channel_accounts SET status = 'off' WHERE store_id = $1 AND channel = 'email'", [s.id]);
      }
      await audit(app.db, { actor: r.user.name, action: r.form.on === '1' ? 'email_connect' : 'email_disconnect', storeId: s.id, detail: { address } });
      return { redirect: r.scope.operator ? `/lead/${s.id}#channels` : '/settings#channels', message: r.form.on === '1' ? `המייל מחובר. מעבירים אליו את המייל של החנות: ${address}` : 'המייל נותק. תורן לא עונה יותר על מיילים לכתובת הזו.' };
    }],
    ['POST', /^\/lead\/(\d+)\/build$/, async (r, m) => {
      const s = await store(m[1]);
      if (!canIngest(s.platform)) throw new ActionError('כרגע זה עובד רק עם חנויות Shopify, WooCommerce ו־Wix');
      await enqueue(app.db, 'ingest', { storeId: s.id }, { dedupeKey: `ingest:${s.id}` });
      await audit(app.db, { actor: r.user.name, action: 'ingest', storeId: s.id });
      return { redirect: `/lead/${s.id}`, message: 'קורא את האתר ובונה את הדף. העמוד יתעדכן לבד.' };
    }],
    ['POST', /^\/lead\/(\d+)\/approve$/, async (r, m) => {
      const s = await store(m[1]);
      if (!s.page_built_at) throw new ActionError('אין עדיין דף לאשר');
      if (s.taken_down_at) throw new ActionError('העמוד הזה הוסר, ואי אפשר לאשר אותו שוב.');
      const gaps = await pitchGaps(app, s);
      if (gaps.length) throw new ActionError(`עוד אי אפשר לאשר. ${gaps[0].he}`);
      await app.db.query('UPDATE stores SET approved_at = now(), updated_at = now() WHERE id = $1', [s.id]);
      await event(app.db, s.id, 'approved', { by: r.user.name });
      await audit(app.db, { actor: r.user.name, action: 'approve', storeId: s.id });
      return { message: `${s.brand?.name || s.name || s.domain} מוכנה לשליחה`, redirect: r.form.next || undefined };
    }],
    // "Take this page down": confirmed here, after the request arrived. The page and its demo code stop working,
    // open demo bindings end, the reminder is cancelled, and the store is skipped: a takedown is an opt-out.
    ['POST', /^\/lead\/(\d+)\/takedown$/, async (r, m) => {
      const s = await store(m[1]);
      if (s.taken_down_at) throw new ActionError('העמוד כבר הוסר');
      await app.db.tx(async (t) => {
        await t.query("UPDATE stores SET taken_down_at = now(), status = 'skipped', skipped_at = COALESCE(skipped_at, now()), followup_due_at = NULL, updated_at = now() WHERE id = $1", [s.id]);
        await t.query('DELETE FROM wa_users WHERE store_id = $1', [s.id]);
        await event(t, s.id, 'taken_down', { by: r.user.name, asked: Boolean(s.takedown_asked_at) });
      });
      await audit(app.db, { actor: r.user.name, action: 'takedown', storeId: s.id });
      return { message: 'העמוד הוסר. הקישור והקוד של הדמו כבר לא עובדים.' };
    }],
    ['POST', /^\/lead\/(\d+)\/unapprove$/, async (r, m) => {
      const s = await store(m[1]);
      await app.db.query('UPDATE stores SET approved_at = NULL WHERE id = $1', [s.id]);
      // A hold: the page does not approve itself again until it is built again (pitch/ready.ts autoApprove).
      await event(app.db, s.id, 'unapproved', { by: r.user.name });
      await audit(app.db, { actor: r.user.name, action: 'unapprove', storeId: s.id });
      return { message: 'האישור בוטל' };
    }],
    ['POST', /^\/lead\/(\d+)\/sent$/, async (r, m) => {
      const s = await store(m[1]);
      if (!s.approved_at) throw new ActionError('צריך לאשר את הדף לפני ששולחים');
      if (s.sent_at) throw new ActionError('כבר סומן כנשלח');
      const t = now();
      await app.db.query("UPDATE stores SET sent_at = $2, followup_due_at = $3, status = CASE WHEN status IN ('new', 'page_ready') THEN 'sent' ELSE status END, updated_at = now() WHERE id = $1", [s.id, new Date(t).toISOString(), new Date(followupDue(t)).toISOString()]);
      await event(app.db, s.id, 'sent', { by: r.user.name });
      await audit(app.db, { actor: r.user.name, action: 'sent', storeId: s.id });
      return { message: 'סומן כנשלח. התזכורת האחת תחכה במעקב.' };
    }],
    ['POST', /^\/lead\/(\d+)\/followup-sent$/, async (r, m) => {
      const s = await store(m[1]);
      if (!s.sent_at) throw new ActionError('עוד לא נשלחה הודעה ראשונה');
      if (s.followup_sent_at) throw new ActionError('כבר נשלחה תזכורת אחת. מכאן לא כותבים להם יותר.');
      await app.db.query('UPDATE stores SET followup_sent_at = now(), updated_at = now() WHERE id = $1', [s.id]);
      await event(app.db, s.id, 'followup_sent', { by: r.user.name });
      await audit(app.db, { actor: r.user.name, action: 'followup_sent', storeId: s.id });
      return { message: 'התזכורת סומנה. זו הייתה האחרונה.' };
    }],
    ['POST', /^\/lead\/(\d+)\/skip$/, async (r, m) => {
      const s = await store(m[1]);
      await app.db.query("UPDATE stores SET status = 'skipped', skipped_at = now(), notes = CASE WHEN $2 <> '' THEN COALESCE(notes || E'\\n', '') || $2 ELSE notes END, updated_at = now() WHERE id = $1", [s.id, String(r.form.reason || '')]);
      await event(app.db, s.id, 'skipped', { reason: r.form.reason || null });
      await audit(app.db, { actor: r.user.name, action: 'skip', storeId: s.id, detail: { reason: r.form.reason || null } });
      return { message: 'דילגתי על החנות' };
    }],
    ['POST', /^\/lead\/(\d+)\/status$/, async (r, m) => {
      const s = await store(m[1]);
      const to = String(r.form.status || '');
      if (!STATUS_ORDER.includes(to)) throw new ActionError('סטטוס לא מוכר');
      await app.db.query('UPDATE stores SET status = $2, updated_at = now() WHERE id = $1', [s.id, to]);
      await event(app.db, s.id, 'status', { from: s.status, to });
      await audit(app.db, { actor: r.user.name, action: 'status', storeId: s.id, detail: { from: s.status, to } });
      return { message: `הסטטוס עכשיו: ${STATUS_HE[to][0]}` };
    }],
    ['POST', /^\/lead\/(\d+)\/notes$/, async (r, m) => {
      const s = await store(m[1]);
      await app.db.query('UPDATE stores SET notes = $2 WHERE id = $1', [s.id, String(r.form.notes || '').slice(0, 4000)]);
      return { message: 'נשמר' };
    }],
  ];
}
