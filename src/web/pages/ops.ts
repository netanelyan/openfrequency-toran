import type { App } from '../../app.ts';
import { ago, csrfField, dayHe, esc, icon, postButton, stamp, storeBadge } from '../ui.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { accountsLinks } from '../accounts.ts';
import { customers, syncTeder, type Customer } from '../../ops/sources.ts';
import { conversations, queue, type Conversation, type Item } from '../../ops/queue.ts';
import { funnels, money, rate, type Stage } from '../../ops/funnel.ts';
import { LOST_REASONS } from '../../ops/messages.ts';
import { later, markLost, markReminded, markReplied, markSent, markWon, OpsError, reopen, sendDirect, setNext, type Kind } from '../../ops/actions.ts';

// The operator's dashboard (docs/operator.md): the top of Today for the superadmin outside view-as. Who to write to
// today, with the message ready; who is in a conversation; each product's funnel; the customers and the money from
// accounts. Teder's demos are copied in from Teder at each load, and accounts is read at each load: a service that
// does not answer leaves its part saying so.

const PRODUCT_HE: Record<Kind, string> = { toran: 'תורן', teder: 'טדר' };
const SHOWN = 25;
const ils = (n: number) => `${Number(n).toLocaleString('he-IL', Number.isInteger(n) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₪`;
const chip = (p: Kind) => `<span class="chip ${p === 'toran' ? 'sig' : 'ok'}">${PRODUCT_HE[p]}</span>`;
const badge = (key: string, name: string, domain: string) => storeBadge({ id: Number(key.replace(/\D/g, '')) || 0, name, domain });
const act = (ctx: { csrf: string }, kind: Kind, id: string, what: string, label: string, cls = 'btn', fields: Record<string, unknown> = {}) => postButton(ctx, `/ops/${kind}/${encodeURIComponent(id)}/${what}`, label, { cls, ajax: 'remove', fields });

// "Not interested" asks why first: the reasons open under it, and the choice is saved with the button beside them.
const lostForm = (ctx: { csrf: string }, kind: Kind, id: string) => `<details class="lost"><summary class="btn sm ghost">לא מעוניינים</summary><form method="post" action="/ops/${kind}/${encodeURIComponent(id)}/lost" data-ajax="remove" class="row">${csrfField(ctx)}<select name="reason" aria-label="למה">${Object.entries(LOST_REASONS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select><button class="btn sm" type="submit">לסמן</button></form></details>`;

const nextForm = (ctx: { csrf: string }, kind: Kind, id: string, text: string | null, ajax = 'reload') => `<form method="post" action="/ops/${kind}/${encodeURIComponent(id)}/next" data-ajax="${ajax}" class="row">${csrfField(ctx)}<input type="text" name="text" maxlength="300" value="${esc(text || '')}" placeholder="הצעד הבא, למשל: לשלוח הצעת מחיר" aria-label="הצעד הבא"><select name="days" aria-label="מתי"><option value="1">מחר</option><option value="3">בעוד 3 ימים</option><option value="7">בעוד שבוע</option><option value="14">בעוד שבועיים</option></select><button class="btn sm" type="submit">לשמור</button></form>`;

function card(r: DashReq, it: Item): string {
  const ctx = r.ctx;
  const lead = it.product === 'toran' ? `/lead/${it.id}` : it.page || '#';
  const msgId = `msg-${it.key.replace(':', '-')}`;
  const send = it.message
    ? `<div class="flags"><textarea id="${msgId}" rows="5" dir="rtl" class="wide" aria-label="ההודעה">${esc(it.message)}</textarea></div>`
    : `<div class="flags"><p class="m0">${esc(it.why)}</p></div>`;
  const buttons = it.mark === 'next'
    ? `${it.target.href ? `<a class="btn" href="${esc(it.target.href)}" target="_blank" rel="noopener">${icon('send')}לפתוח שיחה</a>` : ''}${nextForm(ctx, it.product, it.id, null)}${lostForm(ctx, it.product, it.id)}`
    : [
        it.direct ? act(ctx, it.product, it.id, 'direct', `${icon('send')}לשלוח עכשיו מהמספר של הדמו`, 'btn primary') : '',
        `<button class="btn${it.direct ? '' : ' primary'}" type="button" data-copy="#${msgId}" ${it.target.href ? `data-open="${esc(it.target.href)}"` : ''} data-done="ההודעה הועתקה">${icon('copy')}${esc(it.target.label)}</button>`,
        act(ctx, it.product, it.id, it.mark, 'שלחתי'),
        '<span class="break" aria-hidden="true"></span>',
        act(ctx, it.product, it.id, 'replied', 'ענו לי', 'btn sm ghost'),
        act(ctx, it.product, it.id, 'later', 'מחר', 'btn sm ghost', { days: 1 }),
        act(ctx, it.product, it.id, 'later', 'בעוד שבוע', 'btn sm ghost', { days: 7 }),
        lostForm(ctx, it.product, it.id),
      ].join('');
  return `<article class="card rcard ops" data-item>
  <div class="who">${badge(it.key, it.name, it.domain)}<div><h3><a href="${esc(lead)}">${esc(it.name)}</a> ${chip(it.product)}</h3><small>${esc(it.why)}${it.at ? ` · ${esc(ago(it.at))}` : ''} · <bdi class="ltr">${esc(it.domain)}</bdi></small></div></div>
  ${send}
  <div class="actions">${buttons}</div>
</article>`;
}

function conversationRow(r: DashReq, c: Conversation): string {
  const ctx = r.ctx;
  const due = c.next_step_at && new Date(c.next_step_at).getTime() <= Date.now();
  const won = c.product === 'toran'
    ? `${c.status !== 'pilot' ? act(ctx, 'toran', c.id, 'pilot', 'התחילו פיילוט', 'btn sm') : ''}${act(ctx, 'toran', c.id, 'paid', 'משלמים', 'btn sm')}`
    : act(ctx, 'teder', c.id, 'won', 'לקוח', 'btn sm');
  return `<article class="card rcard ops" data-item>
  <div class="who">${badge(c.key, c.name, c.domain)}<div><h3>${c.product === 'toran' ? `<a href="/lead/${esc(c.id)}">${esc(c.name)}</a>` : esc(c.name)} ${chip(c.product)}${c.status === 'pilot' ? ' <span class="chip sig">בפיילוט</span>' : ''}</h3><small>ענו ${esc(ago(c.replied_at))}${c.next_step_at ? ` · ${due ? '<b>' : ''}הצעד הבא ${esc(stamp(c.next_step_at))}${due ? '</b>' : ''}` : ''}${c.next_step ? `: ${esc(c.next_step)}` : ''}</small></div></div>
  <div class="actions">${c.target.href ? `<a class="btn sm" href="${esc(c.target.href)}" target="_blank" rel="noopener">${icon('send')}לפתוח שיחה</a>` : ''}${nextForm(ctx, c.product, c.id, c.next_step)}${won}${lostForm(ctx, c.product, c.id)}</div>
</article>`;
}

function funnelTable(title: string, stages: Stage[]): string {
  const pct = (n: number | null) => (n == null ? '' : `<small class="muted"> ${n}%</small>`);
  return `<div class="panel"><header><h2>${esc(title)}</h2></header><table class="funnel"><thead><tr><th scope="col">שלב</th><th scope="col">מתחילת הדרך</th><th scope="col">ב־30 הימים האחרונים</th></tr></thead><tbody>${stages
    .map((s, i) => `<tr><th scope="row">${esc(s.label)}</th><td><b class="num">${s.all}</b>${pct(rate(stages, i, 'all'))}</td><td><b class="num">${s.month}</b>${pct(rate(stages, i, 'month'))}</td></tr>`)
    .join('')}</tbody></table><p class="small muted mt8 m0">האחוז ליד כל שלב הוא מתוך השלב שלפניו.</p></div>`;
}

function moneyPanel(app: App, data: { today: string; workspaces: Customer[] } | null): string {
  const admin = accountsLinks(app.env).admin;
  if (!data) return `<div class="empty">${icon('alert')}<b>לא הצלחתי לקרוא את הלקוחות מ־accounts</b>הם מגיעים מ־GET /internal/ops/customers בשרת הזה. שאר הלוח עובד בלעדיהם.</div>`;
  const m = money(data.workspaces, data.today);
  const name = (w: Customer) => `<a href="${esc(admin)}">${esc(w.name)}</a>`;
  const list = (title: string, rows: string[], none: string) => `<section class="panel"><header><h2>${esc(title)}</h2></header>${rows.length ? `<ul class="plain">${rows.join('')}</ul>` : `<p class="muted m0">${esc(none)}</p>`}</section>`;
  return `<div class="kpis ops-money">
  <div class="kpi"><span class="l">הכנסה חודשית, לפני מע״מ</span><span class="v num">${esc(ils(m.mrr))}</span><span class="s">ממנויים ששולמו לחודש הזה</span></div>
  <div class="kpi"><span class="l">לקוחות משלמים</span><span class="v num">${m.paying.toran + m.paying.teder}</span><span class="s">תורן ${m.paying.toran} · טדר ${m.paying.teder}</span></div>
  <div class="kpi"><span class="l">באיחור</span><span class="v num">${m.late.length}</span><span class="s">התקופה ששולמה נגמרה</span></div>
</div>
${list('באיחור בתשלום', m.late.map((x) => `<li>${name(x.w)} · ${esc(x.product === 'toran' ? 'תורן' : 'טדר')} · ${esc(ils(x.monthly))} לחודש${x.since ? ` · מ־${esc(dayHe(x.since))}` : ''}</li>`), 'אין אף אחד באיחור.')}
${list('מחכים לתשלום הראשון', m.waiting.map((x) => `<li>${name(x.w)} · ${esc(x.product === 'toran' ? 'תורן' : 'טדר')} · ${esc(ils(x.monthly))} לחודש${x.setup ? `, ודמי הקמה ${esc(ils(x.setup))}` : ''}</li>`), 'אין מנויים שמחכים לתשלום ראשון.')}
${list('מתחדשים ב־7 הימים הקרובים', m.renewals.map((x) => `<li>${esc(dayHe(x.on))} · ${name(x.w)} · ${esc(x.product === 'toran' ? 'תורן' : 'טדר')} · ${esc(ils(x.monthly))}</li>`), 'אין חידושים בשבוע הקרוב.')}
<p class="small muted m0">הסכומים לפני מע״מ, כמו שנרשמו ב־accounts. <a href="${esc(admin)}">לניהול הלקוחות והחשבוניות</a></p>`;
}

/** The operator's sections, above the rest of Today. */
export async function opsSections(app: App, r: DashReq): Promise<string> {
  const tederOk = await syncTeder(app);
  const [q, convs, cust] = await Promise.all([queue(app), conversations(app), customers(app)]);
  const f = await funnels(app, cust?.workspaces || null);
  const m = cust ? money(cust.workspaces, cust.today) : null;
  const shown = q.items.slice(0, SHOWN);
  return `<div class="kpis ops-top">
  <a class="kpi lead" href="#contact"><span class="l">לפנות היום</span><span class="v">${q.items.length}</span><span class="s">${q.items.length ? 'ההודעה מוכנה בכל כרטיס. מעתיקים, שולחים ומסמנים' : 'אין למי לכתוב עכשיו'}</span></a>
  <div class="kpi side">
    <a href="#talking"><span class="l">בשיחה</span><span class="cnt ${convs.length ? 'sig' : 'zero'}">${convs.length}</span></a>
    <a href="#money"><span class="l">הכנסה חודשית</span><span class="cnt ${m?.mrr ? 'ok' : 'zero'}">${m ? esc(ils(m.mrr)) : '?'}</span></a>
    <a href="#money"><span class="l">באיחור</span><span class="cnt ${m?.late.length ? 'bad' : 'zero'}">${m ? m.late.length : '?'}</span></a>
    <a href="#funnel"><span class="l">ענו ב־30 יום</span><span class="cnt ${f.toran[6].month + f.teder[4].month ? 'ok' : 'zero'}">${f.toran[6].month + f.teder[4].month}</span></a>
  </div>
</div>
${tederOk ? '' : `<p class="small muted">את המצגות של טדר לא הצלחתי לקרוא עכשיו (GET /internal/demos). מה שמופיע מהן כאן הוא מהקריאה הקודמת.</p>`}
<section class="group" id="contact"><header><h2>לפנות היום</h2><span class="end small muted">קודם מי שניסו את הדמו, אחריהם מי שביקשו באתר, התזכורות, ובסוף דפים חדשים לפי הציון</span></header>
${shown.length ? `<div class="cards">${shown.map((it) => card(r, it)).join('')}</div>${q.items.length > SHOWN ? `<p class="small muted mt8">ועוד ${q.items.length - SHOWN}. הם יופיעו כאן כשהרשימה תתקצר.</p>` : ''}` : `<div class="empty">${icon('send')}<b>אין כרגע למי לכתוב</b>כאן יופיעו דפים מוכנים, תזכורות שהגיע זמנן, ומי שביקשו דמו באתר.</div>`}
${q.noContact.length ? `<details class="mt16"><summary>${q.noContact.length === 1 ? 'דף אחד מוכן, ואין לנו איך לפנות לחנות' : `${q.noContact.length} דפים מוכנים, ואין לנו איך לפנות לחנויות`}</summary><div class="list mt8">${q.noContact.slice(0, 30).map((s) => `<a href="/lead/${s.id}">${storeBadge(s)}<span class="t"><b>${esc(s.brand?.name || s.name || s.domain)}</b><small class="ltr">${esc(s.domain)}</small></span><span class="go">${icon('chev')}</span></a>`).join('')}</div><p class="small muted mt8 m0">אין באתר שלהן וואטסאפ או מייל. אפשר לחפש איש קשר באינסטגרם או בפייסבוק, ולהוסיף אותו בעמוד של הליד.</p></details>` : ''}
</section>
<section class="group" id="talking"><header><h2>בשיחה</h2></header>${convs.length ? `<div class="cards">${convs.map((c) => conversationRow(r, c)).join('')}</div>` : `<div class="empty">${icon('chat')}<b>אף אחד עוד לא בשיחה</b>מי שעונים לך עוברים לכאן כשמסמנים "ענו לי".</div>`}</section>
<section class="group" id="funnel"><header><h2>המשפך</h2></header><div class="ops-funnels">${funnelTable('תורן', f.toran)}${funnelTable('טדר', f.teder)}</div></section>
<section class="group" id="money"><header><h2>לקוחות וכסף</h2></header>${moneyPanel(app, cust)}</section>`;
}

const ACTIONS = ['sent', 'reminded', 'direct', 'replied', 'next', 'later', 'lost', 'reopen', 'pilot', 'paid', 'won'] as const;

export function opsRoutes(app: App): Route<DashReq>[] {
  return [
    ['POST', /^\/ops\/(toran|teder)\/([\w.:%-]{1,100})\/([a-z]+)$/, async (r, m) => {
      if (!r.scope.operator) throw new ActionError('אין כזה', 404);
      const kind = m[1] as Kind;
      const id = decodeURIComponent(m[2]);
      const what = m[3] as (typeof ACTIONS)[number];
      if (!ACTIONS.includes(what)) throw new ActionError('אין פעולה כזו', 404);
      const by = r.user.name;
      try {
        if (what === 'sent') await markSent(app, kind, id, by);
        else if (what === 'reminded') await markReminded(app, kind, id, by);
        else if (what === 'direct') {
          if (kind !== 'toran') throw new OpsError('אפשר לשלוח מהמספר של הדמו רק את תורן');
          await sendDirect(app, id, by);
        } else if (what === 'replied') await markReplied(app, kind, id, by);
        else if (what === 'next') await setNext(app, kind, id, String(r.form.text || ''), Number(r.form.days) || 1, by);
        else if (what === 'later') await later(app, kind, id, Number(r.form.days) || 1, by);
        else if (what === 'lost') await markLost(app, kind, id, String(r.form.reason || ''), by);
        else if (what === 'reopen') await reopen(app, kind, id, by);
        else if (what === 'pilot' || what === 'paid') {
          if (kind !== 'toran') throw new OpsError('פיילוט ותשלום נרשמים כאן רק לתורן');
          await markWon(app, kind, id, what, by);
        } else await markWon(app, kind, id, 'paid', by);
      } catch (e) {
        if (e instanceof OpsError) throw new ActionError(e.message);
        throw e;
      }
      const said: Record<string, string> = {
        sent: 'סומן שנשלח. התזכורת האחת תחכה כאן בעוד ארבעה ימים.',
        reminded: 'סומן. זו הייתה ההודעה האחרונה אליהם, אלא אם יכתבו.',
        direct: 'נשלח מהמספר של הדמו, וסומן שנשלח.',
        replied: 'עבר ל"בשיחה". הצעד הבא נקבע למחר, ואפשר לשנות אותו שם.',
        next: 'הצעד הבא נשמר.',
        later: 'יחזור לרשימה בזמן שבחרת.',
        lost: 'סומן שלא מעוניינים. לא נכתוב להם יותר.',
        reopen: 'חזר לרשימה.',
        pilot: 'סומן שהתחילו פיילוט.',
        paid: 'סומן שמשלמים.',
        won: 'סומן כלקוח.',
      };
      return { message: said[what] };
    }],
  ];
}
