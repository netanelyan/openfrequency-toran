import type { App } from '../app.ts';
import { audit, event } from '../db/log.ts';
import { accountsLinks } from '../web/accounts.ts';
import { replyParts, type Part } from '../channels/send.ts';
import type { ChannelAdapter, Inbound } from '../channels/types.ts';
import { askOwner, keep, type AssistantInput } from '../assistant/index.ts';
import { claimLink, LINK_CODE, ownerByPhone, setConsent, type Owner } from './identity.ts';
import { readReply } from './intents.ts';
import { DISCLOSURE, rememberOwner } from './notify.ts';
import { act, lastList, showPending, status, type PostsCtx } from './posts.ts';
import { tederClient } from './teder.ts';
import { supportAccount } from '../company.ts';
import { storeChannel } from '../channels/store.ts';

// One message on the owner line (TORAN_ASSISTANT_WA), or from a verified owner's number on the demo number, end to
// end. In this order:
//
//   1. a link code (LINK-XXXXXX from accounts): the number that sent it becomes that user's, through accounts
//   2. who the number is, asked of accounts now. Not linked: our support agent answers when TORAN_SUPPORT_STORE names
//      a company store (src/company.ts), else one short line saying so (at most once an hour); accounts not
//      answering: a line saying to try again. Nobody unverified gets further than support
//   3. the limit: OWNER_PER_10_MIN and OWNER_PER_DAY messages a number, then one line saying so, then silence
//   4. "הפסק" and "התחל", read in code: Teder's messages stop or start again (accounts keeps the consent; Toran
//      keeps the stop too, in case accounts could not be told)
//   5. Toran's "כן" or "לא" to the one offer waiting (assistant/index.ts), when that offer is newer than the last
//      Teder list
//   6. Teder: a reply about the posts the owner saw, read in code (intents.ts), acted on at once and said back
//   7. anything else: the model, with Toran's tools (for a store's owner) and Teder's (when the workspace has it)
//
// The first answer to each number starts with the disclosure line. Everything said either way is kept in
// assistant_messages, and every action in the audit.

export const OWNER_PER_10_MIN = 20;
export const OWNER_PER_DAY = 300;
const STOP = /^\s*(?:הפסק|תפסיק|תפסיקו|stop|unsubscribe)\s*[.!]*\s*$/i;
const START = /^\s*(?:התחל|תתחיל|תתחילו|start)\s*[.!]*\s*$/i;

const say = {
  linked: (name: string, optIn: boolean) => `המספר הזה מחובר עכשיו לחשבון של ${name}. אפשר לכתוב לי כאן על החנות ועל הפוסטים.${optIn ? ' כשיהיו לכם פוסטים חדשים מתדר אשלח אותם לכאן. כדי להפסיק, כתבו "הפסק".' : ''}`,
  claimRefused: {
    unknown_code: 'את הקוד הזה אני לא מכיר. אפשר ליצור קוד חדש בחשבון ולשלוח אותו שוב.',
    expired: 'הקוד הזה כבר לא בתוקף, הוא טוב לחצי שעה. אפשר ליצור קוד חדש בחשבון.',
    used: 'הקוד הזה כבר שימש לחיבור. אפשר ליצור קוד חדש בחשבון.',
    phone_taken: 'המספר הזה כבר מחובר לחשבון אחר. כדי לחבר אותו כאן, צריך קודם להסיר אותו משם.',
  } as Record<string, string>,
  notLinked: (url: string) => `המספר הזה לא מחובר לחשבון ב-OpenFrequency, אז אני לא יכול לענות עליו. מחברים אותו מהחשבון: ${url}`,
  down: 'משהו אצלנו לא עובד כרגע, אז אני לא יכול לענות. נסו שוב עוד כמה דקות.',
  tooMany: 'קיבלתי הרבה הודעות ברצף. אמשיך לענות בעוד כמה דקות.',
  stopped: 'הפסקתי. לא אשלח לכם יותר הודעות מתדר, ואם תכתבו לי אענה כרגיל. כדי לקבל אותן שוב, כתבו "התחל".',
  stopNotSaved: 'הפסקתי לשלוח לכם הודעות מתדר. את השינוי בחשבון לא הצלחתי לשמור כרגע, אבל ממני לא תקבלו אותן עד שתכתבו "התחל".',
  started: 'מעכשיו ההודעות מתדר יגיעו לכאן: מצגות חדשות לאישור, תזכורות להעלאה וסיכום שבועי. כדי להפסיק, כתבו "הפסק".',
  startFailed: 'לא הצלחתי לשמור את זה כרגע. נסו שוב עוד כמה דקות.',
  noTeder: 'אין תדר בחשבון הזה, אז אין הודעות ממנו לשלוח או לעצור.',
  outOfRange: (n: number, size: number) => `ברשימה האחרונה ששלחתי ${size === 1 ? 'יש רק מצגת אחת' : `יש ${size} מצגות`}, אז אין ${n}. כדי לראות מה מחכה עכשיו, כתבו "הצג".`,
  noText: 'אני קורא כאן רק טקסט. אפשר לכתוב לי במילים?',
};

export type LineResult = { action: 'duplicate' | 'assistant' | 'support' | 'linked' | 'link_refused' | 'not_linked' | 'unavailable' | 'limit' | 'opt_out' | 'opt_in' | 'no_text' | 'silent'; reply?: string; storeId?: number | null };

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
    await replyParts(app, adapter, inbound, parts, storeId);
  };
  // A webhook delivered twice is acted on once.
  if (!(await app.db.one('INSERT INTO owner_inbound (ext_id, phone) VALUES ($1, $2) ON CONFLICT (ext_id) DO NOTHING RETURNING ext_id', [inbound.id, phone]))) return { action: 'duplicate' };

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
    const line = `${row.disclosed_at ? '' : `${DISCLOSURE}\n\n`}${say.linked(r.owner.workspace.name || r.owner.user.name || '', Boolean(r.owner.optIn && !r.owner.optOut))}`;
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
  const row = await rememberOwner(app, owner, { inboundAt: inbound.at ?? Date.now() });
  const storeId = await storeOf(app, owner);
  const hasTeder = owner.products.includes('teder');
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
  if (!text) return answer([{ text: say.noText }], 'no_text');

  // 4. "הפסק" and "התחל".
  if (STOP.test(text) || START.test(text)) {
    const stop = STOP.test(text);
    await keep(app, base, 'owner', text, phone);
    let line: string;
    if (!hasTeder) line = say.noTeder;
    else if (stop) {
      await app.db.query('UPDATE owner_numbers SET opted_out_at = now() WHERE phone = $1', [phone]);
      const r = await setConsent(app, phone, false);
      line = r.ok ? say.stopped : say.stopNotSaved;
    } else {
      const r = await setConsent(app, phone, true);
      if (r.ok) await app.db.query('UPDATE owner_numbers SET opted_out_at = NULL WHERE phone = $1', [phone]);
      line = r.ok ? say.started : say.startFailed;
    }
    await audit(app.db, { actor: `wa:${phone}`, action: stop ? 'owner_opt_out' : 'owner_opt_in', detail: { workspace: owner.workspace.id, line } });
    await keep(app, base, 'assistant', line, 'toran');
    return answer([{ text: line }], stop ? 'opt_out' : 'opt_in');
  }

  const posts: PostsCtx | null = hasTeder ? { app, teder: tederClient(app, owner.workspace.id, { name: owner.user.name || `וואטסאפ …${phone.slice(-4)}`, userId: owner.user.id }), workspaceId: owner.workspace.id, phone } : null;

  // 5 and 6. Teder's posts, read in code, unless Toran's own offer is the newer thing the owner is answering.
  if (posts) {
    const list = await lastList(app, phone, owner.workspace.id);
    const offer = storeId ? await app.db.one<{ created_at: string }>("SELECT created_at FROM assistant_actions WHERE store_id = $1 AND status = 'pending' AND created_at > now() - interval '30 minutes' ORDER BY id DESC LIMIT 1", [storeId]) : null;
    const offerFirst = offer && (!list || new Date(offer.created_at) > new Date(list.at));
    const reading = offerFirst ? null : readReply(text, list?.items.length || 0);
    if (reading?.ok) {
      await keep(app, base, 'owner', text, phone);
      const parts: Part[] = [];
      const lines: string[] = [];
      const kinds = new Set(reading.intents.map((i) => i.kind));
      if (kinds.has('show')) {
        const r = await showPending(posts);
        lines.push(...r.lines);
        parts.push(...r.parts);
      } else if (kinds.has('status')) {
        lines.push(...(await status(posts)).lines);
      } else {
        const r = await act(posts, list!.items, reading.intents);
        lines.push(...r.lines);
        parts.push(...r.parts);
      }
      const all: Part[] = [...(lines.length ? [{ text: lines.join('\n') }] : []), ...parts];
      await keep(app, base, 'assistant', textOf(all), 'toran', [{ name: 'read_in_code', input: { intents: reading.intents } }]);
      return answer(all);
    }
    if (reading && !reading.ok && reading.why === 'out_of_range') {
      const line = say.outOfRange(reading.detail!, list?.items.length || 0);
      await keep(app, base, 'owner', text, phone);
      await keep(app, base, 'assistant', line, 'toran');
      return answer([{ text: line }]);
    }
  }

  // 7. The model.
  if (!storeId && !posts) {
    const line = 'החשבון הזה עוד לא מחובר לחנות בתורן או לתדר, אז אין לי עדיין על מה לענות.';
    return answer([{ text: line }]);
  }
  const r = await askOwner(app, { ...base, text, author: phone, teder: posts });
  await event(app.db, storeId, 'assistant_whatsapp', { teder: Boolean(posts) });
  return answer([...(r.text ? [{ text: r.text }] : []), ...r.parts]);
}
