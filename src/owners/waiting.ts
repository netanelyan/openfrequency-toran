import type { App } from '../app.ts';
import { HOUR, israelWeekdayHour, now } from '../core/clock.ts';
import { cleanLine } from '../core/hebrew.ts';
import { event } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { enqueue } from '../jobs/queue.ts';
import { alertOperator } from '../ops/alert.ts';
import { WAITING_SQL } from '../web/inbox.ts';
import { ownersOf } from './identity.ts';
import { notifyOwners } from './notify-client.ts';
import { notify } from './push.ts';

// When a customer waits for the store's owner, the owner is told (TORAN-READINESS.md P0-2; the site and the pitch page
// promise "שאלה שהוא לא יודע לענות עליה מגיעה אליכם"). A handoff, or a new message in a conversation the owner took
// over, asks for a digest a few minutes later (one job a store, so a burst is one email): an email to the workspace's
// owners with each waiting conversation and its link, not between 22:00 and 07:00 (it waits for the morning), each
// conversation once in 12 hours, and at most DIGESTS_PER_DAY a store a day; the inbox still shows everything. In the
// store's first 14 days the operator is told too, since Today promises we read the conversations with them.
// Only the store's own channels count: a conversation on our demo number is the owner trying Toran.

export const DIGEST_DELAY_MS = 3 * 60_000;
export const DIGESTS_PER_DAY = 6;
export const TOLD_AGAIN_HOURS = 12;
export const FIRST_DAYS = 14;

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

/** One push for a conversation that starts waiting: what it is, and the way to it. */
async function pushWaiting(app: App, storeId: number, conversationId: number | null) {
  const subs = await app.db.one('SELECT 1 FROM push_subs WHERE failed < 5 AND (workspace_id IS NULL OR workspace_id = (SELECT workspace_id FROM stores WHERE id = $1)) LIMIT 1', [storeId]);
  if (!subs) return;
  const s = await app.db.one<{ name: string; brand: any; brand_override: any; domain: string }>('SELECT name, brand, brand_override, domain FROM stores WHERE id = $1', [storeId]);
  const q = conversationId ? await app.db.one<{ text: string }>("SELECT text FROM messages WHERE conversation_id = $1 AND role = 'customer' AND text <> '' ORDER BY id DESC LIMIT 1", [conversationId]) : null;
  const name = displayName(s?.brand_override?.name, s?.brand?.name, s?.name) || s?.domain || 'החנות';
  await notify(app, { storeId, kind: 'waiting', title: `לקוח של ${name} מחכה לתשובה שלכם`, body: q?.text ? cleanLine(q.text, 140) : 'תורן העביר אליכם שאלה.', url: conversationId ? `/chat/${conversationId}` : '/chats?state=waiting' });
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

type Waiting = { id: number; peer: string | null; channel: string; summary: string | null; last_q: string | null };

/** The digest: the store's waiting conversations nobody was told about lately, to its owners' email. */
export async function waitingDigest(app: App, storeId: number): Promise<{ sent: number; conversations: number; why?: string }> {
  const { db } = app;
  const store = await db.one<any>('SELECT id, name, domain, brand, brand_override, workspace_id, agent_live_at FROM stores WHERE id = $1', [storeId]);
  if (!store) return { sent: 0, conversations: 0, why: 'no store' };
  const list = await db.query<Waiting>(
    `SELECT c.id, c.peer, c.channel,
       (SELECT handoff->>'summary' FROM messages WHERE conversation_id = c.id AND handoff IS NOT NULL ORDER BY id DESC LIMIT 1) AS summary,
       (SELECT text FROM messages WHERE conversation_id = c.id AND role = 'customer' AND text <> '' ORDER BY id DESC LIMIT 1) AS last_q
     FROM conversations c WHERE c.store_id = $1 AND c.account_id IS NOT NULL AND ${WAITING_SQL}
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.store_id = c.store_id AND e.kind = 'owner_told' AND (e.data->>'conversationId')::int = c.id AND e.at > now() - interval '${TOLD_AGAIN_HOURS} hours')
     ORDER BY c.last_at DESC LIMIT 20`,
    [storeId],
  );
  if (!list.length) return { sent: 0, conversations: 0, why: 'nothing new waits' };
  const name = displayName(store.brand_override?.name, store.brand?.name, store.name) || store.domain;
  await firstDaysAlert(app, store, list.length, name);
  const base = String(app.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const told = async (sent: number) => {
    for (const c of list) await event(db, storeId, 'owner_told', { conversationId: c.id });
    await event(db, storeId, 'owner_digest', { conversations: list.map((c) => c.id), emails: sent });
  };
  // Through accounts first (owners/notify-client.ts): it knows the workspace's people and what each chose, and holds
  // the day's limit. Its own no (the limit, Toran off for the workspace) stands; only when it could not decide (not
  // configured, unreachable, a workspace it does not know) does Toran's own mail send it.
  if (store.workspace_id) {
    const m = waitingMail(name, list, base);
    const r = await notifyOwners(app, Number(store.workspace_id), 'conversation_waiting', m.subject, m.text, list.length === 1 ? `${base}/chat/${list[0].id}` : `${base}/chats?state=waiting`);
    if (r.ok) {
      await told(r.sent);
      return { sent: r.sent, conversations: list.length };
    }
    if (r.status === 429 || r.status === 409) return { sent: 0, conversations: list.length, why: `accounts: ${r.why}` };
  }
  if (!app.mail) return { sent: 0, conversations: list.length, why: 'email is off here' };
  const today = await db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM events WHERE store_id = $1 AND kind = 'owner_digest' AND at > now() - interval '1 day'", [storeId]);
  if ((today?.n || 0) >= DIGESTS_PER_DAY) return { sent: 0, conversations: list.length, why: 'enough emails today' };
  const to = new Set<string>();
  if (store.workspace_id) for (const o of (await ownersOf(app, Number(store.workspace_id))) || []) if (o.user.email) to.add(o.user.email.toLowerCase());
  const addresses = [...to].filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  if (!addresses.length) return { sent: 0, conversations: list.length, why: 'no owner email' };
  const m = waitingMail(name, list, base);
  let sent = 0;
  for (const address of addresses) {
    try {
      await app.mail.notice(address, m.subject, m.text);
      sent++;
    } catch (e: any) {
      app.log(`[waiting] the email to the owner of store ${storeId} failed: ${e?.message || e}`);
    }
  }
  if (sent) await told(sent);
  return { sent, conversations: list.length };
}

const HEBREW = /[֐-׿]/;

/** The email: what each customer asked (or what Toran handed over, when it is in Hebrew), and the link to answer. */
export function waitingMail(storeName: string, list: Waiting[], base: string): { subject: string; text: string } {
  const one = list.length === 1;
  const subject = one ? `לקוח מחכה לתשובה שלכם ב${storeName}` : `${list.length} לקוחות מחכים לתשובה שלכם ב${storeName}`;
  const lines = list.map((c) => {
    const what = cleanLine(c.summary && HEBREW.test(c.summary) ? c.summary : c.last_q || 'הודעה בלי טקסט', 160);
    return `• ${what}\n  ${base}/chat/${c.id}`;
  });
  const text = [
    one ? `לקוח כתב ל${storeName}, ותורן העביר את השאלה אליכם כי לא מצא לה תשובה בטוחה באתר.` : `${list.length} לקוחות כתבו ל${storeName}, ותורן העביר את השאלות אליכם.`,
    '',
    ...lines,
    '',
    'עונים מהקישור, או מהאפליקציה בטלפון. אחרי שעונים, תורן לא נכנס לשיחה הזו עד שתחזירו אותה אליו.',
    'אם מסמנים "לשמור את התשובה", תורן יענה ככה בפעם הבאה ששואלים את זה.',
  ].join('\n');
  return { subject, text };
}

/** In the store's first two weeks (from its first channel, or from going live), the operator hears of it too. */
async function firstDaysAlert(app: App, store: any, n: number, name: string) {
  const first = await app.db.one<{ at: string | null }>('SELECT LEAST(MIN(a.connected_at), $2::timestamptz) AS at FROM channel_accounts a WHERE a.store_id = $1', [store.id, store.agent_live_at || null]);
  const since = first?.at ? new Date(first.at).getTime() : null;
  if (!since || now() - since > FIRST_DAYS * 24 * HOUR) return;
  await alertOperator(app, `waiting:${store.id}`, `תורן: ${n === 1 ? 'לקוח מחכה' : `${n} לקוחות מחכים`} ב${name}`, 'בשבועיים הראשונים שלה. כדאי להציץ בשיחה ולוודא שהבעלים ראו.', { storeId: store.id, everyMinutes: 60 }).catch((e) => app.log(`[waiting] the operator alert failed: ${e?.message || e}`));
}
