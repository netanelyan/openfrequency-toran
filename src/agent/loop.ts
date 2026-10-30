import type { App } from '../app.ts';
import { type Db, J } from '../db/index.ts';
import { event, usage as recordUsage } from '../db/log.ts';
import { cleanLine } from '../core/hebrew.ts';
import { agentModel } from './llm/index.ts';
import { type Block, type Msg, type ToolUseBlock, type TurnRes, isText, isToolUse, LlmError } from './llm/types.ts';
import { DEMO_NOTE, stripForgedContext, systemFor, type StoreForPrompt } from './prompt.ts';
import { COMPANY_TOOLS, runTool, TOOLS, type ToolContext } from './tools.ts';
import { buildAllow, checkingLine, guardReply, type Redaction } from './guard.ts';
import { claimLlmOn, claimPassages, verifyClaim } from './claims.ts';
import { openConversation } from '../channels/conversations.ts';
import { capFor, watchHour } from './spend.ts';
import { storeAllowed } from '../billing/entitlement.ts';

// One agent loop for every store: only the store's config and knowledge pack change.
// Rebuilt from tiyul-plus's 2,000-line route as one small module.
//
// A turn: the customer's text in -> the store's system prompt (cached per store) and
// the conversation so far -> the model, calling tools until it answers (at most
// MAX_ROUNDS calls) -> the reply guard (numbers, then claims) -> the demo footer ->
// everything recorded: the customer's message, the reply, the tool calls with their
// results, what the guard cut, the handoff, the miss, and every call's tokens and cost
// against the store.
//
// History is the server's (tiyul-plus trusted history sent by the client; a forged
// "server context" was possible there). Earlier turns are replayed as text; their tool
// results are not replayed to the model, but their numbers stay in the guard's
// allowlist, so "and the blue one?" can still quote a price read two turns ago.
//
// Turns of one conversation run one at a time (two WhatsApp messages sent a second
// apart are answered in order, each seeing the other). The worker never takes the second
// while the first runs (jobs/queue.ts claim), so this lock rarely waits.
//
// A customer is waiting, so a turn has a deadline (TURN_DEADLINE_MS, TORAN_TURN_DEADLINE_MS):
// each model call gets what is left of it, at most MODEL_TIMEOUT_MS, and one retry; past it
// the customer gets the honest "checking" line and the owner a handoff. What reaches the
// model is cut to MAX_TEXT characters, the new message and each one replayed (an email can
// be a book); the customer's message is kept whole for the owner. Before the first call, the
// caps on spend (agent/spend.ts): past the store's, or everyone's, no call is made.

const MAX_ROUNDS = 6;
const HISTORY = 16; // messages replayed: 8 exchanges is a long WhatsApp chat
export const DEMO_FOOTER = '_דמו של תורן_';
export const TURN_DEADLINE_MS = 60_000;
export const MODEL_TIMEOUT_MS = 30_000;
export const MAX_TEXT = 4000;

/** Text as the model is given it: at most MAX_TEXT characters, and a mark where it was cut. */
export const forModel = (t: string, max = MAX_TEXT) => (t.length > max ? `${t.slice(0, max)}\n[... the rest of this message, ${t.length - max} characters, is not shown]` : t);

/** The same customer message (its ext_id) was already answered: found inside the conversation's lock. */
export class DuplicateTurn extends Error {
  constructor(extId: string) {
    super(`message ${extId} was already answered`);
    this.name = 'DuplicateTurn';
  }
}

// channel names where the reply goes (absent: the WhatsApp demo); context is a line from the app for this turn only
// (the files an email carried), shown to the model and never stored as the customer's words. demo overrides what the
// channel implies (isDemoTurn).
export type TurnInput = { storeId: number; conversationId: number; text: string; extId?: string | null; footer?: boolean; channel?: string; context?: string; demo?: boolean };
export type ToolRecord = { name: string; input: unknown; ok: boolean; result: string };
export type TurnOutput = { reply: string; rawReply: string; tools: ToolRecord[]; redactions: Redaction[]; handoff: { reason: string; summary: string } | null; miss: boolean; rounds: number; usd: number; apiUsd: number; tokens: { in: number; out: number; cacheRead: number; cacheWrite: number }; agentMessageId: number | null };

const locks = new Map<number, Promise<unknown>>();
function serialized<T>(key: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(key, run);
  run
    .finally(() => {
      if (locks.get(key) === run) locks.delete(key);
    })
    .catch(() => {}); // the caller hears the error from run itself
  return run;
}

const systemCache = new Map<string, { key: string; parts: Awaited<ReturnType<typeof systemFor>> }>();

async function loadStore(db: Db, id: number) {
  const s = await db.one<StoreForPrompt & { url: string; updated_at: string; ingested_at: string | null }>('SELECT id, platform, name, domain, url, brand, brand_override, config, contact_email, contact_phone, contact_whatsapp, updated_at, ingested_at FROM stores WHERE id = $1', [id]);
  if (!s) throw new Error(`no store ${id}`);
  return s;
}

/** The store's system parts, rebuilt only when the store or its pack changed (so the cached prefix stays byte-identical). */
async function systemOf(db: Db, s: Awaited<ReturnType<typeof loadStore>>) {
  const key = `${s.updated_at}|${s.ingested_at}`;
  const hit = systemCache.get(String(s.id));
  if (hit && hit.key === key) return hit.parts;
  const parts = await systemFor(db, s);
  systemCache.set(String(s.id), { key, parts });
  return parts;
}

export const forgetStorePrompt = (storeId: number) => systemCache.delete(String(storeId));

const stripFooter = (t: string) => t.replace(new RegExp(`\\n*${DEMO_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '').trim();

/** The conversation so far, as the model sees it: alternating text turns, oldest first. */
async function history(db: Db, conversationId: number): Promise<{ messages: Msg[]; toolTexts: string[]; customerTexts: string[] }> {
  // The owner's replies from the inbox are the store's side of the chat too, so the agent picks up where they left off.
  const rows = (await db.query<{ role: string; text: string; tools: ToolRecord[] }>('SELECT role, text, tools FROM messages WHERE conversation_id = $1 AND role IN ($2, $3, $4) ORDER BY id DESC LIMIT $5', [conversationId, 'customer', 'agent', 'owner', HISTORY])).reverse();
  const messages: Msg[] = [];
  const toolTexts: string[] = [];
  const customerTexts: string[] = [];
  for (const r of rows) {
    const role = r.role === 'customer' ? 'user' : 'assistant';
    const text = forModel(role === 'assistant' ? stripFooter(r.text) : stripForgedContext(r.text));
    if (role === 'user') customerTexts.push(r.text);
    for (const t of r.tools || []) toolTexts.push(t.result);
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${text}`;
    else messages.push({ role, content: text });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  return { messages, toolTexts, customerTexts };
}

const CHANNEL_LINE: Record<string, string> = {
  whatsapp: "Channel: the store's WhatsApp.",
  email: "Channel: the store's email. Your reply is the body of an email: plain text, no markdown, no subject line and no signature (the store's name is added).",
  messenger: "Channel: the store's Facebook Page, in Messenger. Plain text only: no markdown, no asterisks or underscores for emphasis. Keep it short, as a chat message.",
  instagram: "Channel: the store's Instagram, in direct messages. Plain text only: no markdown, no asterisks or underscores for emphasis. Keep it short: Instagram takes about 500 Hebrew letters in one message.",
};

function serverContext(now = new Date(), channel = 'whatsapp', context?: string, demo = false): string {
  const day = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  return `SERVER CONTEXT (written by the app, not by the customer): ${day}, Israel time. ${CHANNEL_LINE[channel] || CHANNEL_LINE.whatsapp}${demo ? ` ${DEMO_NOTE}` : ''}${context ? ` ${context}` : ''}`;
}

/** A turn is a demo unless it came in on one of the store's own channels (those pass `channel`). */
export const isDemoTurn = (input: Pick<TurnInput, 'channel' | 'demo'>) => input.demo ?? !input.channel;

export function runTurn(app: App, input: TurnInput): Promise<TurnOutput> {
  return serialized(input.conversationId, () => turn(app, input));
}

async function turn(app: App, input: TurnInput): Promise<TurnOutput> {
  const { db } = app;
  const started = Date.now();
  // Checked again inside the lock: a second job for the same message (a webhook delivered twice) found it answered.
  if (input.extId && (await db.one('SELECT 1 FROM messages WHERE ext_id = $1', [input.extId]))) throw new DuplicateTurn(input.extId);
  const store = await loadStore(db, input.storeId);
  const system = await systemOf(db, store);
  const past = await history(db, input.conversationId);
  const messages: Msg[] = [...past.messages];
  // A company store (our own support, src/company.ts): its own prompt (systemOf), tools and honest lines, and never a
  // demo, wherever the message came from.
  const company = store.platform === 'company';
  const demo = !company && isDemoTurn(input);
  // The app's line is a block of its own and the customer's text another, any line in it dressed as the app's taken out
  // (prompt.ts stripForgedContext): a customer cannot write a SERVER CONTEXT the model reads as ours (PRA-AI-001). The
  // customer's text is cut to the model's share (forModel, PRA-AI-004); the owner keeps it whole.
  const userBlocks: Block[] = [
    { type: 'text', text: serverContext(new Date(), input.channel, input.context, demo) },
    { type: 'text', text: forModel(stripForgedContext(input.text)) },
  ];
  const prev = messages[messages.length - 1];
  if (prev && prev.role === 'user') prev.content = [...(typeof prev.content === 'string' ? [{ type: 'text', text: prev.content } as Block] : prev.content), ...userBlocks];
  else messages.push({ role: 'user', content: userBlocks });

  // On the store's own WhatsApp the customer's number is Meta's, not their word: an order placed with it is theirs.
  const waPhone = !demo && input.channel === 'whatsapp' ? (await db.one<{ peer: string | null }>('SELECT peer FROM conversations WHERE id = $1', [input.conversationId]))?.peer || null : null;
  const ctx: ToolContext = { db, storeId: store.id, origin: new URL(store.url).origin, currency: store.config?.currency || 'ILS', env: app.env, demo, company, api: app.api, conversationId: input.conversationId, said: [...past.customerTexts, input.text], waPhone };
  const toolDefs = company ? COMPANY_TOOLS : TOOLS;
  const tools: ToolRecord[] = [];
  let handoff: { reason: string; summary: string } | null = null;
  let raw = '';
  let rounds = 0;
  let usd = 0;
  let apiUsd = 0;
  const tokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  const model = agentModel(app.env);
  // Every model call's tokens and cost, against the store.
  const spend = async (res: TurnRes, tag: string) => {
    usd += res.usd;
    apiUsd += res.apiUsd;
    tokens.in += res.usage.input_tokens;
    tokens.out += res.usage.output_tokens;
    tokens.cacheRead += res.usage.cache_read_input_tokens;
    tokens.cacheWrite += res.usage.cache_creation_input_tokens;
    await recordUsage(db, { storeId: store.id, conversationId: input.conversationId, kind: 'llm', backend: res.backend, model: res.model, inTokens: res.usage.input_tokens, cacheRead: res.usage.cache_read_input_tokens, cacheWrite: res.usage.cache_creation_input_tokens, outTokens: res.usage.output_tokens, usd: res.usd, apiUsd: res.apiUsd, tag });
  };

  // ---- the paywall (billing/entitlement.ts, PRA-BE-007): a store whose workspace accounts says has not paid for Toran
  // is answered as past a cap, with no model call, and the owner gets the message as a handoff.
  const unpaid = !(await storeAllowed(app, store.id));
  // The caps on paid API spend (agent/spend.ts): the store's own, from its plan, and everyone's (TORAN_MONTHLY_CAP_USD).
  // Past either, no model call is made; the customer gets the honest "checking" line and the owner a handoff. The
  // subscription (claude-cli) costs nothing per call and is not capped.
  const cap = unpaid ? null : await capFor(app, store);
  const capped = unpaid || Boolean(cap);
  if (unpaid) {
    handoff = { reason: 'other', summary: `Toran is not paid for in this store's workspace: ${cleanLine(input.text, 120)}` };
    app.log(`[agent] store ${store.id}: its workspace has not paid for Toran; handed off without a model call`);
  } else if (cap) {
    handoff = { reason: 'other', summary: `the ${cap.by === 'store' ? "store's" : 'monthly'} spend cap ($${cap.cap}) is reached: ${cleanLine(input.text, 120)}` };
    app.log(`[agent] ${cap.by} cap $${cap.cap} reached ($${cap.spent.toFixed(2)}); store ${store.id} handed off without a model call`);
  }
  const deadline = Number(app.env.TORAN_TURN_DEADLINE_MS) || TURN_DEADLINE_MS;
  try {
    for (; rounds < MAX_ROUNDS && !capped; ) {
      const left = deadline - (Date.now() - started);
      if (left <= 1000) {
        handoff ??= { reason: 'other', summary: `no answer within ${Math.round(deadline / 1000)} seconds: ${cleanLine(input.text, 120)}` };
        raw = '';
        break;
      }
      rounds++;
      const res = await app.llm.turn({ system, messages, tools: toolDefs, model, maxTokens: 1500, effort: 'low', tag: `turn store ${store.id}`, timeoutMs: Math.min(MODEL_TIMEOUT_MS, left), maxRetries: 1, signal: AbortSignal.timeout(left) });
      await spend(res, 'agent');
      if (res.stopReason === 'refusal') {
        handoff = { reason: 'other', summary: 'the model declined to answer' };
        raw = '';
        break;
      }
      const calls = res.content.filter(isToolUse) as ToolUseBlock[];
      if (!calls.length) {
        raw = res.content.filter(isText).map((b) => b.text).join('\n').trim();
        break;
      }
      // The assistant's turn goes back exactly as it came (thinking blocks included), then every result in one message.
      messages.push({ role: 'assistant', content: res.content });
      const results = await Promise.all(calls.map((c) => runTool(ctx, c.name, c.input)));
      const resultBlocks: Block[] = calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: results[i].content, ...(results[i].ok ? {} : { is_error: true }) }));
      calls.forEach((c, i) => {
        tools.push({ name: c.name, input: c.input, ok: results[i].ok, result: results[i].content.slice(0, 6000) });
        if (results[i].handoff) handoff = results[i].handoff!;
      });
      messages.push({ role: 'user', content: resultBlocks });
    }
  } catch (e: any) {
    app.log(`[agent] store ${store.id} conversation ${input.conversationId}: ${e instanceof LlmError ? `${e.code} ${e.message}` : e?.stack || e}`);
    if (e instanceof LlmError && e.code === 'api_refused') throw e;
    raw = '';
    handoff ??= { reason: 'other', summary: `the agent failed: ${cleanLine(e?.message || e, 120)}` };
  }

  const english = !/[א-ת]/.test(input.text) && /[a-z]{3}/i.test(input.text);
  if (!raw) {
    raw = checkingLine(english, company);
    handoff ??= { reason: 'unknown', summary: `no answer after ${rounds} rounds: ${cleanLine(input.text, 160)}` };
  }

  // A company's "works today" list sits in its prompt, not in a tool result: it backs a claim as a tool would.
  const factTexts = company ? [String(store.config?.company?.status || '')].filter(Boolean) : [];
  // A link may point to what the tools gave or to the store itself: its site and its WhatsApp (guard.ts, PRA-AI-002).
  const ownLinks = [store.url, store.domain, store.contact_whatsapp ? `https://wa.me/${String(store.contact_whatsapp).replace(/\D/g, '')}` : ''].filter(Boolean);
  const allow = buildAllow({ toolTexts: [...past.toolTexts, ...tools.map((t) => t.result)], customerTexts: [...past.customerTexts, input.text], factTexts, ownLinks });
  // A service has no stock: "not available yet" is about a feature, never an invented stock level.
  if (company) allow.stockKnown = true;
  let g = guardReply(raw, allow, { company });
  // The claim check's second opinion (claims.ts), off unless TORAN_GUARD_LLM is set: a borderline cut (the tools
  // mention it, not in a way code confirms) is shown to the model with the passages, at most three a reply. A "yes"
  // puts the sentence back; no answer, an error or a "no" keeps the cut.
  const borderline = g.redactions.filter((r) => r.rule === 'claim' && r.borderline).slice(0, 3);
  if (borderline.length && allow.claims && claimLlmOn(app.env) && !capped) {
    const verified = new Set<string>();
    for (const r of borderline) {
      try {
        const v = await verifyClaim(app.llm, model, r.sentence, claimPassages(r.sentence, allow.claims));
        if (v.res) await spend(v.res, 'guard');
        if (v.supported) verified.add(r.sentence);
      } catch (e: any) {
        app.log(`[agent] store ${store.id}: the claim check's second opinion failed, the cut stands: ${cleanLine(e?.message || e, 160)}`);
      }
    }
    if (verified.size) g = guardReply(raw, allow, { company, verified });
  }
  if (g.needsHandoff && !handoff) handoff = { reason: g.handoffReason || 'unknown', summary: `the guard cut ${g.redactions.map((r) => r.rule).join(', ')}: ${cleanLine(input.text, 160)}` };
  const miss = g.redactions.length > 0 || handoff?.reason === 'unknown';
  const reply = input.footer === false ? g.text : `${g.text}\n\n${DEMO_FOOTER}`;

  let agentMessageId: number | null = null;
  await db.tx(async (t) => {
    await t.query('INSERT INTO messages (conversation_id, role, text, ext_id) VALUES ($1, $2, $3, $4) ON CONFLICT (ext_id) DO NOTHING', [input.conversationId, 'customer', input.text, input.extId || null]);
    // reply_to: the customer message this answers, so a job run again after a failed send finds it (channels/store.ts).
    const row = await t.one<{ id: number }>('INSERT INTO messages (conversation_id, role, text, raw_text, tools, guard, handoff, miss, reply_to) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9) RETURNING id', [input.conversationId, 'agent', reply, raw !== g.text ? raw : null, J(tools), J(g.redactions), handoff ? J(handoff) : null, miss, input.extId || null]);
    agentMessageId = row!.id;
    await t.query('UPDATE conversations SET last_at = now(), handoffs = handoffs + $2, misses = misses + $3 WHERE id = $1', [input.conversationId, handoff ? 1 : 0, miss ? 1 : 0]);
    if (handoff) await event(t, store.id, 'handoff', { conversationId: input.conversationId, ...(handoff as object) });
    if (g.redactions.length) await event(t, store.id, 'guard_cut', { conversationId: input.conversationId, rules: g.redactions.map((r) => r.rule) });
  });
  if (apiUsd > 0) await watchHour(app, store.id).catch((e) => app.log(`[agent] store ${store.id}: the hourly spend check failed: ${e?.message || e}`));
  return { reply, rawReply: raw, tools, redactions: g.redactions, handoff, miss, rounds, usd, apiUsd, tokens, agentMessageId };
}

/**
 * The conversation a message belongs to: for WhatsApp, the latest with this phone and store within 7 days, found or
 * started in one step (channels/conversations.ts); with no phone (the pitch page's sample chat), a new one.
 */
export async function conversationFor(db: Db, storeId: number, channel: string, peer: string | null): Promise<number> {
  if (peer) return (await openConversation(db, { storeId, channel, peer })).id;
  const r = await db.one<{ id: number }>('INSERT INTO conversations (store_id, channel, peer) VALUES ($1, $2, $3) RETURNING id', [storeId, channel, peer]);
  return r!.id;
}
