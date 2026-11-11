import type { App } from '../app.ts';
import { HOUR, israelWeekdayHour, now } from '../core/clock.ts';
import { cleanLine, prefixed } from '../core/hebrew.ts';
import { event } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { enqueue } from '../jobs/queue.ts';
import { alertOperator } from '../ops/alert.ts';
import { WAITING_SQL } from '../web/inbox.ts';
import { liveState } from '../golive.ts';
import { isCompany } from '../company.ts';
import { entitlementOf } from '../billing/entitlement.ts';
import { ownersOf } from './identity.ts';
import { notifyOwners } from './notify-client.ts';
import { notify } from './push.ts';
import { waitingToOwners } from './notify.ts';

// When a customer waits for the store's owner, the owner is told (TORAN-READINESS.md P0-2; the site and the pitch page
// promise "שאלה שהוא לא יודע לענות עליה מגיעה אליכם"). A handoff, or a new message in a conversation the owner took
// over, asks for a digest a few minutes later (one job a store, so a burst is one email): an email to the workspace's
// owners with each waiting conversation and its link, not between 22:00 and 07:00 (it waits for the morning), and a
// WhatsApp message to the owners' own numbers that agreed to hear from Toran there (owners/notify.ts). A conversation is
// told again when it starts waiting again: a new handoff in it since it was last told (the owner answered, or marked it
// handled, and the customer wrote again, channels/store.ts heldForOwner; the audit of 2026-11-12, P0-3: a follow-up
// after the owner answered was told to nobody for twelve hours). The inbox still shows everything.
//
// An email accounts could not send is tried again (the audit's P1-6, "no retry"): refused for its limit (three of a
// kind a day, accounts' src/accounts/notify.js), when its 24 hours open again; nobody could send it (accounts not
// answering and no mail of ours), every RETRY_MINUTES. Each try carries every conversation still waiting, so a customer
// the limit held back is in the next email. In the store's first 14 days the operator is told too, since Today promises
// we read the conversations with them; on our own support store (src/company.ts, no workspace and no owner but us), the
// operator is told every time. Only the store's own channels count: a conversation on our demo number is the owner
// trying Toran.

export const DIGEST_DELAY_MS = 3 * 60_000;
export const DIGESTS_PER_DAY = 6;
/** A conversation told before its handoffs were counted (an owner_told event with no `upto`) is told again after this long. */
export const TOLD_AGAIN_HOURS = 12;
export const FIRST_DAYS = 14;
/** A digest nobody could send is tried again this long after. */
export const RETRY_MINUTES = 15;
/** One push a conversation in this long: a customer writing five lines is one notification. */
export const PUSH_AGAIN_MINUTES = 10;

/** A conversation waits: ask for the store's digest (deduped, so a burst is one email). */
export async function notifyWaiting(app: App, storeId: number, conversationId?: number | null): Promise<void> {
  const conv = conversationId ? await app.db.one<{ account_id: number | null }>('SELECT account_id FROM conversations WHERE id = $1', [conversationId]) : null;
  if (conversationId && !conv?.account_id) return; // the demo number: the owner trying it, or a lead
  const at = nightEnd(now() + DIGEST_DELAY_MS);
  await enqueue(app.db, 'owner_waiting', { storeId }, { dedupeKey: `owner_waiting:${storeId}`, runAt: new Date(at) });
  // The browsers that asked for notifications are woken now, the email waits for its digest (owners/push.ts, P1-11).
  // Never a reason for the message itself to fail.
  await pushWaiting(app, storeId, conversationId ?? null).catch((e) => app.log?.(`[push] store ${storeId}: ${e?.message || e}`));
}

/** One push for a conversation that starts waiting: what it is, and the way to it; once in PUSH_AGAIN_MINUTES a conversation. */
async function pushWaiting(app: App, storeId: number, conversationId: number | null) {
  const subs = await app.db.one('SELECT 1 FROM push_subs WHERE failed < 5 AND (workspace_id IS NULL OR workspace_id = (SELECT workspace_id FROM stores WHERE id = $1)) LIMIT 1', [storeId]);
  if (!subs) return;
  const url = conversationId ? `/chat/${conversationId}` : '/chats?state=waiting';
  if (await app.db.one(`SELECT 1 FROM notifications WHERE store_id = $1 AND kind = 'waiting' AND url = $2 AND created_at > now() - interval '${PUSH_AGAIN_MINUTES} minutes'`, [storeId, url])) return;
  const s = await app.db.one<{ name: string; brand: any; brand_override: any; domain: string }>('SELECT name, brand, brand_override, domain FROM stores WHERE id = $1', [storeId]);
  const q = conversationId ? await app.db.one<{ text: string }>("SELECT text FROM messages WHERE conversation_id = $1 AND role = 'customer' AND text <> '' ORDER BY id DESC LIMIT 1", [conversationId]) : null;
  const name = displayName(s?.brand_override?.name, s?.brand?.name, s?.name) || s?.domain || 'החנות';
  await notify(app, { storeId, kind: 'waiting', title: `לקוח של ${name} מחכה לתשובה שלכם`, body: q?.text ? cleanLine(q.text, 140) : 'תורן העביר אליכם שאלה.', url });
}

/** 22:00 to 07:00 Israel time waits for 07:00. */
export function nightEnd(t: number): number {
  let x = t;
  for (let i = 0; i < 12; i++) {
    const { hour } = israelWeekdayHour(x);
    if (hour >= 7 && hour < 22) return x;
    x = Math.floor(x / HOUR) * HOUR + HOUR;
  }
  return x;
}

type Waiting = { id: number; peer: string | null; channel: string; summary: string | null; last_q: string | null; upto?: number | null };

/** Why the store's customers wait, beyond Toran handing a question over: the store's own state, said in the email. */
export type WaitWhy = 'never' | 'paused' | 'unpaid' | null;

/** The digest: the store's waiting conversations nobody was told about since they started waiting, to its owners. */
export async function waitingDigest(app: App, storeId: number): Promise<{ sent: number; conversations: number; why?: string }> {
  const { db } = app;
  const store = await db.one<any>('SELECT id, name, domain, brand, brand_override, workspace_id, platform, agent_live_at, agent_paused_at FROM stores WHERE id = $1', [storeId]);
  if (!store) return { sent: 0, conversations: 0, why: 'no store' };
  const list = await db.query<Waiting>(
    `SELECT c.id, c.peer, c.channel,
       (SELECT handoff->>'summary' FROM messages WHERE conversation_id = c.id AND handoff IS NOT NULL ORDER BY id DESC LIMIT 1) AS summary,
       (SELECT text FROM messages WHERE conversation_id = c.id AND role = 'customer' AND text <> '' ORDER BY id DESC LIMIT 1) AS last_q,
       (SELECT MAX(id) FROM messages WHERE conversation_id = c.id AND handoff IS NOT NULL) AS upto
     FROM conversations c WHERE c.store_id = $1 AND c.account_id IS NOT NULL AND ${WAITING_SQL}
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.store_id = c.store_id AND e.kind = 'owner_told' AND (e.data->>'conversationId')::int = c.id
         AND (CASE WHEN e.data ? 'upto' THEN (e.data->>'upto')::bigint >= COALESCE((SELECT MAX(id) FROM messages WHERE conversation_id = c.id AND handoff IS NOT NULL), 0)
              ELSE e.at > now() - interval '${TOLD_AGAIN_HOURS} hours' END))
     ORDER BY c.last_at DESC LIMIT 20`,
    [storeId],
  );
  if (!list.length) return { sent: 0, conversations: 0, why: 'nothing new waits' };
  const name = displayName(store.brand_override?.name, store.brand?.name, store.name) || store.domain;
  const base = String(app.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const told = async (sent: number, via: string) => {
    for (const c of list) await event(db, storeId, 'owner_told', { conversationId: c.id, upto: c.upto ?? 0 });
    await event(db, storeId, 'owner_digest', { conversations: list.map((c) => c.id), emails: sent, via });
  };
  // Our own support store: no workspace, no owner but us (P1-22: its first 14 days were the only time anyone heard).
  if (isCompany(store)) {
    for (const c of list) await alertOperator(app, `support:${c.id}:${c.upto ?? 0}`, 'שאלה בתמיכה מחכה לתשובה שלנו', `"${cleanLine(c.last_q || 'הודעה בלי טקסט', 300)}". עונים מהשיחות, עד 24 שעות מההודעה שלו. ${base}/chat/${c.id}`, { storeId, everyMinutes: 24 * 60 }).catch((e) => app.log(`[waiting] the operator alert failed: ${e?.message || e}`));
    await told(0, 'operator');
    return { sent: 0, conversations: list.length, why: 'our support store: the operator was told' };
  }
  await firstDaysAlert(app, store, list.length, name);
  // Unpaid only when accounts said so: a question that found nobody is not a reason to tell the owner they did not pay.
  const ent = store.workspace_id ? await entitlementOf(app).check(Number(store.workspace_id)) : null;
  const state = liveState(store);
  const why: WaitWhy = ent?.known && !ent.allowed ? 'unpaid' : state === 'live' ? null : state;
  // The owners' own WhatsApp numbers, beside the email and whatever accounts says of it (owners/notify.ts).
  if (store.workspace_id) await waitingToOwners(app, Number(store.workspace_id), { storeId, storeName: name, list, base }).catch((e) => app.log(`[waiting] WhatsApp to the owners of store ${storeId}: ${e?.message || e}`));
  const m = waitingMail(name, list, base, why);
  // Through accounts first (owners/notify-client.ts): it knows the workspace's people and what each chose, and holds
  // the day's limit. Its own no stands: Toran's own mail does not go around the limit or the people's choices. Only when
  // it could not decide (not configured, unreachable, a workspace it does not know) does Toran's own mail send it.
  if (store.workspace_id) {
    const r = await notifyOwners(app, Number(store.workspace_id), 'conversation_waiting', m.subject, m.text, list.length === 1 ? `${base}/chat/${list[0].id}` : `${base}/chats?state=waiting`);
    if (r.ok) {
      await told(r.sent, 'accounts');
      return { sent: r.sent, conversations: list.length };
    }
    if (r.status === 429) {
      await again(app, storeId, await limitOpens(app, Number(store.workspace_id)));
      return { sent: 0, conversations: list.length, why: `accounts: ${r.why}` };
    }
    if (r.status === 409) return { sent: 0, conversations: list.length, why: `accounts: ${r.why}` };
  }
  if (!app.mail) {
    if (store.workspace_id) await again(app, storeId, now() + RETRY_MINUTES * 60_000);
    return { sent: 0, conversations: list.length, why: 'email is off here' };
  }
  const today = await db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM events WHERE store_id = $1 AND kind = 'owner_digest' AND at > now() - interval '1 day'", [storeId]);
  if ((today?.n || 0) >= DIGESTS_PER_DAY) return { sent: 0, conversations: list.length, why: 'enough emails today' };
  const to = new Set<string>();
  if (store.workspace_id) for (const o of (await ownersOf(app, Number(store.workspace_id))) || []) if (o.user.email) to.add(o.user.email.toLowerCase());
  const addresses = [...to].filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  if (!addresses.length) return { sent: 0, conversations: list.length, why: 'no owner email' };
  let sent = 0;
  for (const address of addresses) {
    try {
      await app.mail.notice(address, m.subject, m.text);
      sent++;
    } catch (e: any) {
      app.log(`[waiting] the email to the owner of store ${storeId} failed: ${e?.message || e}`);
    }
  }
  if (sent) await told(sent, 'mail');
  else await again(app, storeId, now() + RETRY_MINUTES * 60_000);
  return { sent, conversations: list.length };
}

/** The digest once more at `at` (not at night), under a key of its own: the store's next handoff still asks for its own. */
async function again(app: App, storeId: number, at: number) {
  const when = nightEnd(Math.max(at, now() + 60_000));
  await enqueue(app.db, 'owner_waiting', { storeId }, { dedupeKey: `owner_waiting_retry:${storeId}:${Math.floor(when / 60_000)}`, runAt: new Date(when) });
}

/**
 * When accounts' limit lets the next email of this kind out: 24 hours after the third newest it took for the workspace
 * (its notify_log counts the last 24 hours), as Toran's own events know them; in an hour when they do not say.
 */
async function limitOpens(app: App, workspaceId: number): Promise<number> {
  const third = await app.db.one<{ at: string }>("SELECT at FROM events WHERE kind = 'owner_digest' AND COALESCE(data->>'via', 'accounts') = 'accounts' AND store_id IN (SELECT id FROM stores WHERE workspace_id = $1) ORDER BY at DESC OFFSET 2 LIMIT 1", [workspaceId]);
  const opens = third ? new Date(third.at).getTime() + 24 * HOUR + 60_000 : 0;
  return opens > now() && opens < now() + 24 * HOUR + 60_000 ? opens : now() + HOUR;
}

const HEBREW = /[֐-׿]/;

/**
 * The email: who waits and why, what each customer asked (or what Toran handed over, when it is in Hebrew), and the
 * link to answer. `why`: the store is not switched on, is paused, or its payment is not recorded, so every message
 * waits; null for a question Toran handed over (the audit of 2026-11-12, P1-7: "Toran handed it over because it found
 * no safe answer on the site" was said whatever the reason, and the pause was "until you give it back").
 */
export function waitingMail(storeName: string, list: Waiting[], base: string, why: WaitWhy = null): { subject: string; text: string } {
  const one = list.length === 1;
  const subject = one ? `לקוח של ${storeName} מחכה לתשובה שלכם` : `${list.length} לקוחות של ${storeName} מחכים לתשובה שלכם`;
  const lines = list.map((c) => {
    const what = cleanLine(c.summary && HEBREW.test(c.summary) ? c.summary : c.last_q || 'הודעה בלי טקסט', 160);
    return `• ${what}\n  ${base}/chat/${c.id}`;
  });
  const wrote = `${one ? 'לקוח כתב' : `${list.length} לקוחות כתבו`} ${prefixed('ל', storeName)}.`;
  const waits = one ? 'ההודעה מחכה' : 'ההודעות מחכות';
  const opening = why === 'never' ? `${wrote} תורן עוד לא הופעל בחנות, אז ${waits} לכם. מפעילים אותו בדף היום, ומשם הוא עונה לבד.`
    : why === 'paused' ? `${wrote} תורן מושהה בחנות, אז ${waits} לכם.`
    : why === 'unpaid' ? `${wrote} תורן לא ענה ${one ? 'לו' : 'להם'}, כי התשלום על תורן עוד לא רשום אצלנו.`
    : one ? `לקוח של ${storeName} מחכה לתשובה שלכם. הנה במה מדובר, עם הקישור לשיחה:` : `${list.length} לקוחות של ${storeName} מחכים לתשובה שלכם. הנה במה מדובר, עם הקישור לכל שיחה:`;
  // While Toran answers, an answer from here stops it in that conversation for 12 hours (channels/owner.ts PAUSE_HOURS).
  const after = why ? ['עונים מהקישור.'] : ['עונים מהקישור. אחרי שעונים, תורן לא עונה בשיחה הזו 12 שעות, אלא אם מחזירים אותה אליו קודם.', 'אם מסמנים "לשמור את התשובה", תורן יענה ככה בפעם הבאה ששואלים את זה.'];
  return { subject, text: [opening, '', ...lines, '', ...after].join('\n') };
}

/** In the store's first two weeks (from its first channel, or from going live), the operator hears of it too. */
async function firstDaysAlert(app: App, store: any, n: number, name: string) {
  const first = await app.db.one<{ at: string | null }>('SELECT LEAST(MIN(a.connected_at), $2::timestamptz) AS at FROM channel_accounts a WHERE a.store_id = $1', [store.id, store.agent_live_at || null]);
  const since = first?.at ? new Date(first.at).getTime() : null;
  if (!since || now() - since > FIRST_DAYS * 24 * HOUR) return;
  await alertOperator(app, `waiting:${store.id}`, `תורן: ${n === 1 ? 'לקוח מחכה' : `${n} לקוחות מחכים`} ${prefixed('ב', name)}`, 'בשבועיים הראשונים שלה. כדאי להציץ בשיחה ולוודא שהבעלים ראו.', { storeId: store.id, everyMinutes: 60 }).catch((e) => app.log(`[waiting] the operator alert failed: ${e?.message || e}`));
}
