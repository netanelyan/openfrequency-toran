import type { App } from '../app.ts';
import { J } from '../db/index.ts';
import { audit, event, usage as recordUsage } from '../db/log.ts';
import { agentModel } from '../agent/llm/index.ts';
import { type Block, type Msg, type ToolDef, type ToolUseBlock, isText, isToolUse } from '../agent/llm/types.ts';
import { runTool } from '../agent/tools.ts';
import { displayName } from '../ingest/brand.ts';
import { ownerReply, PAUSE_HOURS, replyState, resumeAgent } from '../channels/owner.ts';
import { asked, conversation, outOfStock, overview, waiting, who } from './data.ts';

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

function system(store: { name: string; domain: string }): string {
  return `You are Toran's assistant for the owner of the online store ${store.name} (${store.domain}). Toran is the AI that answers this store's customers on WhatsApp, Instagram, Messenger and email. Here the store's owner is talking to you, not a customer.

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
async function questionOf(app: App, conversationId: number): Promise<string | null> {
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
          await app.db.query('INSERT INTO faqs (store_id, question, answer) VALUES ($1, $2, $3)', [action.store_id, question.slice(0, 300), String(action.params.text).slice(0, 2000)]);
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

async function runAssistantTool(app: App, store: any, name: string, input: any): Promise<{ ok: boolean; content: string }> {
  const db = app.db;
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

export type AssistantInput = { storeId: number; text: string; via: 'dashboard' | 'whatsapp'; author: string };

/** The owner's message in, the assistant's answer out (both kept). */
export async function ask(app: App, input: AssistantInput): Promise<string> {
  const { db } = app;
  const text = String(input.text || '').trim().slice(0, 2000);
  if (!text) return '';
  const store = await storeOf(app, input.storeId);
  const past = await db.query<{ role: string; text: string }>('SELECT role, text FROM assistant_messages WHERE store_id = $1 ORDER BY id DESC LIMIT $2', [store.id, HISTORY]);
  await db.query('INSERT INTO assistant_messages (store_id, role, text, via, author) VALUES ($1, $2, $3, $4, $5)', [store.id, 'owner', text, input.via, input.author]);

  const answer = async (reply: string, tools: unknown[] = []) => {
    await db.query('INSERT INTO assistant_messages (store_id, role, text, via, author, tools) VALUES ($1, $2, $3, $4, $5, $6::jsonb)', [store.id, 'assistant', reply, input.via, 'toran', J(tools)]);
    return reply;
  };

  // "כן" and "לא" to the one thing waiting: the code does it or drops it; the model is not asked.
  const pending = await pendingAction(app, store.id);
  if (pending && YES.test(text)) return answer(await execute(app, pending, input.author));
  if (pending && NO.test(text)) {
    await db.query("UPDATE assistant_actions SET status = 'cancelled', decided_at = now(), decided_by = $2 WHERE id = $1", [pending.id, input.author]);
    return answer('בסדר, ביטלתי. לא נשלח ולא השתנה כלום.');
  }
  if (!pending && (YES.test(text) || NO.test(text)) && past.length === 0) return answer('אין כרגע משהו שמחכה לאישור שלכם. אפשר לשאול אותי מה קורה בחנות, אילו שאלות מחכות לכם, או על מה לקוחות שואלים.');

  const day = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const context = `SERVER CONTEXT (written by the app, not by the owner): ${day}, Israel time.${pending ? ` Waiting for the owner's "כן": ${pending.summary}.` : ''}`;
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

  const sys = [{ text: system(store), cache: '5m' as const }];
  const tools: { name: string; input: unknown; ok: boolean; result: string }[] = [];
  const sources = [text, ...past.map((m) => m.text)];
  let reply = '';
  let retried = false;
  for (let round = 0; round < MAX_ROUNDS + 1; round++) {
    const res = await app.llm.turn({ system: sys, messages, tools: ASSISTANT_TOOLS, model: agentModel(app.env), maxTokens: 1200, effort: 'low', tag: `assistant store ${store.id}` });
    await recordUsage(db, { storeId: store.id, conversationId: null, kind: 'llm', backend: res.backend, model: res.model, inTokens: res.usage.input_tokens, cacheRead: res.usage.cache_read_input_tokens, cacheWrite: res.usage.cache_creation_input_tokens, outTokens: res.usage.output_tokens, usd: res.usd, apiUsd: res.apiUsd, tag: 'assistant' });
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
      const r = await runAssistantTool(app, store, c.name, c.input);
      tools.push({ name: c.name, input: c.input, ok: r.ok, result: r.content.slice(0, 6000) });
      results.push({ type: 'tool_result', tool_use_id: c.id, content: r.content, ...(r.ok ? {} : { is_error: true }) } as Block);
    }
    messages.push({ role: 'user', content: results });
  }
  if (!reply) reply = 'לא הצלחתי לענות על זה כרגע. נסו לשאול שוב, קצת אחרת.';
  return answer(reply, tools);
}

/** The store whose owner a WhatsApp number is, or null. */
export async function storeOfOwner(app: App, phone: string): Promise<number | null> {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const s = await app.db.one<{ id: number }>('SELECT id FROM stores WHERE $1 = ANY(owner_phones) ORDER BY updated_at DESC LIMIT 1', [digits]);
  return s?.id ?? null;
}
