import type { App } from '../app.ts';
import { audit, event } from '../db/log.ts';
import { J } from '../db/index.ts';
import { accountsLinks } from '../web/accounts.ts';
import { replyParts, type Part } from '../channels/send.ts';
import type { ChannelAdapter, Inbound } from '../channels/types.ts';
import { askOwner, keep, type AssistantInput } from '../assistant/index.ts';
import { claimLink, LINK_CODE, ownerByPhone, setConsent, type Owner } from './identity.ts';
import { readReply } from './intents.ts';
import { DISCLOSURE, rememberOwner } from './notify.ts';
import { lastList } from './posts.ts';
import { supportAccount } from '../company.ts';
import { storeChannel } from '../channels/store.ts';
import { tederUrl } from '../ops/sources.ts';

// One message on the owner line (TORAN_ASSISTANT_WA), or from a verified owner's number on the demo number, end to
// end. In this order:
//
//   1. a link code (LINK-XXXXXX from accounts): the number that sent it becomes that user's, through accounts
//   2. who the number is, asked of accounts now. Not linked: our support agent answers when TORAN_SUPPORT_STORE names
//      a company store (src/company.ts), else one short line saying so (at most once an hour); accounts not
//      answering: a line saying to try again. Nobody unverified gets further than support.
//      Teder is managed on its own dashboard only (the owner, 2026-11-02: "managing teder through whatsapp, only
//      through the dashboard"): an owner whose workspace has no Toran store has nothing of theirs on this line, and
//      our support answers them as it answers anyone (else one line says where Teder is, at most once an hour)
//   3. the limit: OWNER_PER_10_MIN and OWNER_PER_DAY messages a number, then one line saying so, then silence.
//      The operator answered this owner from our phone (our one number, channels/waStore.ts lineEcho): until the
//      pause ends, everything but "הפסק" and "התחל" is kept for the operator and not answered
//   4. "הפסק" and "התחל", read in code. Nothing of Teder's is sent to WhatsApp any more (owners/events.ts): "הפסק"
//      is still kept as the owner's word (in accounts, and here in case accounts could not be told), "התחל" turns
//      nothing on, and both say where Teder is
//   5. a reply about Teder's posts (read in code, intents.ts), or Teder's old template buttons ("הצג", "סטטוס"):
//      one line saying the posts are approved on Teder's dashboard, and nothing reaches Teder. Toran's "כן" or "לא"
//      to the one offer waiting (assistant/index.ts) is still Toran's when that offer is the newer thing
//   6. anything else: the model, with Toran's tools, for a store's owner
//
// The first answer to each number starts with the disclosure line. Everything said either way is kept in
// assistant_messages, and every action in the audit.
//
// The answer is kept with the message's row (owner_inbound.reply) before it is sent, and marked when it went out. The
// same message again (its job run again after the send failed) sends that answer, and acts on nothing twice.

export const OWNER_PER_10_MIN = 20;
export const OWNER_PER_DAY = 300;
const STOP = /^\s*(?:הפסק|תפסיק|תפסיקו|stop|unsubscribe)\s*[.!]*\s*$/i;
const START = /^\s*(?:התחל|תתחיל|תתחילו|start)\s*[.!]*\s*$/i;

/** Where Teder is managed now, said the same way wherever a Teder owner asks for it on WhatsApp. */
export const tederHere = (url: string) => `את המצגות של תדר מאשרים עכשיו רק בלוח הבקרה של תדר: ${url}. שם גם מתקנים אותן ורואים מה עלה.`;

const say = {
  linked: (name: string, url: string | null) => `המספר הזה מחובר עכשיו לחשבון של ${name}. ${url ? tederHere(url) : 'אפשר לכתוב לי כאן על החנות.'}`,
  claimRefused: {
    unknown_code: 'את הקוד הזה אני לא מכיר. אפשר ליצור קוד חדש בחשבון ולשלוח אותו שוב.',
    expired: 'הקוד הזה כבר לא בתוקף, הוא טוב לחצי שעה. אפשר ליצור קוד חדש בחשבון.',
    used: 'הקוד הזה כבר שימש לחיבור. אפשר ליצור קוד חדש בחשבון.',
    phone_taken: 'המספר הזה כבר מחובר לחשבון אחר. כדי לחבר אותו כאן, צריך קודם להסיר אותו משם.',
  } as Record<string, string>,
  notLinked: (url: string) => `המספר הזה לא מחובר לחשבון ב-OpenFrequency, אז אני לא יכול לענות עליו. מחברים אותו מהחשבון: ${url}`,
  down: 'משהו אצלנו לא עובד כרגע, אז אני לא יכול לענות. נסו שוב עוד כמה דקות.',
  tooMany: 'קיבלתי הרבה הודעות ברצף. אמשיך לענות בעוד כמה דקות.',
  stopped: (url: string) => `רשמתי, ומתדר לא יגיעו אליכם הודעות לכאן. ${tederHere(url)}`,
  noMessages: (url: string) => `מתדר כבר לא נשלחות הודעות לוואטסאפ. ${tederHere(url)}`,
  noTeder: 'אין תדר בחשבון הזה, אז אין הודעות ממנו לשלוח או לעצור.',
  noStore: 'החשבון הזה עוד לא מחובר לחנות בתורן, אז אין לי עדיין על מה לענות.',
  noText: 'אני קורא כאן רק טקסט. אפשר לכתוב לי במילים?',
};

export type LineResult = { action: 'duplicate' | 'resent' | 'assistant' | 'support' | 'linked' | 'link_refused' | 'not_linked' | 'unavailable' | 'limit' | 'opt_out' | 'opt_in' | 'no_text' | 'silent' | 'held' | 'teder_dashboard'; reply?: string; storeId?: number | null };

const textOf = (parts: Part[]) => parts.map((p) => ('text' in p ? p.text : p.caption ? `[${p.caption}]` : '[תמונה]')).join('\n\n');

async function onceAnHour(app: App, kind: string, phone: string): Promise<boolean> {
  const seen = await app.db.one("SELECT 1 FROM events WHERE kind = $1 AND data->>'phone' = $2 AND at > now() - interval '1 hour'", [kind, phone]);
  await event(app.db, null, kind, { phone });
  return !seen;
}

/** The store the owner's answers are about: their workspace's, the most recently active. */
async function storeOf(app: App, owner: Owner): Promise<number | null> {
  if (!owner.products.includes('toran')) return null;
  const s = await app.db.one<{ id: number }>("SELECT id FROM stores WHERE workspace_id = $1 AND status <> 'skipped' ORDER BY updated_at DESC LIMIT 1", [owner.workspace.id]);
  return s?.id ?? null;
}

export async function ownerLine(app: App, adapter: ChannelAdapter, inbound: Inbound, known: Owner | null = null): Promise<LineResult> {
  const phone = inbound.from;
  const text = String(inbound.text || '').trim();
  const send = async (parts: Part[], storeId: number | null = null) => {
    await app.db.query('UPDATE owner_inbound SET reply = $2::jsonb WHERE ext_id = $1', [inbound.id, J({ parts, storeId })]);
    const d = await replyParts(app, adapter, inbound, parts, storeId);
    if (d.ok) await app.db.query('UPDATE owner_inbound SET delivered_at = now() WHERE ext_id = $1', [inbound.id]);
  };
  // A webhook delivered twice is acted on once. If its answer was kept and did not go out, that answer is sent now.
  if (!(await app.db.one('INSERT INTO owner_inbound (ext_id, phone) VALUES ($1, $2) ON CONFLICT (ext_id) DO NOTHING RETURNING ext_id', [inbound.id, phone]))) {
    const kept = await app.db.one<{ reply: { parts: Part[]; storeId: number | null } | null; delivered_at: string | null }>('SELECT reply, delivered_at FROM owner_inbound WHERE ext_id = $1', [inbound.id]);
    if (!kept?.reply?.parts?.length || kept.delivered_at) return { action: 'duplicate' };
    await send(kept.reply.parts, kept.reply.storeId ?? null);
    return { action: 'resent', reply: textOf(kept.reply.parts), storeId: kept.reply.storeId ?? null };
  }

  // 1. A link code proves the number: it was sent from it.
  const code = LINK_CODE.exec(text);
  if (code) {
    const r = await claimLink(app, `LINK-${code[1].toUpperCase()}`, phone);
    await audit(app.db, { actor: `wa:${phone}`, action: 'owner_link', detail: { ok: r.ok, reason: r.ok ? null : r.reason, workspace: r.ok ? r.owner.workspace.id : null } });
    if (!r.ok) {
      const line = say.claimRefused[r.reason] || say.down;
      await send([{ text: line }]);
      return { action: 'link_refused', reply: line };
    }
    const row = await rememberOwner(app, r.owner, { inboundAt: inbound.at ?? Date.now() });
    // A workspace with Toran is told it can write about the store; one with Teder alone, where Teder is managed.
    const tederOnly = !r.owner.products.includes('toran') && r.owner.products.includes('teder');
    const line = `${row.disclosed_at ? '' : `${DISCLOSURE}\n\n`}${say.linked(r.owner.workspace.name || r.owner.user.name || '', tederOnly ? tederUrl(app.env) : null)}`;
    await app.db.query('UPDATE owner_numbers SET disclosed_at = COALESCE(disclosed_at, now()), opted_out_at = NULL WHERE phone = $1', [phone]);
    await send([{ text: line }]);
    return { action: 'linked', reply: line };
  }

  // 2. Who this is, now.
  let owner = known;
  if (!owner) {
    const r = await ownerByPhone(app, phone);
    if (!r.ok) {
      if (r.reason === 'unavailable' || r.reason === 'not_configured') {
        if (await onceAnHour(app, 'owner_line_down', phone)) await send([{ text: say.down }]);
        return { action: 'unavailable' };
      }
      // Someone who is not one of our customers' people: our own support answers, as a company store would.
      const support = await supportAccount(app, adapter, app.env.TORAN_ASSISTANT_WA);
      if (support) {
        const r = await storeChannel(app, adapter, inbound, support);
        return { action: 'support', reply: r.reply, storeId: support.store_id };
      }
      const line = say.notLinked(accountsLinks(app.env).home);
      if (await onceAnHour(app, 'owner_line_unlinked', phone)) await send([{ text: line }]);
      return { action: 'not_linked', reply: line };
    }
    owner = r.owner;
  }
  const storeId = await storeOf(app, owner);
  const hasTeder = owner.products.includes('teder');
  const dashboard = tederUrl(app.env);

  // An owner with Teder and no Toran store: Teder is managed on its dashboard, so nothing of theirs is on this line.
  // Our support answers them, on the number they wrote to, as it answers anyone (its status says where Teder is managed:
  // openfrequency-web src/support.mjs). Nothing is kept here as theirs, so an answer the operator writes from our phone
  // lands in that support conversation (channels/waStore.ts lineEcho), and nothing reaches the assistant or Teder.
  if (!storeId && hasTeder) {
    const support = await supportAccount(app, adapter, inbound.to || app.env.TORAN_ASSISTANT_WA);
    if (support) {
      const r = await storeChannel(app, adapter, inbound, support);
      return { action: 'support', reply: r.reply, storeId: support.store_id };
    }
    // Said by the bot, as every first answer is (the line is at most once an hour, so it always says so).
    const line = `${DISCLOSURE}\n\n${tederHere(dashboard)}`;
    if (await onceAnHour(app, 'owner_line_teder', phone)) await send([{ text: line }]);
    return { action: 'teder_dashboard', reply: line };
  }

  const row = await rememberOwner(app, owner, { inboundAt: inbound.at ?? Date.now() });
  const base: Pick<AssistantInput, 'storeId' | 'via' | 'phone' | 'workspaceId'> = { storeId, via: 'whatsapp', phone, workspaceId: owner.workspace.id };
  const answer = async (parts: Part[], action: LineResult['action'] = 'assistant'): Promise<LineResult> => {
    if (!row.disclosed_at) {
      const i = parts.findIndex((p) => 'text' in p);
      if (i >= 0) parts[i] = { text: `${DISCLOSURE}\n\n${(parts[i] as { text: string }).text}` };
      else parts.unshift({ text: DISCLOSURE });
      await app.db.query('UPDATE owner_numbers SET disclosed_at = COALESCE(disclosed_at, now()) WHERE phone = $1', [phone]);
    }
    await send(parts, storeId);
    return { action, reply: textOf(parts), storeId };
  };

  // 3. The limit.
  const n = await app.db.one<{ ten: number; day: number }>("SELECT COUNT(*) FILTER (WHERE at > now() - interval '10 minutes')::int AS ten, COUNT(*)::int AS day FROM assistant_messages WHERE phone = $1 AND role = 'owner' AND at > now() - interval '1 day'", [phone]);
  if ((n?.ten || 0) >= OWNER_PER_10_MIN || (n?.day || 0) >= OWNER_PER_DAY) {
    if (await onceAnHour(app, 'owner_line_limit', phone)) await send([{ text: say.tooMany }]);
    return { action: 'limit' };
  }
  // The operator is answering this owner from our phone: kept for them, not answered, but "הפסק" still stops.
  if (row.agent_paused_until && new Date(row.agent_paused_until).getTime() > Date.now() && !STOP.test(text) && !START.test(text)) {
    await keep(app, base, 'owner', text || '(קובץ)', phone);
    await event(app.db, storeId, 'held', { via: 'owner_line', phone });
    return { action: 'held', storeId };
  }
  if (!text) return answer([{ text: say.noText }], 'no_text');

  // 4. "הפסק" and "התחל".
  if (STOP.test(text) || START.test(text)) {
    const stop = STOP.test(text);
    await keep(app, base, 'owner', text, phone);
    let line: string;
    if (!hasTeder) line = say.noTeder;
    else if (stop) {
      // Nothing of Teder's goes out any more, but the stop is the owner's word, kept as before.
      await app.db.query('UPDATE owner_numbers SET opted_out_at = now() WHERE phone = $1', [phone]);
      await setConsent(app, phone, false);
      line = say.stopped(dashboard);
    } else line = say.noMessages(dashboard);
    await audit(app.db, { actor: `wa:${phone}`, action: stop ? 'owner_opt_out' : 'owner_opt_in', detail: { workspace: owner.workspace.id, line } });
    await keep(app, base, 'assistant', line, 'toran');
    return answer([{ text: line }], stop ? 'opt_out' : 'opt_in');
  }

  // 5. Teder's posts are approved on its dashboard: a reply about them, read in code, is answered with where, unless
  // Toran's own offer is the newer thing the owner is answering. Nothing is asked of Teder.
  if (hasTeder) {
    const list = await lastList(app, phone, owner.workspace.id);
    const offer = storeId ? await app.db.one<{ created_at: string }>("SELECT created_at FROM assistant_actions WHERE store_id = $1 AND status = 'pending' AND created_at > now() - interval '30 minutes' ORDER BY id DESC LIMIT 1", [storeId]) : null;
    const offerFirst = offer && (!list || new Date(offer.created_at) > new Date(list.at));
    const reading = offerFirst ? null : readReply(text, list?.items.length || 0);
    if (reading && (reading.ok || reading.why === 'out_of_range')) {
      const line = tederHere(dashboard);
      await keep(app, base, 'owner', text, phone);
      await keep(app, base, 'assistant', line, 'toran');
      await event(app.db, storeId, 'owner_line_teder', { phone });
      return answer([{ text: line }], 'teder_dashboard');
    }
  }

  // 6. The model, with Toran's tools.
  if (!storeId) return answer([{ text: say.noStore }]);
  const r = await askOwner(app, { ...base, text, author: phone, teder: null });
  await event(app.db, storeId, 'assistant_whatsapp', { teder: false });
  return answer([...(r.text ? [{ text: r.text }] : []), ...r.parts]);
}
