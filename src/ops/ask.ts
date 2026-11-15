import type { App } from '../app.ts';
import type { RouteResult } from '../channels/demo.ts';
import type { ChannelAdapter, Inbound } from '../channels/types.ts';
import { BINDING_DAYS, msg } from '../channels/demo.ts';
import { conversationFor, DEMO_FOOTER } from '../agent/loop.ts';
import { botName, markIntroduced } from '../agent/intro.ts';
import { cloudSend } from '../channels/meta.ts';
import { tokenOf } from '../channels/lines.ts';
import { openConversation } from '../channels/conversations.ts';
import { conversationOf, type Account } from '../channels/store.ts';
import { reply } from '../channels/send.ts';
import { supportAccount } from '../company.ts';
import { now } from '../core/clock.ts';
import { cleanLine } from '../core/hebrew.ts';
import { J } from '../db/index.ts';
import { event, usage } from '../db/log.ts';
import { displayName } from '../ingest/brand.ts';
import { le, pitchUrl } from '../outreach.ts';
import { pitchGaps, isPublic } from '../pitch/ready.ts';
import { alertOperator } from './alert.ts';
import { building, leadDo } from './leadsAdmin.ts';
import { leadReplied, type LeadPitch } from './leadReply.ts';
import { outreachPhoneId, type Product } from './outreach.ts';
import { tederState } from './tederLeads.ts';

// The question, and what its yes brings (the owner, 2026-11-15, on the research that a first message offering the
// product is not the one approach the law allows a business: "ok"; and "i want the lead dashboard to be automatic ...
// sends it itself, sells the products himself"). The first message only asks whether we may send the store an offer
// (ops/outreach.ts OUTREACH_ASK, ops/emailPitch.ts by email). A yes is their consent: the store's demo is built then,
// the product the autopilot chose for it (stores.demo_for), and goes into the same chat once it is up: Toran's demo
// starts answering there as the store's customers would get it, a Teder slideshow comes as its first slide with the
// link. Nothing is built for a store that did not say yes, so nothing is spent on it.
//
//   askAccepted     the yes on WhatsApp (channels/demo.ts): thanks at once, the build starts, the pitch waits
//   askDeliverDue   the schedule's step: a yes whose demos are up is sent them; after ASK_WAIT_MS what is up goes, and
//                   with nothing up the store hears so and the operator is told
//
// A pitch's record (events outreach_wa or outreach_mail, stage 'ask') keeps the state: yes, yes_at, deliver (pending,
// sent, failed, expired), delivered.

/** How long a yes waits for its demos before what is up goes alone. */
export const ASK_WAIT_MS = 3 * 60 * 60_000;
/** WhatsApp's 24 hours from their yes, a little short of it: past it, nothing but a template may go. */
const WINDOW_MS = 23 * 60 * 60_000;

export const ASK_THANKS = 'תודה. אנחנו מכינים את זה עכשיו במיוחד בשבילכם, וזה יגיע לכאן בתוך שעה בערך.';
export const ASK_SORRY = 'סליחה, לא הצלחנו להכין את זה כמו שצריך הפעם. מישהו מהצוות שלנו יחזור אליכם כאן.';
const PRODUCT_HE: Record<Product, string> = { toran: 'את תורן', teder: 'מצגת של תדר', both: 'את תורן ומצגת של תדר' };

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const storeOfRef = (ref: unknown) => Number(/^(?:toran|store):(\d+)$/.exec(String(ref || ''))?.[1]) || null;
const productOf = (p: unknown): Product => (p === 'toran' || p === 'teder' || p === 'both' ? p : 'both');

/** The first slide of a Teder demo on its public page (Teder's demos.js sendSlide), TikTok's then Instagram's, or null. */
export async function firstSlide(app: App, page: string): Promise<string | null> {
  for (const f of ['tiktok-0.jpg', 'instagram-0.jpg']) {
    const url = `${page.replace(/\/+$/, '')}/${f}`;
    try {
      const r = await app.api(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (r.ok && /^image\//.test(r.headers.get('content-type') || '')) return url;
    } catch {
      // Not reached: the next, or none, and the link alone goes.
    }
  }
  return null;
}

/** The words that go with a Teder slideshow. */
export const tederWords = (name: string, page: string, slide: boolean) =>
  `זו המצגת שתדר הכין ${le(name)}${slide ? ', והשקף הראשון שלה כאן' : ''}. כל השקפים: ${page}\n\nתדר מכין לכם מצגות כאלה כמה פעמים בשבוע, וכל אחת עולה רק אחרי שאישרתם אותה. אם יש שאלות, כותבים כאן.`;

/**
 * The phone bound to the store's demo, as its code binds it (channels/demo.ts): their next message is answered by the
 * store's own Toran, for BINDING_DAYS and the demo's turns. The welcome is kept in the store's demo conversation and
 * returned to be sent. Null when the store has no page up.
 */
export async function bindToranDemo(app: App, phone: string, storeId: number): Promise<{ welcome: string; conv: number; name: string } | null> {
  const store = await app.db.one<{ id: number; name: string | null; domain: string; brand: any; brand_override: any; platform: string | null; agent_name: string | null; demo_code: string | null }>(
    "SELECT id, name, domain, brand, brand_override, platform, agent_name, demo_code FROM stores WHERE id = $1 AND page_built_at IS NOT NULL AND status <> 'skipped' AND taken_down_at IS NULL",
    [storeId],
  );
  if (!store) return null;
  await app.db.query(
    `INSERT INTO wa_users (phone, store_id, code, bound_at, expires_at, last_inbound_at, turns) VALUES ($1, $2, $3, now(), now() + ($4 || ' days')::interval, now(), 0)
     ON CONFLICT (phone) DO UPDATE SET store_id = EXCLUDED.store_id, code = EXCLUDED.code, bound_at = now(), expires_at = EXCLUDED.expires_at, last_inbound_at = now(), turns = 0`,
    [phone, store.id, store.demo_code || `PITCH-${store.id}`, String(BINDING_DAYS)],
  );
  await app.db.query("UPDATE stores SET demo_started_at = COALESCE(demo_started_at, now()), status = CASE WHEN status IN ('page_ready', 'sent', 'opened') THEN 'demo_started' ELSE status END, updated_at = now() WHERE id = $1", [store.id]);
  await event(app.db, store.id, 'demo_bound', { owner: false, via: 'pitch_yes' });
  const conv = await conversationFor(app.db, store.id, 'whatsapp', phone);
  const name = displayName(store.brand_override?.name, store.brand?.name, store.name) || store.domain;
  const welcome = `מעכשיו עונה לכם כאן תורן של ${name}, כמו שהוא יענה ללקוחות שלכם.\n\n${msg.welcome(name, botName(store))}\n\n${DEMO_FOOTER}`;
  await app.db.query("INSERT INTO messages (conversation_id, role, text) VALUES ($1, 'agent', $2)", [conv, welcome]);
  await app.db.query('UPDATE conversations SET last_at = now() WHERE id = $1', [conv]);
  await markIntroduced(app.db, conv);
  return { welcome, conv, name };
}

/** The demos a yes asked for, started: the chosen product's, only what is missing (ops/leadsAdmin.ts leadDo). */
export async function startAskBuild(app: App, storeId: number, product: Product, by: string): Promise<string> {
  try {
    const r = await leadDo(app, storeId, `go-${product}` as any, { by });
    return r.message;
  } catch (e: any) {
    app.log(`[ask] store ${storeId}: its ${product} demo did not start (${cleanLine(e?.message || e, 200)})`);
    return `לא התחיל: ${cleanLine(e?.message || e, 160)}`;
  }
}

/**
 * The yes to the question on WhatsApp (channels/demo.ts pitchAccepted, for a pitch at stage 'ask'): thanks in the
 * chat at once, the chosen demo built, and the pitch waiting for it (askDeliverDue). The operator is told, as for any
 * answer. Null when it was answered already (a second yes is a message like any other).
 */
export async function askAccepted(app: App, adapter: ChannelAdapter, inbound: Inbound, lead: LeadPitch, pressed: boolean, support: Account): Promise<RouteResult | null> {
  const at = new Date(now()).toISOString();
  const fresh = await app.db.one<{ data: any }>(
    "UPDATE events SET data = data || $2::jsonb WHERE id = $1 AND kind = 'outreach_wa' AND data->>'yes' IS NULL RETURNING data",
    [lead.eventId, J({ yes: at, yes_at: at, pressed, deliver: 'pending' })],
  );
  if (!fresh) return null;
  const product = productOf(fresh.data?.product);
  const conv = await conversationOf(app, adapter, support, inbound);
  await app.db.query("INSERT INTO messages (conversation_id, role, text, ext_id) VALUES ($1, 'customer', $2, $3) ON CONFLICT (ext_id) DO NOTHING", [conv, inbound.text, inbound.id]);
  await app.db.query("INSERT INTO messages (conversation_id, role, text) VALUES ($1, 'agent', $2)", [conv, ASK_THANKS]);
  await app.db.query('UPDATE conversations SET last_at = now() WHERE id = $1', [conv]);
  await reply(app, adapter, inbound, ASK_THANKS, support.store_id, conv);
  const started = lead.storeId ? await startAskBuild(app, lead.storeId, product, 'autopilot') : 'אין לליד חנות אצלנו';
  app.log(`[ask] …${lead.phone.slice(-4)} said yes (${pressed ? 'pressed' : 'written'}): building ${product} for store ${lead.storeId ?? '-'}`);
  await leadReplied(app, lead, support.id, String(inbound.text || ''), {
    title: `${lead.name} אמרו כן`,
    body: `הם ${pressed ? 'לחצו' : 'כתבו'} "${cleanLine(inbound.text, 40) || 'כן'}" לשאלה אם אפשר לשלוח להם הצעה. בונים להם ${PRODUCT_HE[product]} (${started}), וזה יישלח אליהם לבד כשיהיה מוכן.`,
  }).catch((e) => app.log(`[ask] …${lead.phone.slice(-4)}: the yes was not marked answered (${e?.message || e})`));
  return { action: 'pitch_yes', storeId: support.store_id, reply: ASK_THANKS };
}

type Ready = { toranUrl: string | null; tederUrl: string | null; pending: string[]; failed: string[] };

/** Where a yes's demos are: up (their pages), still being made, or failed. */
export async function readiness(app: App, storeId: number, product: Product, since: string): Promise<Ready> {
  const out: Ready = { toranUrl: null, tederUrl: null, pending: [], failed: [] };
  const s = await app.db.one<any>('SELECT * FROM stores WHERE id = $1', [storeId]);
  if (!s) return { ...out, failed: ['store'] };
  if (product !== 'teder') {
    const run = await building(app, [storeId]);
    if (run.has(storeId)) out.pending.push('toran');
    else if (s.slug && s.page_built_at && isPublic(s, await pitchGaps(app, s))) out.toranUrl = pitchUrl(app.env, s.slug);
    else if (await app.db.one("SELECT 1 FROM jobs WHERE kind IN ('ingest', 'pitch') AND status = 'failed' AND (payload->>'storeId')::int = $1 AND created_at >= $2::timestamptz - interval '1 minute'", [storeId, since])) out.failed.push('toran');
    else out.pending.push('toran');
  }
  if (product !== 'toran') {
    const st = await tederState(app, s);
    const d = 'error' in st ? null : st.lead?.demo;
    if ('error' in st) out.pending.push('teder');
    else if (d?.pageUrl && d.status === 'approved') out.tederUrl = d.pageUrl;
    else if (d && !d.building && (d.status === 'failed' || d.error)) out.failed.push('teder');
    else out.pending.push('teder');
  }
  return out;
}

/** Our support's conversation with this number on our number, where the inbox shows the pitch and its answers. */
async function supportConv(app: App, phone: string): Promise<number | null> {
  const number = digits(app.env.DEMO_WA_NUMBER);
  const support = number ? await supportAccount(app, { kind: 'meta' }, number) : null;
  if (!support) return null;
  return (await openConversation(app.db, { storeId: support.store_id, channel: 'whatsapp', peer: phone, accountId: support.id })).id;
}

/** One message from our number, inside the 24 hours their yes opened: its words, or a photo with them. */
async function waSend(app: App, phone: string, m: { text: string; mediaUrl?: string | null }): Promise<string | null> {
  const phoneId = await outreachPhoneId(app);
  if (!phoneId) return null;
  const token = await tokenOf(app, phoneId);
  const sent = await cloudSend(app.env, app.graph, phoneId, token, phone, m.mediaUrl ? { mediaUrl: m.mediaUrl, text: m.text } : { text: m.text });
  await usage(app.db, { kind: 'bsp', backend: 'meta_line', units: 1, usd: sent.usd, apiUsd: sent.usd, tag: 'wa_out' }).catch(() => {});
  return sent.id || null;
}

/** What a yes on WhatsApp gets once its demos are up: Teder's first slide with the link, then Toran's demo, started. */
async function deliverWa(app: App, phone: string, storeId: number, name: string, r: Ready): Promise<string[]> {
  const went: string[] = [];
  const conv = await supportConv(app, phone);
  const keep = (text: string) => (conv ? app.db.query("INSERT INTO messages (conversation_id, role, text) VALUES ($1, 'agent', $2)", [conv, text]) : null);
  if (r.tederUrl) {
    const slide = await firstSlide(app, r.tederUrl);
    const words = tederWords(name, r.tederUrl, Boolean(slide));
    if (await waSend(app, phone, { text: words, mediaUrl: slide })) {
      await keep(words);
      went.push(slide ? 'השקף הראשון של המצגת והקישור אליה' : 'הקישור למצגת');
    }
  }
  if (r.toranUrl) {
    const intro = `הכנו לכם את תורן, עוזר שעונה ללקוחות שלכם בוואטסאפ לפי המוצרים, המחירים והמלאי שבאתר שלכם, ומעביר אליכם רק את מה שהוא לא יודע. מה שהוא קרא מהאתר שלכם נמצא כאן: ${r.toranUrl}`;
    if (await waSend(app, phone, { text: intro })) {
      await keep(intro);
      const bound = await bindToranDemo(app, phone, storeId);
      if (bound && (await waSend(app, phone, { text: bound.welcome }))) went.push('הדמו של תורן, שעונה להם עכשיו בצ׳אט');
    }
  }
  if (conv) await app.db.query('UPDATE conversations SET last_at = now() WHERE id = $1', [conv]);
  return went;
}

/** Mark a yes's delivery, once. */
const mark = (app: App, id: number, kind: string, data: Record<string, unknown>) => app.db.query('UPDATE events SET data = data || $3::jsonb WHERE id = $1 AND kind = $2', [id, kind, J(data)]);

/**
 * The schedule's step: every yes waiting for its demos. Up: sent into the chat (WhatsApp) or the thread (email). Still
 * being made: asked again on the next pass, for ASK_WAIT_MS; past it, what is up goes, and with nothing up the store is
 * told sorry and the operator is told. A WhatsApp yes past its 24 hours can be sent nothing: the operator is told.
 */
export async function askDeliverDue(app: App, { mailDeliver }: { mailDeliver?: (app: App, eventId: number, r: Ready, name: string) => Promise<boolean> } = {}): Promise<number> {
  const rows = await app.db.query<{ id: number; kind: string; store_id: number | null; data: any }>(
    "SELECT id, kind, store_id, data FROM events WHERE kind IN ('outreach_wa', 'outreach_mail') AND data->>'stage' = 'ask' AND data->>'deliver' = 'pending' ORDER BY id LIMIT 10",
  );
  let n = 0;
  for (const e of rows) {
    const d = e.data || {};
    const storeId = e.kind === 'outreach_mail' ? e.store_id : storeOfRef(d.ref);
    const product = productOf(d.product);
    const yesAt = String(d.yes_at || d.yes || new Date(now()).toISOString());
    const since = now() - new Date(yesAt).getTime();
    const name = cleanLine(d.name, 80) || 'החנות';
    if (!storeId) {
      await mark(app, e.id, e.kind, { deliver: 'failed', why: 'no_store' });
      continue;
    }
    if (e.kind === 'outreach_wa' && since > WINDOW_MS) {
      await mark(app, e.id, e.kind, { deliver: 'expired' });
      await alertOperator(app, `ask_expired:${e.id}`, `${name} אמרו כן, והדמו לא יצא אליהם בזמן`, 'עברו 24 שעות מהכן שלהם, אז מהמספר שלנו אפשר לשלוח להם רק תבנית. כדאי לכתוב להם מהשיחה.', { storeId }).catch(() => {});
      continue;
    }
    const r = await readiness(app, storeId, product, yesAt);
    if (r.pending.length && since < ASK_WAIT_MS) continue;
    if (!r.toranUrl && !r.tederUrl) {
      const phone = digits(d.phone);
      if (e.kind === 'outreach_wa' && phone) await waSend(app, phone, { text: ASK_SORRY }).catch(() => null);
      await mark(app, e.id, e.kind, { deliver: 'failed', why: [...r.failed, ...r.pending].join(',') });
      await alertOperator(app, `ask_failed:${e.id}`, `הדמו של ${name} לא נבנה`, `הם אמרו כן, ו${PRODUCT_HE[product]} לא הצליח להיבנות (${[...r.failed, ...r.pending].join(', ')}). ${e.kind === 'outreach_wa' ? 'אמרנו להם שמישהו יחזור אליהם.' : ''} כדאי לבנות שוב מדף הלידים, או לכתוב להם.`, { storeId }).catch(() => {});
      continue;
    }
    try {
      const went = e.kind === 'outreach_wa' ? await deliverWa(app, digits(d.phone), storeId, name, r) : (await mailDeliver?.(app, e.id, r, name)) ? ['הקישורים במייל'] : [];
      await mark(app, e.id, e.kind, { deliver: went.length ? 'sent' : 'failed', delivered: new Date(now()).toISOString(), went });
      if (went.length) n++;
      app.log(`[ask] store ${storeId}: ${went.length ? `sent (${went.join(', ')})` : 'nothing went'}${r.failed.length ? `; failed: ${r.failed.join(', ')}` : ''}`);
    } catch (err: any) {
      app.log(`[ask] !!! store ${storeId}: the demo was not sent (${cleanLine(err?.message || err, 200)})`);
      await mark(app, e.id, e.kind, { deliver: 'failed', why: cleanLine(err?.message || err, 120) });
    }
  }
  return n;
}
