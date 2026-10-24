import type { App } from '../../app.ts';
import { displayName } from '../../ingest/brand.ts';
import { ask } from '../../assistant/index.ts';
import { ownersOf } from '../../owners/identity.ts';
import { lineNumber } from '../../owners/notify.ts';
import { accountsLinks } from '../accounts.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { csrfField, esc, icon, layout, postButton, stamp, storeBadge } from '../ui.ts';
import { storesOf } from '../workspace.ts';

// The owner's assistant on the dashboard (src/assistant): the chat, the one action waiting for "כן" with its two
// buttons, a few questions to start from, and the owner's WhatsApp numbers (linked in accounts), from which they can
// write to it too, on the owner line. Under /lead/<id>/, so server.ts lets only the store's own workspace in.

const STARTERS = ['מה קרה היום?', 'אילו שאלות מחכות לי?', 'על מה לקוחות שאלו השבוע?', 'מה אזל מהמלאי?'];

async function page(app: App, r: DashReq, id: number) {
  const s = await app.db.one<any>('SELECT id, name, domain, brand, brand_override, workspace_id FROM stores WHERE id = $1', [id]);
  if (!s) return null;
  const name = displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain;
  const msgs = (await app.db.query<{ role: string; text: string; via: string; at: string }>('SELECT role, text, via, at FROM assistant_messages WHERE store_id = $1 ORDER BY id DESC LIMIT 40', [id])).reverse();
  const pending = await app.db.one<{ summary: string }>("SELECT summary FROM assistant_actions WHERE store_id = $1 AND status = 'pending' AND created_at > now() - interval '30 minutes' ORDER BY id DESC LIMIT 1", [id]);
  const say = (text: string, label: string, cls = 'btn sm') => postButton(r.ctx, `/lead/${id}/assistant`, label, { cls, fields: { text } });
  const chat = msgs.length
    ? msgs.map((m) => `<div class="b ${m.role === 'owner' ? 'owner' : 'toran'}">${esc(m.text)}<span class="at">${esc(stamp(m.at))}${m.via === 'whatsapp' ? ' · וואטסאפ' : ''}</span></div>`).join('')
    : `<p class="muted m0">שאלו את תורן על החנות: מה קרה היום, אילו שאלות מחכות לכם, על מה לקוחות שואלים, מה אזל מהמלאי. הוא עושה משהו, כמו לשלוח תשובה ללקוח, רק אחרי שתכתבו לו כן.</p>`;
  const waiting = pending && !r.ctx.readOnly
    ? `<div class="pending row"><p class="m0">${icon('clock')}מחכה לאישור שלכם: ${esc(pending.summary)}</p><div class="row">${say('כן', 'כן', 'btn primary sm')}${say('לא', 'לא')}</div></div>`
    : '';
  const form = r.ctx.readOnly
    ? '<p class="muted m0">במצב צפייה אי אפשר לכתוב לעוזר.</p>'
    : `<div class="row starters">${STARTERS.map((q) => say(q, q)).join('')}</div>
<form method="post" action="/lead/${id}/assistant" class="mt12">${csrfField(r.ctx)}<textarea name="text" rows="2" dir="auto" required maxlength="2000" class="wide" aria-label="ההודעה לעוזר" placeholder="מה תרצו לדעת על החנות?"></textarea><div class="row mt8"><button class="btn primary sm" type="submit">${icon('send')}לשלוח</button></div></form>`;
  // The numbers the owner writes from are linked and verified in accounts (src/owners/identity.ts), never typed here.
  const owners = s.workspace_id ? await ownersOf(app, Number(s.workspace_id)) : [];
  const line = lineNumber(app.env);
  const linked = owners === null
    ? 'את המספרים המחוברים לא הצלחתי לבדוק כרגע.'
    : owners.length
      ? `מחוברים עכשיו: <bdi class="ltr">${owners.map((o) => esc(o.phone)).join(', ')}</bdi>`
      : s.workspace_id ? 'עוד לא חיברתם מספר.' : 'החנות הזאת עוד לא שייכת לחשבון של לקוח, אז אין לה מספרים מחוברים.';
  const wa = `<section class="panel mt16"><header><h2>לכתוב לעוזר מהוואטסאפ</h2></header>
<p class="small muted m0">מחברים מספר וואטסאפ בחשבון ב-OpenFrequency, ומהמספר הזה כותבים לתורן${line ? ` ב-<a class="ltr" href="https://wa.me/${esc(line)}">${esc(line)}</a>` : ''}. הוא עונה כעוזר שלכם, לא כמו ללקוח. ${linked}</p>
${r.ctx.readOnly ? '' : `<p class="mt8 m0"><a class="btn sm" href="${esc(accountsLinks(app.env).home)}">לחבר מספר בחשבון</a></p>`}
</section>`;
  const body = `<div class="head"><div class="row">${storeBadge({ id: s.id, name, domain: s.domain })}<h1 class="title">העוזר של ${esc(name)}</h1></div><p class="sub">תורן עונה לכם על החנות מתוך השיחות, השאלות שמחכות לכם והמוצרים באתר. את ההזמנות והעגלות של החנות הוא עוד לא רואה.</p></div>
<section class="panel assistant"><div class="chat">${chat}</div>${waiting}<span id="end"></span>${form}</section>
${wa}`;
  return layout({ ...r.ctx, title: `העוזר של ${name}`, active: 'assistant' }, body);
}

export function assistantRoutes(app: App): Route<DashReq>[] {
  return [
    // The menu's way in: the one store a customer has goes straight to its assistant; more than one, a list.
    ['GET', /^\/assistant$/, async (r) => {
      const stores = await app.db.query<any>(`SELECT id, name, domain, brand, brand_override FROM stores WHERE ${storesOf(r.scope)} AND status IN ('pilot', 'paid', 'demo_started') ORDER BY updated_at DESC LIMIT 50`);
      if (stores.length === 1) return { redirect: `/lead/${stores[0].id}/assistant` };
      const list = stores.length
        ? `<div class="list">${stores.map((s) => `<a href="/lead/${s.id}/assistant">${storeBadge({ id: s.id, name: displayName(s.brand_override?.name, s.brand?.name, s.name), domain: s.domain })}<span class="t"><b>${esc(displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain)}</b><small class="ltr">${esc(s.domain)}</small></span></a>`).join('')}</div>`
        : '<p class="muted">העוזר נפתח לחנות שתורן כבר עונה בה. אפשר לפתוח אותו גם מהעמוד של כל חנות, תחת "העוזר".</p>';
      return { html: layout({ ...r.ctx, title: 'העוזר', active: 'assistant' }, `<div class="head"><h1 class="title">העוזר</h1></div>${list}`) };
    }],
    ['GET', /^\/lead\/(\d+)\/assistant$/, async (r, m) => {
      const html = await page(app, r, Number(m[1]));
      if (!html) throw new ActionError('אין חנות כזו', 404);
      return { html };
    }],
    ['POST', /^\/lead\/(\d+)\/assistant$/, async (r, m) => {
      const text = String(r.form.text || '').replace(/\r\n?/g, '\n').trim();
      if (!text) throw new ActionError('ההודעה ריקה.');
      await ask(app, { storeId: Number(m[1]), text, via: 'dashboard', author: r.user.name });
      return { redirect: `/lead/${m[1]}/assistant#end` };
    }],
  ];
}
