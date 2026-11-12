import type { App } from '../../app.ts';
import { cartLine, cartReport, moneyHe, monthNow } from '../../auto/report.ts';
import { messagingSql } from '../../channels/config.ts';
import { esc, icon, layout } from '../ui.ts';
import type { DashReq, Route } from '../server.ts';
import { STATE_SQL } from '../inbox.ts';
import { myStores } from './customer.ts';

// The customer's Results (TORAN-READINESS.md P1-12; the owner, 2026-11-08: "copy everything good from the dashboard",
// Teder's Results, where the numbers that matter lead and the rest waits behind a button). What Toran did for the store
// this month, in the website's three words: answered alone (green, first), still waiting for the owner, fixed by the
// owner; the carts that came back and their money; the last three months side by side; and what was handed over this
// month, folded. Every number is the store's own conversations (never the demo number's), by the month of their last
// message, Israel's.

const TZ = 'Asia/Jerusalem';
const MONTH_HE = new Intl.DateTimeFormat('he-IL', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const monthHe = (ym: string) => MONTH_HE.format(new Date(`${ym}-15T00:00:00Z`));
const num = (n: number) => Number(n || 0).toLocaleString('en-US');

type Month = { month: string; alone: number; fixed: number; waiting: number };

async function results(app: App, r: DashReq) {
  const stores = await myStores(app, r.scope);
  const ids = stores.map((s) => s.id);
  const empty = `<div class="head"><h1>תוצאות</h1></div><div class="empty">${icon('chat')}<b>עוד אין תוצאות</b>כשהחנות מחוברת ולקוחות כותבים לה, תראו כאן כמה תורן ענה לבד, מה חיכה לכם ומה עגלות החזירו.</div>`;
  if (!ids.length) return layout({ ...r.ctx, title: 'תוצאות', active: 'results' }, empty);
  const inIds = ids.join(', ');
  const rows = await app.db.query<Month>(`SELECT to_char(c.last_at AT TIME ZONE '${TZ}', 'YYYY-MM') AS month,
      COUNT(*) FILTER (WHERE st = 'alone')::int AS alone, COUNT(*) FILTER (WHERE st = 'fixed')::int AS fixed, COUNT(*) FILTER (WHERE st = 'waiting')::int AS waiting
    FROM (SELECT c.last_at, ${STATE_SQL} AS st FROM conversations c WHERE ${messagingSql('c.channel')} AND c.account_id IS NOT NULL AND c.store_id IN (${inIds}) AND c.last_at > now() - interval '100 days') c
    GROUP BY 1 ORDER BY 1 DESC LIMIT 3`);
  const now = monthNow();
  const months: Month[] = [now, ...rows.map((x) => x.month).filter((m) => m !== now)].slice(0, 3).map((m) => rows.find((x) => x.month === m) || { month: m, alone: 0, fixed: 0, waiting: 0 });
  const cur = months[0];
  const carts = await cartReport(app.db, ids, 3);
  const cartsNow = carts.find((m) => m.month === now);
  const handed = await app.db.query<{ summary: string; conversation_id: number; at: string }>(`SELECT m.handoff->>'summary' AS summary, m.conversation_id, m.at FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.handoff IS NOT NULL AND c.account_id IS NOT NULL AND ${messagingSql('c.channel')} AND c.store_id IN (${inIds}) AND m.at >= date_trunc('month', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}' ORDER BY m.id DESC LIMIT 30`);
  // A handoff's line is written for the owner, in Hebrew when the model followed the store's language (inbox.ts).
  const he = handed.filter((h) => /[֐-׿]/.test(h.summary || ''));
  const total = cur.alone + cur.fixed + cur.waiting;

  const body = `<div class="head"><h1>תוצאות</h1><p class="sub">${esc(monthHe(now))}${stores.length > 1 ? '' : ` · ${esc(stores[0].name)}`}</p></div>
<div class="kpis">
  <a class="kpi lead" href="/chats?state=alone"><span class="l">תורן ענה לבד</span><span class="v ok">${num(cur.alone)}</span><span class="s">${total ? `מתוך ${num(total)} שיחות החודש` : 'שיחה נספרת כאן מהרגע שלקוח כותב לחנות'}</span></a>
  <div class="kpi side">
    <a href="/chats?state=waiting"><span class="l">מחכות לכם</span><span class="cnt ${cur.waiting ? 'sig' : 'zero'}">${num(cur.waiting)}</span></a>
    <a href="/chats?state=fixed"><span class="l">תיקנתם</span><span class="cnt ${cur.fixed ? 'sig' : 'zero'}">${num(cur.fixed)}</span></a>
    ${cartsNow ? `<a href="/settings#carts" title="${esc(cartLine(cartsNow))}"><span class="l">עגלות שחזרו</span><span class="cnt ${cartsNow.recovered ? 'ok' : 'zero'}">${cartsNow.recovered}${moneyHe(cartsNow.money) ? ` · ${esc(moneyHe(cartsNow.money))}` : ''}</span></a>` : ''}
  </div>
</div>
<section class="group mt24"><header><h2>שלושה חודשים</h2></header>
  <div class="panel"><div class="scrollx"><table class="table stack"><thead><tr><th>חודש</th><th>ענה לבד</th><th>מחכות לכם</th><th>תיקנתם</th><th>עגלות שחזרו</th></tr></thead><tbody>${months.map((m) => {
    const c = carts.find((x) => x.month === m.month);
    return `<tr><td data-k="חודש">${esc(monthHe(m.month))}</td><td class="n" data-k="ענה לבד">${num(m.alone)}</td><td class="n" data-k="מחכות לכם">${num(m.waiting)}</td><td class="n" data-k="תיקנתם">${num(m.fixed)}</td><td class="n" data-k="עגלות שחזרו">${c ? `${c.recovered}${moneyHe(c.money) ? ` · ${esc(moneyHe(c.money))}` : ''}` : '-'}</td></tr>`;
  }).join('')}</tbody></table></div>
  <p class="small muted mt12 m0">שיחה נספרת בחודש של ההודעה האחרונה בה. שיחות בדמו לא נספרות.</p></div>
</section>
${he.length ? `<section class="group mt24"><details class="panel"><summary><h2>מה תורן העביר אליכם החודש</h2><span class="chip">${he.length}</span></summary>
  <div class="list">${he.map((h) => `<a href="/chat/${Number(h.conversation_id)}"><span class="ico">${icon('hand')}</span><span class="t"><b>${esc(h.summary.slice(0, 140))}</b></span><span class="go">${icon('chev')}</span></a>`).join('')}</div>
  <p class="small muted mt12 m0">שאלה שחוזרת כאן כדאי לענות עליה פעם אחת ב<a href="/knowledge">מה תורן יודע</a>, ותורן יענה עליה לבד.</p>
</details></section>` : ''}`;
  return layout({ ...r.ctx, title: 'תוצאות', active: 'results' }, body);
}

export function resultsRoutes(app: App): Route<DashReq>[] {
  return [['GET', /^\/results$/, async (r) => ({ html: await results(app, r) })]];
}
