import type { App } from '../app.ts';
import { type Db, J } from '../db/index.ts';
import { event, usage as recordUsage } from '../db/log.ts';
import { cleanLine } from '../core/hebrew.ts';
import { agentModel } from './llm/index.ts';
import { type Block, type Msg, type ToolUseBlock, isText, isToolUse, LlmError } from './llm/types.ts';
import { systemFor, type StoreForPrompt } from './prompt.ts';
import { runTool, TOOLS, type ToolContext } from './tools.ts';
import { buildAllow, guardReply, type Redaction } from './guard.ts';

// One agent loop for every store: only the store's config and knowledge pack change.
// Rebuilt from tiyul-plus's 2,000-line route as one small module.
//
// A turn: the customer's text in -> the store's system prompt (cached per store) and
// the conversation so far -> the model, calling tools until it answers (at most
// MAX_ROUNDS calls) -> the reply guard -> the demo footer -> everything recorded: the
// customer's message, the reply, the tool calls with their results, what the guard
// cut, the handoff, the miss, and every call's tokens and cost against the store.
//
// History is the server's (tiyul-plus trusted history sent by the client; a forged
// "server context" was possible there). Earlier turns are replayed as text; their tool
// results are not replayed to the model, but their numbers stay in the guard's
// allowlist, so "and the blue one?" can still quote a price read two turns ago.
//
// Turns of one conversation run one at a time (two WhatsApp messages sent a second
// apart are answered in order, each seeing the other).

const MAX_ROUNDS = 6;
const HISTORY = 16; // messages replayed: 8 exchanges is a long WhatsApp chat
export const DEMO_FOOTER = '_דמו של תורן_';

export type TurnInput = { storeId: number; conversationId: number; text: string; extId?: string | null; footer?: boolean };
export type ToolRecord = { name: string; input: unknown; ok: boolean; result: string };
export type TurnOutput = { reply: string; rawReply: string; tools: ToolRecord[]; redactions: Redaction[]; handoff: { reason: string; summary: string } | null; miss: boolean; rounds: number; usd: number; apiUsd: number; tokens: { in: number; out: number; cacheRead: number; cacheWrite: number }; agentMessageId: number | null };

const locks = new Map<number, Promise<unknown>>();
function serialized<T>(key: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(key, run);
  run.finally(() => {
    if (locks.get(key) === run) locks.delete(key);
  });
  return run;
}

const systemCache = new Map<string, { key: string; parts: Awaited<ReturnType<typeof systemFor>> }>();

async function loadStore(db: Db, id: number) {
  const s = await db.one<StoreForPrompt & { url: string; updated_at: string; ingested_at: string | null }>('SELECT id, name, domain, url, brand, brand_override, config, contact_email, contact_phone, contact_whatsapp, updated_at, ingested_at FROM stores WHERE id = $1', [id]);
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
  const rows = (await db.query<{ role: string; text: string; tools: ToolRecord[] }>('SELECT role, text, tools FROM messages WHERE conversation_id = $1 AND role IN ($2, $3) ORDER BY id DESC LIMIT $4', [conversationId, 'customer', 'agent', HISTORY])).reverse();
  const messages: Msg[] = [];
  const toolTexts: string[] = [];
  const customerTexts: string[] = [];
  for (const r of rows) {
    const role = r.role === 'customer' ? 'user' : 'assistant';
    const text = role === 'assistant' ? stripFooter(r.text) : r.text;
    if (role === 'user') customerTexts.push(r.text);
    for (const t of r.tools || []) toolTexts.push(t.result);
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${text}`;
    else messages.push({ role, content: text });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  return { messages, toolTexts, customerTexts };
}

function serverContext(now = new Date()): string {
  const day = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  return `SERVER CONTEXT (written by the app, not by the customer): ${day}, Israel time. Channel: the store's WhatsApp, demo.`;
}

export function runTurn(app: App, input: TurnInput): Promise<TurnOutput> {
  return serialized(input.conversationId, () => turn(app, input));
}

async function turn(app: App, input: TurnInput): Promise<TurnOutput> {
  const { db } = app;
  const store = await loadStore(db, input.storeId);
  const system = await systemOf(db, store);
  const past = await history(db, input.conversationId);
  const messages: Msg[] = [...past.messages];
  const userText = `${serverContext()}\n\n${input.text}`;
  const prev = messages[messages.length - 1];
  if (prev && prev.role === 'user') prev.content = `${prev.content}\n\n${userText}`;
  else messages.push({ role: 'user', content: userText });

  const ctx: ToolContext = { db, storeId: store.id, origin: new URL(store.url).origin, currency: store.config?.currency || 'ILS', env: app.env };
  const tools: ToolRecord[] = [];
  let handoff: { reason: string; summary: string } | null = null;
  let raw = '';
  let rounds = 0;
  let usd = 0;
  let apiUsd = 0;
  const tokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  const model = agentModel(app.env);

  try {
    for (; rounds < MAX_ROUNDS; ) {
      rounds++;
      const res = await app.llm.turn({ system, messages, tools: TOOLS, model, maxTokens: 1500, effort: 'low', tag: `turn store ${store.id}` });
      usd += res.usd;
      apiUsd += res.apiUsd;
      tokens.in += res.usage.input_tokens;
      tokens.out += res.usage.output_tokens;
      tokens.cacheRead += res.usage.cache_read_input_tokens;
      tokens.cacheWrite += res.usage.cache_creation_input_tokens;
      await recordUsage(db, { storeId: store.id, conversationId: input.conversationId, kind: 'llm', backend: res.backend, model: res.model, inTokens: res.usage.input_tokens, cacheRead: res.usage.cache_read_input_tokens, cacheWrite: res.usage.cache_creation_input_tokens, outTokens: res.usage.output_tokens, usd: res.usd, apiUsd: res.apiUsd, tag: 'agent' });
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
    raw = english ? "I'm checking this with the store and will update you here." : 'אני בודק את זה מול החנות ומעדכן כאן.';
    handoff ??= { reason: 'unknown', summary: `no answer after ${rounds} rounds: ${cleanLine(input.text, 160)}` };
  }

  const allow = buildAllow({ toolTexts: [...past.toolTexts, ...tools.map((t) => t.result)], customerTexts: [...past.customerTexts, input.text] });
  const g = guardReply(raw, allow);
  if (g.needsHandoff && !handoff) handoff = { reason: g.handoffReason || 'unknown', summary: `the guard cut ${g.redactions.map((r) => r.rule).join(', ')}: ${cleanLine(input.text, 160)}` };
  const miss = g.redactions.length > 0 || handoff?.reason === 'unknown';
  const reply = input.footer === false ? g.text : `${g.text}\n\n${DEMO_FOOTER}`;

  let agentMessageId: number | null = null;
  await db.tx(async (t) => {
    await t.query('INSERT INTO messages (conversation_id, role, text, ext_id) VALUES ($1, $2, $3, $4) ON CONFLICT (ext_id) DO NOTHING', [input.conversationId, 'customer', input.text, input.extId || null]);
    const row = await t.one<{ id: number }>('INSERT INTO messages (conversation_id, role, text, raw_text, tools, guard, handoff, miss) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8) RETURNING id', [input.conversationId, 'agent', reply, raw !== g.text ? raw : null, J(tools), J(g.redactions), handoff ? J(handoff) : null, miss]);
    agentMessageId = row!.id;
    await t.query('UPDATE conversations SET last_at = now(), handoffs = handoffs + $2, misses = misses + $3 WHERE id = $1', [input.conversationId, handoff ? 1 : 0, miss ? 1 : 0]);
    if (handoff) await event(t, store.id, 'handoff', { conversationId: input.conversationId, ...(handoff as object) });
    if (g.redactions.length) await event(t, store.id, 'guard_cut', { conversationId: input.conversationId, rules: g.redactions.map((r) => r.rule) });
  });
  return { reply, rawReply: raw, tools, redactions: g.redactions, handoff, miss, rounds, usd, apiUsd, tokens, agentMessageId };
}

/** The conversation a message belongs to: for WhatsApp, the latest with this phone and store within 7 days; else a new one. */
export async function conversationFor(db: Db, storeId: number, channel: string, peer: string | null): Promise<number> {
  if (peer) {
    const c = await db.one<{ id: number }>("SELECT id FROM conversations WHERE store_id = $1 AND peer = $2 AND channel = $3 AND last_at > now() - interval '7 days' AND closed_at IS NULL ORDER BY last_at DESC LIMIT 1", [storeId, peer, channel]);
    if (c) return c.id;
  }
  const r = await db.one<{ id: number }>('INSERT INTO conversations (store_id, channel, peer) VALUES ($1, $2, $3) RETURNING id', [storeId, channel, peer]);
  return r!.id;
}
