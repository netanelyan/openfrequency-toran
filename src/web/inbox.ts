import { CHANNEL_HE } from '../channels/config.ts';
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
/** The customer, as the inbox shows them: a phone or an address, partly hidden. */
export const maskPeer = (channel: string, p: string | null) => {
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
export function conversationRow(c: { id: number; channel: string; account_id: number | null; state: InboxState; last_at: string; last_q?: string | null; summary?: string | null; subject?: string | null; store?: string | null }) {
  const text = (c.state === 'waiting' && c.summary && HEBREW.test(c.summary) ? c.summary : c.last_q || c.subject || '').replace(/\n/g, ' ').slice(0, 90);
  const ico = c.state === 'waiting' ? ['bad', 'hand'] : c.state === 'fixed' ? ['sig', 'edit'] : ['ok', 'chat'];
  const demo = c.channel === 'whatsapp' && !c.account_id ? ' · <span class="chip ghost">דמו</span>' : '';
  return `<a href="/chat/${Number(c.id)}"><span class="ico ${ico[0]}">${icon(ico[1])}</span><span class="t"><b>${c.store ? `${esc(c.store)} · ` : ''}${esc(text || 'שיחה')}</b><small><span class="chip">${esc(CHANNEL_HE[c.channel as keyof typeof CHANNEL_HE] || c.channel)}</span>${demo} · ${stateChip(c.state)} · ${esc(ago(c.last_at))}</small></span><span class="go">${icon('chev')}</span></a>`;
}

/** The columns conversationRow reads, for a query over conversations c. */
export const ROW_SQL = `c.id, c.channel, c.account_id, c.last_at, ${STATE_SQL} AS state,
  (SELECT text FROM messages WHERE conversation_id = c.id AND role = 'customer' AND text <> '' ORDER BY id DESC LIMIT 1) AS last_q,
  (SELECT handoff->>'summary' FROM messages WHERE conversation_id = c.id AND handoff IS NOT NULL ORDER BY id DESC LIMIT 1) AS summary,
  c.meta->>'subject' AS subject`;
