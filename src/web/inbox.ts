import { CHANNEL_HE } from '../channels/config.ts';
import type { Why } from '../channels/customers.ts';
import { ago, esc, icon } from './ui.ts';

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

export const STATE_SQL = `(CASE WHEN ${WAITING_SQL} THEN 'waiting'
  WHEN EXISTS (SELECT 1 FROM messages o WHERE o.conversation_id = c.id AND o.role = 'owner') THEN 'fixed'
  ELSE 'alone' END)`;

export const stateChip = (s: InboxState) => `<span class="chip ${STATE_HE[s][1]}">${STATE_HE[s][0]}</span>`;

const maskPhone = (p: string | null) => (p ? `+${p.slice(0, 5)}•••${p.slice(-3)}` : '');
/**
 * The customer, as the inbox shows them: a phone or an address, partly hidden. On Messenger and Instagram the id is
 * Meta's and means nothing to the owner, so it is the name Meta gave for them (store.ts), or nothing.
 */
export const maskPeer = (channel: string, p: string | null, name?: string | null) => {
  if (channel === 'messenger' || channel === 'instagram') return String(name || '').slice(0, 60);
  if (!p) return '';
  if (channel !== 'email') return maskPhone(p);
  const [user, domain] = p.split('@');
  return `${user.slice(0, 2)}•••@${domain || ''}`;
};

const HEBREW = /[\u0590-\u05FF]/;

/**
 * One conversation in a customer's lists: what was asked (or, while it waits, what Toran handed over, when that line
 * is in Hebrew; the model writes it for the owner, not always in their language), its channel, a demo tag for a chat
 * on our shared demo number, where it stands, and when.
 */
export function conversationRow(c: { id: number; channel: string; account_id: number | null; state: InboxState; last_at: string; last_q?: string | null; summary?: string | null; subject?: string | null; store?: string | null; note?: string | null }) {
  const text = (c.state === 'waiting' && c.summary && HEBREW.test(c.summary) ? c.summary : c.last_q || c.subject || '').replace(/\n/g, ' ').slice(0, 90);
  const ico = c.state === 'waiting' ? ['bad', 'hand'] : c.state === 'fixed' ? ['sig', 'edit'] : ['ok', 'chat'];
  const demo = c.channel === 'whatsapp' && !c.account_id ? ' · <span class="chip ghost">דמו</span>' : '';
  return `<a href="/chat/${Number(c.id)}"><span class="ico ${ico[0]}">${icon(ico[1])}</span><span class="t"><b>${c.store ? `${esc(c.store)} · ` : ''}${esc(text || 'שיחה')}</b><small><span class="chip">${esc(CHANNEL_HE[c.channel as keyof typeof CHANNEL_HE] || c.channel)}</span>${demo} · ${stateChip(c.state)} · ${esc(ago(c.last_at))}${c.note ? ` · ${esc(c.note)}` : ''}</small></span><span class="go">${icon('chev')}</span></a>`;
}

/** The columns conversationRow reads, for a query over conversations c. */
export const ROW_SQL = `c.id, c.channel, c.account_id, c.last_at, ${STATE_SQL} AS state,
  (SELECT text FROM messages WHERE conversation_id = c.id AND role = 'customer' AND text <> '' ORDER BY id DESC LIMIT 1) AS last_q,
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
