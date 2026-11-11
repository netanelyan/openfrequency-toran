import type { App } from '../../app.ts';
import { displayName } from '../../ingest/brand.ts';
import { ask } from '../../assistant/index.ts';
import { ownersOf } from '../../owners/identity.ts';
import { lineNumber } from '../../owners/notify.ts';
import { localPhone } from '../../core/urls.ts';
import { accountsLinks } from '../accounts.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { csrfField, esc, icon, layout, postButton, stamp, storeBadge } from '../ui.ts';
import { storesOf } from '../workspace.ts';

// The owner's assistant on the dashboard (src/assistant): the chat, the one action waiting for "כן" with its two
// buttons, a few questions to start from, and the owner's WhatsApp numbers (linked in accounts), from which they can
// write to it too: on the store's own WhatsApp number once it is connected, and on our number (the owner line). Under /lead/<id>/, so server.ts lets only the store's own workspace in.

/** The store's own WhatsApp number's digits, when one is connected here (on Meta, Kapso or Zernio); else null. */
export async function bizNumber(app: App, storeId: number): Promise<string | null> {
  const a = await app.db.one<{ kind: string; external_id: string; meta: any }>("SELECT kind, external_id, meta FROM channel_accounts WHERE store_id = $1 AND channel = 'whatsapp' AND status IN ('active', 'pending') ORDER BY id DESC LIMIT 1", [storeId]);
  if (!a) return null;
  // A number on the simulator (the demo, the tests) is its own id; on Meta, Kapso and Zernio the id is not the number.
  const d = String(a.meta?.display_phone_number || a.meta?.phone || (a.kind === 'sim' ? a.external_id : '')).replace(/\D/g, '');
  return d || null;
}

const STARTERS =['מה קרה היום?', 'אילו שאלות מחכות לי?', 'על מה לקוחות שאלו השבוע?', 'מה אזל מהמלאי?'];

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
  // One main button: while an action waits for "כן", that is it, and sending something else is the plain one (the
  // audit of 2026-11-12, P1-11).
  const form = r.ctx.readOnly
    ? '<p class="muted m0">במצב צפייה אי אפשר לכתוב לעוזר.</p>'
    : `<div class="row starters">${STARTERS.map((q) => say(q, q)).join('')}</div>
<form method="post" action="/lead/${id}/assistant" class="mt12">${csrfField(r.ctx)}<textarea name="text" rows="2" dir="auto" required maxlength="2000" class="wide" aria-label="ההודעה לעוזר" placeholder="מה תרצו לדעת על החנות?"></textarea><div class="row mt8"><button class="btn${waiting ? '' : ' primary'} sm" type="submit">${icon('send')}לשלוח</button></div></form>`;
  // Where the owner writes to their assistant on WhatsApp (the owner, 2026-11-09: "the personal assistant should be the
  // number of the business, and the owner messages it personally"): the store's own number once it is connected here
  // (owners/storeLine.ts answers there), and meanwhile our number (the owner line), which keeps working anyway. The
  // numbers the owner writes FROM are linked and verified in accounts (src/owners/identity.ts), never typed here; the
  // business number itself linked as one cannot write to itself, so it is said apart.
  const biz = await bizNumber(app, id);
  const owners = s.workspace_id ? await ownersOf(app, Number(s.workspace_id)) : [];
  const line = lineNumber(app.env);
  const num = (d: string) => `<a href="https://wa.me/${esc(d)}"><bdi dir="ltr" class="ltr">${esc(localPhone(d))}</bdi></a>`;
  const personal = (owners || []).filter((o) => o.phone !== biz);
  const where = biz
    ? `כותבים מהטלפון האישי שלכם למספר של העסק, ${num(biz)}, ותורן עונה לכם כעוזר. ללקוחות הוא ממשיך לענות כרגיל.`
    : `אחרי שתחברו את <a href="/lead/${id}/whatsapp">הוואטסאפ של העסק</a>, כותבים מהטלפון האישי שלכם למספר של העסק, ותורן עונה לכם כעוזר.${line ? ` עד אז כותבים לו למספר שלנו, ${num(line)}.` : ''}`;
  const linked = !s.workspace_id
    ? 'החנות הזאת עוד לא שייכת לחשבון של לקוח, אז אין לה מספרים מחוברים.'
    : owners === null
      ? 'את המספרים המחוברים לא הצלחנו לבדוק כרגע.'
      : personal.length
        ? `זה עובד ממספר שחיברתם בחשבון ב־OpenFrequency. מחוברים עכשיו: ${personal.map((o) => `<bdi dir="ltr" class="ltr">${esc(localPhone(o.phone))}</bdi>`).join(', ')}.`
        : owners.length
          ? 'בחשבון מחובר רק המספר של העסק עצמו, וממנו אי אפשר לכתוב לעצמו. צריך לחבר גם את הטלפון האישי.'
          : 'זה עובד ממספר שחיברתם בחשבון ב־OpenFrequency, ועוד לא חיברתם מספר.';
  const home = esc(accountsLinks(app.env).home);
  const act = r.ctx.readOnly || !s.workspace_id
    ? ''
    : personal.length
      ? `<div class="mt8"><p class="small m0"><a href="${home}">לנהל את המספרים בחשבון</a></p></div>`
      : `<div class="mt12"><a class="btn sm" href="${home}">לחבר מספר בחשבון</a></div>`;
  const wa = `<section class="panel mt16"><header><h2>לכתוב לעוזר מהוואטסאפ</h2></header>
<p class="small muted m0">${where}</p>
<div class="mt8"><p class="small muted m0">${linked}</p></div>
${act}
</section>`;
  // The section's own name on top, as Teder's sections and Today open, and the store in the line under it (the audit of
  // 2026-11-12, P2-3).
  const body = `<div class="head"><h1>העוזר</h1><p class="sub">תורן עונה לכם על ${esc(name)} מתוך השיחות, השאלות שמחכות לכם והמוצרים באתר. את ההזמנות והעגלות של החנות הוא עוד לא רואה.</p></div>
<section class="panel assistant"><div class="chat">${chat}</div>${waiting}<span id="end"></span>${form}</section>
${wa}`;
  return layout({ ...r.ctx, title: `העוזר של ${name}`, active: 'assistant' }, body);
}

export function assistantRoutes(app: App): Route<DashReq>[] {
  return [
    // The menu's way in: the one store a customer has goes straight to its assistant; more than one, a list. A store
    // owner's store is theirs whatever its place in our funnel: a store added from /start stays 'page_ready' (the audit of
    // 2026-11-12, P0-2: every self-serve store read "העוזר נפתח לחנות שתורן כבר עונה בה"). The operator's own list
    // keeps to the stores that are past the demo.
    ['GET', /^\/assistant$/, async (r) => {
      const stores = await app.db.query<any>(`SELECT id, name, domain, brand, brand_override FROM stores WHERE ${storesOf(r.scope)}${r.ctx.operator ? " AND status IN ('pilot', 'paid', 'demo_started')" : r.scope.operator ? ' AND workspace_id IS NOT NULL' : ''} ORDER BY updated_at DESC LIMIT 50`);
      if (stores.length === 1) return { redirect: `/lead/${stores[0].id}/assistant` };
      const start = !r.scope.operator && !r.ctx.readOnly && Number(r.scope.workspaceId) > 0;
      const list = stores.length
        ? `<div class="list">${stores.map((s) => `<a href="/lead/${s.id}/assistant">${storeBadge({ id: s.id, name: displayName(s.brand_override?.name, s.brand?.name, s.name), domain: s.domain })}<span class="t"><b>${esc(displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain)}</b><small class="ltr">${esc(s.domain)}</small></span></a>`).join('')}</div>`
        : r.ctx.operator
          ? '<p class="muted">העוזר נפתח לחנות שתורן כבר עונה בה. אפשר לפתוח אותו גם מהעמוד של כל חנות, תחת "העוזר".</p>'
          : `<div class="empty">${icon('spark')}<b>העוזר נפתח אחרי שמוסיפים את החנות</b>שואלים אותו מה קרה היום, אילו שאלות מחכות לכם ומה אזל מהמלאי, והוא עונה מתוך השיחות והאתר.${start ? `<p class="row mt12 m0"><a class="btn" href="/start">${icon('plus')}להוסיף את החנות</a></p>` : ''}</div>`;
      return { html: layout({ ...r.ctx, title: 'העוזר', active: 'assistant' }, `<div class="head"><h1>העוזר</h1></div>${list}`) };
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
