import type { App } from '../../app.ts';
import { audit } from '../../db/log.ts';
import { MESSAGE_KINDS, queueState, retryJob } from '../../jobs/queue.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { ago, esc, layout, postButton, stamp } from '../ui.ts';

// The operator's view of the job queue (/queue): how many jobs wait and run, how long the oldest customer message has
// waited, and the jobs that failed every attempt in the last 14 days, each with "להריץ שוב". A customer's message that
// failed is also in its conversation for the owner (jobs/lost.ts); running it again is safe, since a message already
// written is a duplicate (channels/route.ts) and an answer already written is only sent, never written twice.

const KIND_HE: Record<string, string> = {
  wa_inbound: 'הודעה בוואטסאפ',
  mail_inbound: 'מייל',
  dm_inbound: 'הודעה במסנג׳ר או באינסטגרם',
  wa_echo: 'תשובה של בעלים מהטלפון',
  dm_echo: 'תשובה של בעלים מהעמוד',
  add_store: 'הוספת חנות',
  ingest: 'קריאת האתר',
  rescrape: 'קריאה יומית של האתר',
};

const who = (p: any) => [p?.from, p?.storeId ? `חנות ${p.storeId}` : null].filter(Boolean).join(' · ');

export function queuePage(r: DashReq, q: Awaited<ReturnType<typeof queueState>>): string {
  const waiting = q.oldestAt ? `הוותיקה מחכה ${esc(ago(q.oldestAt))}` : 'אין הודעות של לקוחות שמחכות';
  const rows = q.failed
    .map((j) => {
      const message = MESSAGE_KINDS.includes(j.kind);
      return `<li><div><b>${esc(KIND_HE[j.kind] || j.kind)}</b> <span class="small muted">#${j.id} · ${esc(stamp(j.done_at))} · ${j.attempts} ניסיונות${who(j.payload) ? ` · <bdi class="ltr">${esc(who(j.payload))}</bdi>` : ''}</span>
<p class="small m0 mt8"><bdi class="ltr">${esc(String(j.last_error || '').slice(0, 300))}</bdi></p>${message ? '<p class="small muted m0">ההודעה מחכה לבעלים גם בשיחה שלה.</p>' : ''}</div>
<span class="end">${postButton(r.ctx, `/queue/${j.id}/again`, 'להריץ שוב', { cls: 'btn sm' })}</span></li>`;
    })
    .join('');
  const body = `<div class="head"><h1>התור</h1><p class="sub">${q.queued} מחכות · ${q.running} רצות · ${q.messages} הודעות של לקוחות בתור · ${waiting}</p></div>
<section class="panel"><h2 class="small m0">עבודות שנכשלו ב-14 הימים האחרונים</h2>${rows ? `<ul class="keys mt8">${rows}</ul>` : '<p class="small muted m0 mt8">אין.</p>'}</section>`;
  return layout({ ...r.ctx, title: 'התור', active: 'leads' }, body);
}

export function queueRoutes(app: App): Route<DashReq>[] {
  const operator = (r: DashReq) => {
    if (!r.scope.operator) throw new ActionError('את התור רואים רק אנחנו, ב־OpenFrequency.', 403);
  };
  return [
    ['GET', /^\/queue$/, async (r) => {
      operator(r);
      return { html: queuePage(r, await queueState(app.db)) };
    }],
    ['POST', /^\/queue\/(\d+)\/again$/, async (r, m) => {
      operator(r);
      const id = Number(m[1]);
      if (!(await retryJob(app.db, id))) throw new ActionError('העבודה הזו כבר לא במצב נכשל.', 404);
      await audit(app.db, { actor: r.user.name, action: 'job_again', detail: { job: id } });
      return { redirect: '/queue', message: 'העבודה תרוץ שוב בדקה הקרובה.' };
    }],
  ];
}
