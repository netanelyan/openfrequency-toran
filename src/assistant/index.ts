import type { App } from '../app.ts';
import { J } from '../db/index.ts';
import { audit, event, usage as recordUsage } from '../db/log.ts';
import { agentModel } from '../agent/llm/index.ts';
import { type Block, type Msg, type ToolDef, type ToolUseBlock, isText, isToolUse } from '../agent/llm/types.ts';
import { runTool } from '../agent/tools.ts';
import { displayName } from '../ingest/brand.ts';
import { ownerReply, PAUSE_HOURS, replyState, resumeAgent } from '../channels/owner.ts';
import { asked, conversation, outOfStock, overview, waiting, who } from './data.ts';
import type { Part } from '../channels/send.ts';
import { mentioned, normalize, type Intent, type Reason } from '../owners/intents.ts';
import { act, lastList, sendBundle, showPending, status, type ListItem, type PostsCtx } from '../owners/posts.ts';

// The owner's assistant: the store's owner writes to Toran (on the dashboard, or from their own WhatsApp number) and
// Toran answers about the store from what it holds: the conversations, the questions waiting for them, what customers
// ask about, the catalogue. It does not see the store's orders or carts (no Shopify admin access yet) and says so.
//
// It never acts on its own. The model can only propose one thing (answer a customer with the owner's words, pause
// itself in a conversation, come back to one); the proposal waits, and the code does it when the owner's next message
// is "כן" and drops it on "לא". The yes and the no are read by code, not by the model, so no answer of the model's can
// send anything.
//
// Every number in an answer must be in a tool result, the owner's words or the chat so far; an answer with any other
// number is asked again once, then replaced with a plain "not found".
//
// On the owner line (src/owners/) the same assistant also serves Teder, for an owner whose workspace has it: the
// teder_ tools below see the posts waiting and act on them by the number the owner saw. Those act at once, on the
// owner's own words (docs/owner-line.md), and only on a number the owner's message names (mentioned()), so the model
// cannot approve what the owner did not ask for. The covers, images and captions go to the owner from Teder's answer,
// by code, beside the model's words.

const MAX_ROUNDS = 5;
const HISTORY = 12;
const PENDING_MINUTES = 30;
const YES = /^\s*(כן|כן בבקשה|כן,? תשלח|yes|y|ok|אוקיי|אישור|מאשר|מאשרת|מאושר|שלח|תשלח|לשלוח|סבבה|יאללה)\s*[.!]*\s*$/i;
const NO = /^\s*(לא|לא תודה|no|n|ביטול|בטל|תבטל|עזוב|אל תשלח)\s*[.!]*\s*$/i;

export const ASSISTANT_TOOLS: ToolDef[] = [
  {
    name: 'store_overview',
    description: "The store's customer conversations over a period: how many, on which channel, how many customer messages, how many Toran answered on its own and how many it handed to the owner, and how many questions wait for the owner now.",
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: '1 for today (the last 24 hours), 7 for the week, 30 for the month' } }, required: ['days'] },
  },
  {
    name: 'waiting_questions',
    description: 'The customer questions Toran handed to the owner that the owner has not answered yet, newest first, each with its conversation id.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_conversation',
    description: "One conversation's last messages (customer, Toran, the owner), and whether Toran is paused in it.",
    input_schema: { type: 'object', properties: { conversation_id: { type: 'integer' } }, required: ['conversation_id'] },
  },
  {
    name: 'asked_about',
    description: 'What customers asked about over a period: the products Toran looked up most (with stock) and the words customers searched for.',
    input_schema: { type: 'object', properties: { days: { type: 'integer' } }, required: ['days'] },
  },
  {
    name: 'out_of_stock',
    description: "The products shown out of stock on the store's site, as Toran last read it.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_products',
    description: "Search the store's catalogue: products with their price and stock, from the site.",
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'propose_action',
    description: 'Offer to do one thing, which happens only when the owner replies "כן": answer_customer sends the owner\'s words to the customer in that conversation (and Toran steps back there for a while); pause stops Toran answering in that conversation; resume lets Toran answer there again. A new offer replaces the one waiting.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['answer_customer', 'pause', 'resume'] },
        conversation_id: { type: 'integer' },
        text: { type: 'string', description: 'answer_customer only: the message to the customer, in the owner\'s words, nothing added' },
        remember: { type: 'boolean', description: 'answer_customer only: also keep it as the answer to this question, so Toran answers it himself next time' },
      },
      required: ['kind', 'conversation_id'],
    },
  },
];

export const TEDER_TOOLS: ToolDef[] = [
  {
    name: 'teder_status',
    description: "Teder's numbers now: the posts waiting for the owner's approval, approved and published this week, and the month's quota of suggested posts and redos.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'teder_pending',
    description: "The posts waiting for the owner's approval, now. The app sends the owner their covers with your answer, numbered 1, 2, 3 in this order; from the owner's next message on, those numbers mean this list.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'teder_post',
    description: 'One post from the list the owner saw: each slide line by line, and the caption, as Teder wrote them.',
    input_schema: { type: 'object', properties: { number: { type: 'integer', description: 'its number in the list the owner saw, 1 is the first' } }, required: ['number'] },
  },
  {
    name: 'teder_approve',
    description: 'Approve the posts the owner asked to approve in this message, by their numbers in the list the owner saw. Done at once.',
    input_schema: { type: 'object', properties: { numbers: { type: 'array', items: { type: 'integer' } } }, required: ['numbers'] },
  },
  {
    name: 'teder_reject',
    description: "Send one post back, as the owner asked in this message: Teder writes it again while the month's redos last. reason: topic, shorter, tone, photo or other; note: what the owner said to change, in their words.",
    input_schema: { type: 'object', properties: { number: { type: 'integer' }, reason: { type: 'string', enum: ['topic', 'shorter', 'tone', 'photo', 'other'] }, note: { type: 'string' } }, required: ['number', 'reason'] },
  },
  {
    name: 'teder_edit',
    description: "Change one line of one slide to the owner's exact words from this message. Line 1 is the slide's headline (on the cover, its hook), line 2 the text under it. The last slide cannot be changed.",
    input_schema: { type: 'object', properties: { number: { type: 'integer' }, slide: { type: 'integer' }, line: { type: 'integer' }, text: { type: 'string' } }, required: ['number', 'slide', 'line', 'text'] },
  },
  {
    name: 'teder_bundle',
    description: 'One post ready to upload, sent to the owner by the app with your answer: its images in order, then its caption to copy.',
    input_schema: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] },
  },
];

const TEDER_RULES = `Teder writes this business's social posts (carousels of slides) and waits for the owner's approval. Through the teder_ tools you see the posts waiting, Teder's numbers, a post's slides and caption, and you can approve, send a post back to be written again, change one line of a slide, and send a ready post's images and caption.
- A post is named by its number in the list the owner last saw (1 is the first). Act only on numbers the owner's message names; when it is not clear which post they mean, ask.
- Approve, send back or change a post only when the owner asked for it in this message, then say what was done, from the tool's result.
- Never write post content yourself. Hooks, slide lines and captions come from tool results only, and a new line for a slide is the owner's own words.
- The app sends the covers and images with your answer. You don't see them; don't describe them.`;

function system(store: { name: string; domain: string } | null, teder: boolean): string {
  if (!store) {
    return `You are the assistant of a business owner who uses Teder, OpenFrequency's social posts service. They write to you on WhatsApp.

${TEDER_RULES}

Write in Hebrew, short, like a WhatsApp message to the business's owner: plain sentences, the owner addressed in the plural (אתם), no exclamation marks, no emoji, no headings. A short list is fine.`;
  }
  return `You are Toran's assistant for the owner of the online store ${store.name} (${store.domain}). Toran is the AI that answers this store's customers on WhatsApp, Instagram, Messenger and email. Here the store's owner is talking to you, not a customer.${teder ? `\n\nThe owner also uses Teder. ${TEDER_RULES}` : ''}

What you can see, through your tools only: the store's conversations with customers (how many, on which channel, what was asked), the questions waiting for the owner, any one conversation, what customers asked about most, the products out of stock, and the catalogue.

What you cannot see: the store's orders, sales, revenue, carts, checkouts or customer list. If the owner asks about them, say plainly that you don't see the store's orders and carts yet. Never estimate or invent them.

Rules:
- Call a tool before saying anything about the store. Every number, product name and quote you write comes from a tool result in this chat.
- You never do anything yourself. To answer a customer, or to pause or resume Toran in a conversation, call propose_action. Then tell the owner in one short line what will happen, and that it happens when they reply "כן". Never say it was done.
- An answer to a customer is the owner's words. Write it only from what the owner told you to say; add no facts, prices or promises. If the owner hasn't said what to answer, ask them.
- Customers are named the way the tools name them (the channel and the last digits), never by a full number or address.
- Write in Hebrew, short, like a WhatsApp message to the business's owner: plain sentences, the owner addressed in the plural (אתם), no exclamation marks, no emoji, no headings. A short list is fine.`;
}

const numbers = (s: string) => (String(s).match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(',', '.'));

/** The numbers in a reply that no source holds. */
export function unsourced(reply: string, sources: string[]): string[] {
  const known = new Set(sources.flatMap(numbers));
  return [...new Set(numbers(reply))].filter((n) => !known.has(n));
}

async function storeOf(app: App, storeId: number) {
  const s = await app.db.one<any>('SELECT id, name, domain, url, brand, brand_override, config FROM stores WHERE id = $1', [storeId]);
  if (!s) throw new Error(`no store ${storeId}`);
  return { ...s, name: displayName(s.brand_override?.name, s.brand?.name, s.name) || s.domain };
}

async function pendingAction(app: App, storeId: number) {
  await app.db.query(`UPDATE assistant_actions SET status = 'expired', decided_at = now() WHERE store_id = $1 AND status = 'pending' AND created_at < now() - interval '${PENDING_MINUTES} minutes'`, [storeId]);
  return app.db.one<any>("SELECT * FROM assistant_actions WHERE store_id = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1", [storeId]);
}

/** The customer's latest question in words in a conversation: what an answer the owner keeps is the answer to. */
export async function questionOf(app: App, conversationId: number): Promise<string | null> {
  const q = await app.db.one<{ text: string }>(
    "SELECT text FROM messages WHERE conversation_id = $1 AND role = 'customer' AND text <> '' ORDER BY id DESC LIMIT 1",
    [conversationId],
  );
  return q?.text || null;
}

/** A proposal from the model: checked, kept as the one pending, and described back to it. */
async function propose(app: App, storeId: number, input: any): Promise<{ ok: boolean; content: string }> {
  const kind = String(input?.kind || '');
  const id = Number(input?.conversation_id);
  const c = await app.db.one<{ id: number; channel: string; peer: string | null }>('SELECT id, channel, peer FROM conversations WHERE id = $1 AND store_id = $2', [id, storeId]);
  if (!c) return { ok: false, content: `There is no conversation ${input?.conversation_id} in this store.` };
  const customer = who(c.channel, c.peer);
  let summary: string;
  const params: Record<string, unknown> = { conversation_id: c.id };
  if (kind === 'answer_customer') {
    const text = String(input?.text || '').trim();
    if (!text) return { ok: false, content: 'answer_customer needs the text to send, in the owner\'s words. Ask the owner what to answer.' };
    if (text.length > 1500) return { ok: false, content: 'That answer is too long for one message. Shorten it.' };
    const state = await replyState(app, c.id);
    if (!state.canReply) return { ok: false, content: `A message can't be sent in this conversation now (${state.reason}). Tell the owner they can answer the customer directly.` };
    params.text = text;
    params.remember = Boolean(input?.remember);
    summary = `לשלוח ל${customer}: "${text}"${params.remember ? ', ולשמור את זה כתשובה לשאלה הזאת' : ''}`;
  } else if (kind === 'pause') {
    summary = `לעצור את תורן בשיחה עם ${customer}, ל-${PAUSE_HOURS} שעות`;
  } else if (kind === 'resume') {
    summary = `להחזיר את תורן לענות בשיחה עם ${customer}`;
  } else {
    return { ok: false, content: `Unknown action "${kind}".` };
  }
  await app.db.tx(async (t) => {
    await t.query("UPDATE assistant_actions SET status = 'cancelled', decided_at = now(), decided_by = 'replaced' WHERE store_id = $1 AND status = 'pending'", [storeId]);
    await t.query('INSERT INTO assistant_actions (store_id, kind, params, summary) VALUES ($1, $2, $3::jsonb, $4)', [storeId, kind, J(params), summary]);
  });
  return { ok: true, content: `Waiting for the owner's "כן": ${summary}. Nothing happens until they reply "כן". Tell them in one line what will happen.` };
}

/** What the owner approved, done. Returns the line the owner reads. */
async function execute(app: App, action: any, author: string): Promise<string> {
  const id = Number(action.params?.conversation_id);
  let line: string;
  let status = 'done';
  if (action.kind === 'answer_customer') {
    const d = await ownerReply(app, id, String(action.params.text), author);
    if (!d.ok) {
      status = 'failed';
      line = 'לא הצלחתי לשלוח את ההודעה ללקוח. אפשר לענות לו ישירות מתיבת השיחות.';
    } else {
      line = `נשלח. תורן לא יענה בשיחה הזאת ב-${PAUSE_HOURS} השעות הקרובות, כדי שתוכלו להמשיך בה.`;
      if (action.params.remember) {
        const question = await questionOf(app, id);
        if (question) {
          await app.db.query('INSERT INTO faqs (store_id, question, answer, conversation_id) VALUES ($1, $2, $3, $4)', [action.store_id, question.slice(0, 300), String(action.params.text).slice(0, 2000), id]);
          line += ' שמרתי את התשובה, ובפעם הבאה ששואלים את זה תורן יענה בעצמו.';
        }
      }
    }
  } else if (action.kind === 'pause') {
    await app.db.query(`UPDATE conversations SET agent_paused_until = now() + interval '${PAUSE_HOURS} hours' WHERE id = $1 AND store_id = $2`, [id, action.store_id]);
    await audit(app.db, { actor: author, action: 'pause_agent', storeId: action.store_id, detail: { conversationId: id, via: 'assistant' } });
    line = `תורן לא יענה בשיחה הזאת ב-${PAUSE_HOURS} השעות הקרובות.`;
  } else {
    await resumeAgent(app, id, author);
    line = 'תורן חוזר לענות בשיחה הזאת מההודעה הבאה של הלקוח.';
  }
  await app.db.query('UPDATE assistant_actions SET status = $2, result = $3, decided_at = now(), decided_by = $4 WHERE id = $1', [action.id, status, line, author]);
  await event(app.db, action.store_id, 'assistant_action', { id: action.id, kind: action.kind, status });
  return line;
}

export type TederTurn = { ctx: PostsCtx; list: { items: ListItem[]; source: string; at: string } | null; text: string; parts: Part[] };

const TEDER_DOWN = 'Teder did not answer. Tell the owner to try again in a few minutes.';

/** A teder_ tool: what it did, for the model. The covers and images it sends go in turn.parts. */
async function runTederTool(t: TederTurn, name: string, input: any): Promise<{ ok: boolean; content: string }> {
  // The list the owner saw before this message: a list shown in this same turn is not what their numbers meant.
  const items = t.list?.items || [];
  const named = mentioned(t.text, items.length);
  const pick = (n: unknown): ListItem | string => {
    const k = Number(n);
    if (!items.length) return 'The owner has not been shown a list of posts yet. Call teder_pending to show them the posts waiting.';
    if (!Number.isInteger(k) || k < 1 || k > items.length) return `There is no post ${n} in the list the owner saw (it has ${items.length}).`;
    return items[k - 1];
  };
  if (name === 'teder_status') {
    const r = await status(t.ctx);
    return { ok: !r.lines[0]?.startsWith('לא הצלחתי'), content: r.lines.join('\n') };
  }
  if (name === 'teder_pending') {
    const r = await showPending(t.ctx);
    if (!r.posts) return { ok: false, content: TEDER_DOWN };
    t.parts.push(...r.parts);
    return { ok: true, content: r.posts.length ? `Sent to the owner with your answer, numbered: ${r.posts.map((p, i) => `${i + 1}. ${p.coverLine}`).join(' | ')}. The app already wrote the line above the covers and how to answer, so say nothing more about the list unless they asked something else.` : 'No posts are waiting for approval.' };
  }
  if (name === 'teder_post') {
    const it = pick(input?.number);
    if (typeof it === 'string') return { ok: false, content: it };
    // Teder lists a post's slides with the posts waiting; one approved since is no longer among them.
    const r = await t.ctx.teder.pending();
    if (!r.ok) return { ok: false, content: TEDER_DOWN };
    const p = (r.body.posts || []).find((x) => String(x.id) === String(it.id));
    if (!p) return { ok: false, content: 'That post is no longer waiting for approval, so its slides are not listed here.' };
    return { ok: true, content: [`Post ${input.number}: "${p.coverLine}" (${p.status}).`, ...(p.slides || []).map((s) => `- slide ${s.n} (${s.kind}): [line 1] ${s.title} [line 2] ${s.body}`), p.caption ? `Caption: ${p.caption}` : ''].filter(Boolean).join('\n') };
  }
  if (name === 'teder_bundle') {
    const it = pick(input?.number);
    if (typeof it === 'string') return { ok: false, content: it };
    const b = await sendBundle(t.ctx, Number(input.number), it);
    t.parts.push(...b.parts);
    return b.parts.length ? { ok: true, content: 'The images and the caption are sent to the owner with your answer. Say nothing more about them.' } : { ok: false, content: b.lines.join(' ') };
  }
  // The actions: only on numbers the owner's message names (on a list of one, "it" is that one).
  const mayAct = (k: number) => named.has(k);
  const intents: Intent[] = [];
  if (name === 'teder_approve') {
    const ns = [...new Set((Array.isArray(input?.numbers) ? input.numbers : [input?.numbers]).map(Number))] as number[];
    for (const n of ns) {
      const it = pick(n);
      if (typeof it === 'string') return { ok: false, content: it };
      if (!mayAct(n)) return { ok: false, content: `The owner's message does not name post ${n}. Ask them which posts they mean; nothing was approved.` };
      intents.push({ kind: 'approve', n });
    }
  } else if (name === 'teder_reject' || name === 'teder_edit') {
    const n = Number(input?.number);
    const it = pick(n);
    if (typeof it === 'string') return { ok: false, content: it };
    if (!mayAct(n)) return { ok: false, content: `The owner's message does not name post ${n}. Ask them which post they mean; nothing was changed.` };
    if (name === 'teder_reject') {
      const reason = (['topic', 'shorter', 'tone', 'photo', 'other'].includes(input?.reason) ? input.reason : 'other') as Reason;
      intents.push({ kind: 'reject', n, reason, note: String(input?.note || '').trim().slice(0, 300) });
    } else {
      const text = String(input?.text || '').trim();
      if (!text || !normalize(t.text).includes(normalize(text))) return { ok: false, content: "The new line must be the owner's exact words from their message. Ask them what the line should say; nothing was changed." };
      intents.push({ kind: 'edit', n, slide: Number(input?.slide), line: Number(input?.line), text });
    }
  } else {
    return { ok: false, content: `No tool "${name}".` };
  }
  const done = await act(t.ctx, items, intents);
  t.parts.push(...done.parts);
  return { ok: true, content: `Done. Teder's answer, as the owner should hear it: ${done.lines.join(' ')}` };
}

async function runAssistantTool(app: App, store: any, name: string, input: any, teder: TederTurn | null): Promise<{ ok: boolean; content: string }> {
  const db = app.db;
  if (name.startsWith('teder_')) return teder ? runTederTool(teder, name, input) : { ok: false, content: `No tool "${name}".` };
  if (!store) return { ok: false, content: `No tool "${name}".` };
  switch (name) {
    case 'store_overview':
      return { ok: true, content: await overview(db, store.id, Number(input?.days) || 1) };
    case 'waiting_questions':
      return { ok: true, content: (await waiting(db, store.id)) as string };
    case 'get_conversation': {
      const c = await conversation(db, store.id, Number(input?.conversation_id));
      return c ? { ok: true, content: c } : { ok: false, content: `There is no conversation ${input?.conversation_id} in this store.` };
    }
    case 'asked_about':
      return { ok: true, content: await asked(db, store.id, Number(input?.days) || 7) };
    case 'out_of_stock':
      return { ok: true, content: await outOfStock(db, store.id) };
    case 'search_products': {
      const r = await runTool({ db, storeId: store.id, origin: new URL(store.url).origin, currency: store.config?.currency || 'ILS', env: app.env }, 'search_products', { query: String(input?.query || '') });
      return { ok: r.ok, content: r.content };
    }
    case 'propose_action':
      return propose(app, store.id, input);
    default:
      return { ok: false, content: `No tool "${name}".` };
  }
}

export type AssistantInput = {
  storeId: number | null; // the store whose owner this is; null for an owner with Teder only
  text: string;
  via: 'dashboard' | 'whatsapp';
  author: string;
  phone?: string | null; // on the owner line: their number
  workspaceId?: number | null;
  teder?: PostsCtx | null; // their workspace has Teder
};
export type AssistantReply = { text: string; parts: Part[] };

/** One line of the owner's chat with the assistant, kept. */
export async function keep(app: App, input: Pick<AssistantInput, 'storeId' | 'via' | 'phone' | 'workspaceId'>, role: 'owner' | 'assistant', text: string, author: string, tools: unknown[] = []) {
  await app.db.query('INSERT INTO assistant_messages (store_id, role, text, via, author, tools, workspace_id, phone) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)', [input.storeId, role, text, input.via, author, J(tools), input.workspaceId ?? null, input.phone ?? null]);
}

/** The owner's message in, the assistant's answer out (both kept). */
export async function ask(app: App, input: AssistantInput): Promise<string> {
  return (await askOwner(app, input)).text;
}

/** The same, with the covers and images the teder_ tools send (the owner line). */
export async function askOwner(app: App, input: AssistantInput): Promise<AssistantReply> {
  const { db } = app;
  const text = String(input.text || '').trim().slice(0, 2000);
  if (!text) return { text: '', parts: [] };
  const store = input.storeId ? await storeOf(app, input.storeId) : null;
  if (!store && !input.teder) throw new Error('the assistant needs a store or Teder');
  const past = store
    ? await db.query<{ role: string; text: string }>('SELECT role, text FROM assistant_messages WHERE store_id = $1 ORDER BY id DESC LIMIT $2', [store.id, HISTORY])
    : await db.query<{ role: string; text: string }>('SELECT role, text FROM assistant_messages WHERE phone = $1 AND store_id IS NULL ORDER BY id DESC LIMIT $2', [input.phone, HISTORY]);
  await keep(app, input, 'owner', text, input.author);
  const teder: TederTurn | null = input.teder ? { ctx: input.teder, list: await lastList(app, input.teder.phone, input.teder.workspaceId), text, parts: [] } : null;

  const answer = async (reply: string, tools: unknown[] = []) => {
    await keep(app, input, 'assistant', reply, 'toran', tools);
    return { text: reply, parts: teder?.parts || [] };
  };

  // "כן" and "לא" to the one thing waiting: the code does it or drops it; the model is not asked.
  const pending = store ? await pendingAction(app, store.id) : null;
  if (pending && YES.test(text)) return answer(await execute(app, pending, input.author));
  if (pending && NO.test(text)) {
    await db.query("UPDATE assistant_actions SET status = 'cancelled', decided_at = now(), decided_by = $2 WHERE id = $1", [pending.id, input.author]);
    return answer('בסדר, ביטלתי. לא נשלח ולא השתנה כלום.');
  }
  if (store && !pending && (YES.test(text) || NO.test(text)) && past.length === 0) return answer('אין כרגע משהו שמחכה לאישור שלכם. אפשר לשאול אותי מה קורה בחנות, אילו שאלות מחכות לכם, או על מה לקוחות שואלים.');

  const day = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const context = `SERVER CONTEXT (written by the app, not by the owner): ${day}, Israel time.${pending ? ` Waiting for the owner's "כן": ${pending.summary}.` : ''}${teder ? (teder.list?.items.length ? ` The Teder posts the owner last saw, by number: ${teder.list.items.map((p, i) => `${i + 1}. ${p.hook}`).join(' | ')}.` : ' The owner has not been shown a list of Teder posts yet.') : ''}`;
  const messages: Msg[] = [];
  for (const m of past.reverse()) {
    const role = m.role === 'owner' ? 'user' : 'assistant';
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${m.text}`;
    else messages.push({ role, content: m.text });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  const now = `${context}\n\n${text}`;
  const prev = messages[messages.length - 1];
  if (prev && prev.role === 'user') prev.content = `${prev.content}\n\n${now}`;
  else messages.push({ role: 'user', content: now });

  const sys = [{ text: system(store, Boolean(teder)), cache: '5m' as const }];
  const toolset = [...(store ? ASSISTANT_TOOLS : []), ...(teder ? TEDER_TOOLS : [])];
  const tools: { name: string; input: unknown; ok: boolean; result: string }[] = [];
  const sources = [text, ...past.map((m) => m.text)];
  let reply = '';
  let retried = false;
  for (let round = 0; round < MAX_ROUNDS + 1; round++) {
    const res = await app.llm.turn({ system: sys, messages, tools: toolset, model: agentModel(app.env), maxTokens: 1200, effort: 'low', tag: store ? `assistant store ${store.id}` : `assistant workspace ${input.workspaceId}` });
    await recordUsage(db, { storeId: store?.id ?? null, conversationId: null, kind: 'llm', backend: res.backend, model: res.model, inTokens: res.usage.input_tokens, cacheRead: res.usage.cache_read_input_tokens, cacheWrite: res.usage.cache_creation_input_tokens, outTokens: res.usage.output_tokens, usd: res.usd, apiUsd: res.apiUsd, tag: 'assistant' });
    const calls = res.content.filter(isToolUse) as ToolUseBlock[];
    if (!calls.length) {
      reply = res.content.filter(isText).map((b) => b.text).join('\n').trim();
      const bad = unsourced(reply, [...sources, ...tools.map((t) => t.result)]);
      if (bad.length && !retried) {
        retried = true;
        messages.push({ role: 'assistant', content: res.content });
        messages.push({ role: 'user', content: `SERVER CONTEXT: your answer has numbers that no tool result holds (${bad.join(', ')}). Call the tool that has them, or answer without them.` });
        continue;
      }
      if (bad.length) reply = 'לא מצאתי את זה בנתונים שיש לי על החנות.';
      break;
    }
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const c of calls) {
      const r = await runAssistantTool(app, store, c.name, c.input, teder);
      tools.push({ name: c.name, input: c.input, ok: r.ok, result: r.content.slice(0, 6000) });
      results.push({ type: 'tool_result', tool_use_id: c.id, content: r.content, ...(r.ok ? {} : { is_error: true }) } as Block);
    }
    messages.push({ role: 'user', content: results });
  }
  if (!reply) reply = 'לא הצלחתי לענות על זה כרגע. נסו לשאול שוב, קצת אחרת.';
  return answer(reply, tools);
}
