import type { App } from '../app.ts';
import { DAY, notOnShabbat, now } from '../core/clock.ts';
import { cleanLine } from '../core/hebrew.ts';
import { J } from '../db/index.ts';
import { event } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { pitchUrl } from '../outreach.ts';
import { publicBase } from '../auto/messages.ts';
import { WAITING_SQL } from '../web/inbox.ts';
import type { LeadOf } from '../agent/intro.ts';
import { alertOperator } from './alert.ts';
import { tederMove, tederState } from './tederLeads.ts';
import { LAUNCH_PAGE, pitchShown, pitchVars, REPLY_DAYS, stoppedNumber, templateNamed, type Product, type Stage } from './outreach.ts';

// A store we wrote to first answers us (the owner, 2026-11-12: "How does our toran answer after a lead answers? Make
// sure the behavior is defined. Make sure it sells itself").
//
// A pitch goes from our number as a Marketing template (ops/outreach.ts) and is kept in our support's conversation with
// that number (keepPitch). What they write back reaches our support (channels/demo.ts: a phone with no demo), and:
//
//   pitchFor     finds the pitch they are answering: the latest one sent to the number in the last REPLY_DAYS, unless
//                the number asked us to stop; with the store's name and the pages it was sent (kept on the event since
//                2026-11-12, and before that found again through its ref: the store's pitch page, Teder's demo in our
//                mirror of them), and whether they wrote to their store's Toran on the demo
//   leadTurn     what the turn is told (agent/loop.ts): the LEAD block in its SERVER CONTEXT, with our message to them
//                and the links to what we built, which back the reply's links and claims for the guard as a tool's
//                result does; and its first line, the Toran we built for them (agent/intro.ts leadLine). How to answer
//                them is the static "# A store we wrote to" in COMPANY_PROMPT, so the cached prompt stays one for all
//   leadReplied  once a pitch, after our reply went: the lead marked answered where it is worked (its store by the
//                pitch's ref, our mirror of Teder's demos, Teder's own lead when it is still where a pitch leaves it),
//                so /admin/leads lists it as talking and no reminder goes (outreach.ts wroteSinceFirst); and the
//                operator told, by the store's name, with the conversation's link, inside the 24 hours their message
//                opened
//
// "הסירו אותי" and a "לא" to the pitch never get here: outreachWord reads them first, on our number. Only the 24 hours
// their own message opens are used: nothing here sends a template, or writes to anyone who did not just write.

/** A pitch a store is answering, as pitchFor finds it. */
export type LeadPitch = {
  eventId: number;
  phone: string;
  product: Product;
  stage: Stage;
  /** When the pitch went. */
  at: string;
  /** The store's name, as our message said it. */
  name: string;
  domain: string | null;
  /** Our row of the lead (stores): by the pitch's ref, else the store whose WhatsApp the number is. */
  storeId: number | null;
  /** Teder's demo the pitch was for, in our mirror of them (teder_leads). */
  tederId: string | null;
  /** The store's own Toran, its pitch page; null when the pitch had none or the page was taken down. */
  toranUrl: string | null;
  /** Teder's sample slideshow. */
  tederUrl: string | null;
  /** The pitch as they got it: its words, and its buttons as they read them (outreach.ts pitchShown). */
  text: string | null;
  /** They wrote to their store's Toran on the demo. */
  tried: boolean;
  /** Their first answer to it was marked already (leadReplied). */
  replied: boolean;
};

const PRODUCTS = new Set<string>(['toran', 'teder', 'both']);
const STAGES = new Set<string>(['first', 'reminder', 'launch']);
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const link = (v: unknown) => (typeof v === 'string' && /^https?:\/\/\S+$/.test(v) ? v : null);

/** The pitch this number is answering, or null when there is none, or it asked us to stop. */
export async function pitchFor(app: App, from: string): Promise<LeadPitch | null> {
  const phone = digits(from);
  if (!phone) return null;
  // A pitch has no store of its own (store_id null), so the events_store index finds the few there are.
  const e = await app.db.one<{ id: number; at: Date | string; data: any }>(
    `SELECT id, at, data FROM events WHERE store_id IS NULL AND kind = 'outreach_wa' AND data->>'phone' = $1 AND data->>'state' = 'sent' AND at > now() - interval '${REPLY_DAYS} days' ORDER BY id DESC LIMIT 1`,
    [phone],
  );
  if (!e || (await stoppedNumber(app, phone))) return null;
  const d = e.data || {};
  const product = (PRODUCTS.has(d.product) ? d.product : 'toran') as Product;
  const stage = (STAGES.has(d.stage) ? d.stage : 'first') as Stage;
  // The ref says whose pitch it was: our store (toran:<id> from the old dashboard, store:<id> from /admin/leads), or one
  // of Teder's demos asked for on the website (teder:<id>). A ref of Teder's own /leads (lead:<id>) is found by the number.
  const ref = /^(toran|store|teder):(.+)$/.exec(String(d.ref || ''));
  const byId = ref && ref[1] !== 'teder' ? Number(ref[2]) || 0 : 0;
  const s = await app.db.one<any>(
    `SELECT id, name, brand, brand_override, domain, slug, page_built_at, taken_down_at FROM stores WHERE ${byId ? 'id = $1' : "contact_whatsapp = $1 AND platform IS DISTINCT FROM 'company'"} ORDER BY updated_at DESC LIMIT 1`,
    [byId || phone],
  );
  const teder = product === 'toran'
    ? null
    : await app.db.one<{ id: string; name: string | null; domain: string; page_url: string | null }>(
        ref?.[1] === 'teder' ? 'SELECT id, name, domain, page_url FROM teder_leads WHERE id = $1' : 'SELECT id, name, domain, page_url FROM teder_leads WHERE whatsapp = $1 ORDER BY synced_at DESC LIMIT 1',
        [ref?.[1] === 'teder' ? ref[2] : phone],
      );
  const ownPage = s?.page_built_at && s.slug && !s.taken_down_at ? pitchUrl(app.env, s.slug) : null;
  const toranUrl = stage === 'launch' || product === 'teder' || s?.taken_down_at ? null : link(d.url) || ownPage;
  const tederUrl = product === 'toran' ? null : link(product === 'teder' ? d.url : d.url2) || link(teder?.page_url);
  const name = cleanLine(d.name, 80) || (s ? displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain : '') || teder?.name || teder?.domain || 'החנות';
  const t = templateNamed(String(d.template || ''));
  const page = stage === 'launch' ? LAUNCH_PAGE : product === 'teder' ? tederUrl : toranUrl;
  const text = t ? pitchShown(t, pitchVars(t, name, page || '', product === 'both' ? tederUrl : null)) : null;
  // Their store's Toran on our demo number: a conversation with no account, on the store, from this number.
  const tried = Boolean(s && toranUrl && (await app.db.one("SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id = c.id WHERE c.store_id = $1 AND c.peer = $2 AND c.account_id IS NULL AND m.role = 'customer' LIMIT 1", [s.id, phone])));
  return {
    eventId: Number(e.id),
    phone,
    product,
    stage,
    at: new Date(e.at).toISOString(),
    name,
    domain: s?.domain || teder?.domain || null,
    storeId: s ? Number(s.id) : null,
    tederId: teder?.id ?? null,
    toranUrl,
    tederUrl,
    text,
    tried,
    replied: d.replied != null,
  };
}

/** The product pages on the website, each with its price and its sign-up (the way in once they want it). */
export const START_PAGES = { toran: LAUNCH_PAGE, teder: 'https://openfrequency.co.il/teder' };
const OFFERED: Record<Product, string> = { toran: 'Toran, built on their store', teder: 'a sample Teder slideshow made from their store', both: 'Toran, built on their store, and a sample Teder slideshow made from it' };

/**
 * What a turn of our support is told of a store we wrote to (agent/loop.ts TurnInput): the LEAD block for its SERVER
 * CONTEXT, the same block as facts that back the reply's links and claims, and what its first line says (leadLine).
 * Toran's opening to the waitlist built nothing for them: no line of its own.
 */
export function leadTurn(l: LeadPitch): { context: string; facts: string[]; lead: LeadOf | null } {
  const when = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'long' }).format(new Date(l.at));
  const what = l.stage === 'launch' ? 'they asked on our website to hear when Toran opens, and we told them it is open' : `we offered them ${OFFERED[l.product]}${l.stage === 'reminder' ? ', and wrote once more to remind them' : ''}`;
  const starts = l.product === 'both' ? `${START_PAGES.toran} (Toran), ${START_PAGES.teder} (Teder)` : l.product === 'teder' ? START_PAGES.teder : START_PAGES.toran;
  const context = [
    `LEAD (the app's record, not the person's words): they write from the store "${l.name}"${l.domain ? ` (${l.domain})` : ''}, which we wrote to first, from this number, on ${when}: ${what}. Answer them as "# A store we wrote to" says.`,
    l.text ? `Our message to them, as they got it:\n"""\n${l.text}\n"""` : '',
    l.toranUrl ? `Their store's own Toran, built from their website, which they can write to now as their customers would: ${l.toranUrl} (they ${l.tried ? 'have written to it already' : 'have not written to it yet'}).` : '',
    l.tederUrl ? `The sample slideshow Teder made from their website: ${l.tederUrl}` : '',
    `Where they start, with the price and the sign-up: ${starts}`,
  ].filter(Boolean).join('\n');
  return { context, facts: [context], lead: l.stage === 'launch' ? null : { product: l.product, name: l.name } };
}

/**
 * Their first answer to a pitch, after our reply to it went: once a pitch (the event keeps `replied`, the
 * conversation), the lead is marked answered (replied_at, and the next step due tomorrow, not on Shabbat, as the
 * operator's "ענו" marks it, ops/actions.ts markReplied), and the operator is told. False when it was marked already.
 */
export async function leadReplied(app: App, l: LeadPitch, accountId: number, said: string): Promise<boolean> {
  const c = await app.db.one<{ id: number; waiting: boolean }>(`SELECT c.id, ${WAITING_SQL} AS waiting FROM conversations c WHERE c.account_id = $1 AND c.peer = $2 ORDER BY c.last_at DESC LIMIT 1`, [accountId, l.phone]);
  const fresh = await app.db.one("UPDATE events SET data = data || $2::jsonb WHERE id = $1 AND kind = 'outreach_wa' AND data->>'replied' IS NULL RETURNING id", [l.eventId, J({ replied: c ? Number(c.id) : 0 })]);
  if (!fresh) return false;
  const next = new Date(notOnShabbat(now() + DAY)).toISOString();
  if (l.storeId) await app.db.query('UPDATE stores SET replied_at = COALESCE(replied_at, now()), snoozed_until = NULL, next_step_at = COALESCE(next_step_at, $2), updated_at = now() WHERE id = $1', [l.storeId, next]);
  if (l.product !== 'toran') await app.db.query('UPDATE teder_leads SET replied_at = COALESCE(replied_at, now()), snoozed_until = NULL, next_step_at = COALESCE(next_step_at, $2) WHERE (id = $3 OR whatsapp = $1) AND lost_at IS NULL', [l.phone, next, l.tederId || '']);
  await event(app.db, l.storeId, 'outreach_reply', { conversationId: c ? Number(c.id) : null, product: l.product, stage: l.stage, last4: l.phone.slice(-4) });
  if (l.storeId && l.domain && l.product !== 'toran') await tederReplied(app, { id: l.storeId, domain: l.domain }).catch((e) => app.log(`[lead] Teder's lead of ${l.domain} was not marked answered: ${e?.message || e}`));
  const where = `${publicBase(app.env)}${c ? `/chat/${Number(c.id)}` : '/chats'}`;
  const what = c?.waiting ? 'תורן העביר את זה אלינו, וזה מחכה לתשובה שלנו.' : 'תורן ענה להם.';
  await alertOperator(app, `lead_reply:${l.eventId}`, `${l.name} ענו להודעה שלנו`, `"${cleanLine(said, 300) || 'הודעה בלי טקסט'}". ${what} ממשיכים מהשיחה, עד 24 שעות מההודעה שלהם: ${where}`, { storeId: l.storeId, everyMinutes: 24 * 60 }).catch((e) => app.log(`[lead] the operator alert failed: ${e?.message || e}`));
  return true;
}

/** Teder's own lead moved to "ענו", only from where a pitch leaves it: never back from joined or not relevant. */
async function tederReplied(app: App, s: { id: number; domain: string }) {
  const st = await tederState(app, s);
  if ('error' in st || !st.lead || !['demo_ready', 'sent', 'opened'].includes(st.lead.stage)) return;
  const r = await tederMove(app, s, 'replied', 'תורן');
  if ('error' in r) app.log(`[lead] Teder did not mark ${s.domain} answered: ${r.error}`);
}
