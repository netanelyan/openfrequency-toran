import { CHANNEL_HE } from '../channels/config.ts';
import { summaryHe } from '../agent/guard.ts';
import type { Why } from '../channels/customers.ts';
import { esc, icon, listTime, stamp } from './ui.ts';

// Where each conversation stands, in the website's three words (openfrequency.co.il/toran, "כל השיחות בתיבה אחת"):
//
//   waiting   מחכה לכם: Toran handed it to the owner, or the owner has the conversation (the agent is paused) and the
//             customer wrote again, and the owner has neither answered since nor marked it handled
//   fixed     תיקנתם: the owner answered in it (and, when they chose to, Toran keeps the answer for next time)
//   alone     ענה לבד: Toran answered, nobody else had to
//
// The SQL reads a conversation aliased c.

export type InboxState = 'waiting' | 'fixed' | 'alone';

export const STATE_HE: Record<InboxState, [label: string, cls: string]> = {
  waiting: ['מחכה לכם', 'bad'],
  fixed: ['תיקנתם', 'sig'],
  alone: ['ענה לבד', 'ok'],
};

/** Everything up to this message id is answered or handled. */
const handledUpto = `GREATEST(c.settled_upto, COALESCE((SELECT MAX(o.id) FROM messages o WHERE o.conversation_id = c.id AND o.role = 'owner'), 0))`;

export const WAITING_SQL = `(EXISTS (SELECT 1 FROM messages h WHERE h.conversation_id = c.id AND h.handoff IS NOT NULL AND h.id > ${handledUpto})
  OR (COALESCE(c.agent_paused_until > now(), false) AND EXISTS (SELECT 1 FROM messages h WHERE h.conversation_id = c.id AND h.role = 'customer' AND h.automated IS NULL AND h.id > ${handledUpto})))`;

// "טיפלתי בזה" (settled_upto) is the owner's too, never Toran's "ענה לבד" (the audit of 2026-11-12, P1-4): Today, the
// results and the month's email count it with the owner's answers. Our own pitch, kept in our support's conversation
// with the store we wrote to (ops/outreach.ts keepPitch, auto 'outreach'), is not an answer: a conversation where only
// Toran answered after it is Toran's alone.
export const STATE_SQL = `(CASE WHEN ${WAITING_SQL} THEN 'waiting'
  WHEN c.settled_upto > 0 OR EXISTS (SELECT 1 FROM messages o WHERE o.conversation_id = c.id AND o.role = 'owner' AND o.auto IS DISTINCT FROM 'outreach') THEN 'fixed'
  ELSE 'alone' END)`;

export const stateChip = (s: InboxState) => `<span class="chip ${STATE_HE[s][1]}">${STATE_HE[s][0]}</span>`;

// The archive (the owner, 2026-11-12: "Add an options to archive chats, and archive them automatically 5 days after
// inactivity"; migration 079). A conversation is in it when the owner put it there and nothing was written in it since,
// or when nothing was written in it for five days (counted again from when the owner took it out) and it waits for
// no one. A new message brings it back by itself: archived_at is older than last_at then. Toran answers in an archived
// conversation as in any other; only the lists leave it out.
export const ARCHIVE_DAYS = 5;
const BY_HAND = '(c.archived_at IS NOT NULL AND c.archived_at >= c.last_at)';
const SILENT = `(GREATEST(c.last_at, COALESCE(c.unarchived_at, c.last_at)) < now() - interval '${ARCHIVE_DAYS} days')`;
/** In the archive, given whether it waits for the owner (a query that has its state already reads it once). */
export const archivedSql = (waiting = WAITING_SQL) => `(${BY_HAND} OR (${SILENT} AND NOT ${waiting}))`;
export const ARCHIVED_SQL = archivedSql();

const maskPhone = (p: string | null) => (p ? `+${p.slice(0, 5)}•••${p.slice(-3)}` : '');
/**
 * The customer, as the inbox shows them: a phone or an address, partly hidden. On Messenger and Instagram the id is
 * Meta's and means nothing to the owner, so it is the name Meta gave for them (store.ts), or nothing.
 */
export const maskPeer = (channel: string, p: string | null, name?: string | null) => {
  if (channel === 'messenger' || channel === 'instagram') return String(name || '').slice(0, 60);
  // A visitor on the site chat is a random id of their browser, not a phone: "לקוח", as for no number at all.
  if (!p || channel === 'web') return '';
  if (channel !== 'email') return maskPhone(p);
  const [user, domain] = p.split('@');
  return `${user.slice(0, 2)}•••@${domain || ''}`;
};

const HEBREW = /[\u0590-\u05FF]/;

/** The customer's name as the inbox shows it: Meta's name for them, else their phone or address partly hidden. */
export const peerLabel = (channel: string, peer: string | null | undefined, name?: string | null) => maskPeer(channel, peer ?? null, name) || 'לקוח';

const LOGOS = new Set(['whatsapp', 'instagram', 'messenger', 'email', 'web']);
const channelName = (channel: string) => CHANNEL_HE[channel as keyof typeof CHANNEL_HE] || channel;

/**
 * A channel's own logo, in its colours (ui.ts CHANNEL_SYMBOLS; the owner, 2026-11-11: "mark every type of channel with
 * its logo"). Where it stands alone, on a row's avatar, it is a picture named in Hebrew, for a screen reader and as the
 * pointer's tooltip; beside the channel's name (`label: false`) it is decoration.
 */
export function channelLogo(channel: string, { label = true }: { label?: boolean } = {}) {
  // A channel with no logo of its own (none the inbox lists today) is a grey speech bubble.
  const known = LOGOS.has(channel);
  const use = `<use href="#ch-${known ? channel : 'web'}"/>`;
  const cls = `chl chl-${known ? channel : 'other'}`;
  if (!label) return `<svg class="${cls}" aria-hidden="true">${use}</svg>`;
  const name = esc(channelName(channel));
  return `<svg class="${cls}" role="img" aria-label="${name}"><title>${name}</title>${use}</svg>`;
}

/** The channel's name in the facts over an open conversation, beside the avatar that carries its logo. */
export const channelTag = (channel: string) => `<span class="chip">${esc(channelName(channel))}</span>`;

/**
 * A customer's avatar: the first letter of the name Meta gave, or a person when all there is is a number or an
 * address, in one of six calm colours picked from the customer (the CSP forbids an inline colour), with the channel's
 * logo on its corner, as a messaging app marks where a message came from. In a list row the logo is the row's only word
 * for the channel, so it is named; over an open conversation the channel's name is beside it (`label: false`).
 */
export function avatar(seed: string, name: string | null | undefined, channel: string, { cls = 'av', label = true }: { cls?: string; label?: boolean } = {}) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const letter = name ? String(name).trim().match(/\p{L}/u)?.[0] : null;
  const face = letter ? `<span aria-hidden="true">${esc(letter.toUpperCase())}</span>` : icon('user');
  return `<span class="${cls} av-${h % 6}"${label ? '' : ' aria-hidden="true"'}>${face}<span class="av-ch">${channelLogo(channel, { label })}</span></span>`;
}

const WHO_HE: Record<string, string> = { agent: 'תורן', owner: 'אתם' };

type RowOf = { id: number; channel: string; account_id: number | null; state: InboxState; archived?: boolean | null; last_at: string; last_q?: string | null; last_text?: string | null; last_role?: string | null; summary?: string | null; subject?: string | null; store?: string | null; note?: string | null; peer?: string | null; peer_name?: string | null };

/**
 * One conversation in the inbox, as a messaging app lists it (the owner, 2026-11-11: "make the toran inbox look a bit
 * more like an inbox"): the customer's avatar with the channel's logo on it, their name and when; an email's subject;
 * one line of the last message and who wrote it (while it waits, what Toran handed over, when that line is in Hebrew:
 * the model writes it for the owner, not always in their language) with where it stands at its end; and, only when
 * there is one, a demo tag for a chat on our shared demo number, the store among several, the operator's note, and
 * "בארכיון" in a search's results, which have the archive's conversations too. A
 * conversation waiting for the owner is the unread one: bold, with a dot at its edge, and its "מחכה לכם" said to a
 * screen reader only, so on a phone the line of what Toran handed over keeps the row's width. `current` marks the
 * conversation open beside the list; `qs` keeps the list's filters on the link.
 */
export function conversationRow(c: RowOf, { current = false, qs = '' }: { current?: boolean; qs?: string } = {}) {
  // The handoff line in Hebrew, an old English one too ("the guard cut stock: מה נשמע", the owner's Today, 2026-11-11).
  const summary = c.summary ? summaryHe(c.summary) : '';
  const handed = c.state === 'waiting' && !!summary && HEBREW.test(summary);
  // One line of plain words: WhatsApp's own _italic_, *bold* and ~strike~ marks come off.
  const text = String((handed ? summary : c.last_text || c.last_q) || '').replace(/(^|\s)([_*~])([^_*~\n]+)\2(?=\s|$)/g, '$1$3').replace(/\s+/g, ' ').trim().slice(0, 160);
  const who = handed ? 'תורן העביר' : WHO_HE[c.last_role || ''];
  const demo = c.channel === 'whatsapp' && !c.account_id ? '<span class="chip ghost">דמו</span>' : '';
  const subject = c.channel === 'email' && c.subject ? `<span class="ib-subj">${esc(c.subject.slice(0, 90))}</span>` : '';
  const meta = `${c.archived ? '<span class="chip ghost">בארכיון</span>' : ''}${demo}${c.store ? `<span class="chip ghost">${esc(c.store)}</span>` : ''}${c.note ? `<span class="chip ghost">${esc(c.note)}</span>` : ''}`;
  const state = c.state === 'waiting' ? `<span class="sr">${STATE_HE.waiting[0]}</span>` : stateChip(c.state);
  return `<a class="ib-row${c.state === 'waiting' ? ' is-waiting' : ''}" href="/chat/${Number(c.id)}${qs}"${current ? ' aria-current="page"' : ''}>${avatar(`${c.channel}:${c.peer || c.id}`, c.peer_name, c.channel)}<span class="ib-main">`
    + `<span class="ib-top"><b class="ib-name"><bdi>${esc(peerLabel(c.channel, c.peer, c.peer_name))}</bdi></b><time class="ib-at" datetime="${esc(new Date(c.last_at).toISOString())}" title="${esc(stamp(c.last_at))}">${esc(listTime(c.last_at))}</time></span>`
    + `${subject}<span class="ib-line"><span class="ib-snip">${who ? `<span class="ib-who">${esc(who)}:</span> ` : ''}${esc(text || 'שיחה')}</span>${state}</span>`
    + (meta ? `<span class="ib-meta">${meta}</span>` : '')
    + '</span></a>';
}

/** The columns conversationRow reads, for a query over conversations c. */
export const ROW_SQL = `c.id, c.channel, c.account_id, c.last_at, c.peer, c.meta->>'name' AS peer_name, ${STATE_SQL} AS state,
  (SELECT text FROM messages WHERE conversation_id = c.id AND role = 'customer' AND text <> '' ORDER BY id DESC LIMIT 1) AS last_q,
  (SELECT text FROM messages WHERE conversation_id = c.id AND role <> 'system' AND text <> '' ORDER BY id DESC LIMIT 1) AS last_text,
  (SELECT role FROM messages WHERE conversation_id = c.id AND role <> 'system' AND text <> '' ORDER BY id DESC LIMIT 1) AS last_role,
  (SELECT handoff->>'summary' FROM messages WHERE conversation_id = c.id AND handoff IS NOT NULL ORDER BY id DESC LIMIT 1) AS summary,
  c.meta->>'subject' AS subject`;

// ---- the files on a message (channels/files.ts)

const SKIPPED_HE: Record<string, string> = { too_big: 'גדול מדי, לא נשמר', type: 'סוג קובץ שלא מוצג כאן', unavailable: 'הקובץ עצמו לא הגיע', failed: 'לא הצלחנו להוריד אותו', too_many: 'יותר מדי קבצים בהודעה אחת' };
const kb = (n: unknown) => `${Math.max(1, Math.round((Number(n) || 0) / 1024))}KB`;

/** A message's files in its bubble: a kept image as a picture, a kept PDF as a link that downloads, the rest by name and why. */
export function filesHtml(conversationId: number, list: any[] | null | undefined): string {
  if (!list?.length) return '';
  const items = list.map((a) => {
    if (!a?.id || a.skipped) return `<span class="file off">${esc(a?.name || 'file')} (${a?.skipped ? esc(SKIPPED_HE[a.skipped] || a.skipped) : kb(a?.size)})</span>`;
    const href = `/chat/${Number(conversationId)}/file/${Number(a.id)}`;
    if (String(a.type).startsWith('image/')) return `<a class="thumb" href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="${esc(a.name)}" loading="lazy"></a>`;
    return `<a class="file" href="${href}" download>${icon('book')}<span>${esc(a.name)} · ${kb(a.size)}</span></a>`;
  });
  return `<span class="files">${items.join('')}</span>`;
}

// ---- one customer across channels (channels/customers.ts)

const SAME_HE: Record<string, string> = { email: 'אותה כתובת מייל', whatsapp: 'אותו מספר', messenger: 'אותו חשבון', instagram: 'אותו חשבון' };

/** Why the inbox shows a conversation as this customer's too. */
export const whyHe = (why: Why, channel: string) => (why === 'same' ? SAME_HE[channel] || 'אותו לקוח' : why === 'owner' ? 'חוברו ידנית' : 'המייל או הטלפון נכתבו בשיחה');
