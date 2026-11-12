// node scripts/eval-models.ts [--configs claude-sonnet-5-5:medium,claude-sonnet-5-5:high] [--only q1,q5] [--concurrency 2] [--out file.json]
//
// Which model and effort answer a store's customers best for what they cost (the owner, 2026-11-11: "make sure toran
// and teder ai are smart ... even if toran costs 1.5x themselves"). The same twelve shoppers' conversations, on the
// fictional store (kli-cheres.example, its real pipeline: ingest, the agent's loop, its tools, the guard), once per
// configuration, on the Claude Code subscription: nothing is paid, and each call is recorded at API prices as
// production would pay it (agent/llm/cli.ts). The answers are judged by a person; this script measures.
//
// What it records for each answer: the reply, the tools called, the handoff, what the guard cut, the model calls, the
// cost as recorded (api_usd: the CLI writes every prompt to the 1-hour cache) and as the API path would bill the same
// tokens (its conversation tail is written to the 5-minute cache, llm/api.ts), the model's own time (the CLI's
// duration_api_ms; starting the CLI itself takes seconds a call on this machine, which production never pays) and the
// thinking tokens. One warm-up turn per configuration comes first and is not counted, so every counted answer reads
// the store's prompt from the cache as a busy store's do.
//
// docs/models.md has what it found on 2026-11-11 and the choice made from it.

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp } from '../src/app.ts';
import { evalDir } from '../src/core/paths.ts';
import { openDb } from '../src/db/index.ts';
import { exampleFetcher } from '../src/demo.ts';
import { seedDemo } from '../src/demoSeed.ts';
import { simProvider } from '../src/channels/whatsapp.ts';
import { cliClient, spawnRun, type RunFn } from '../src/agent/llm/cli.ts';
import { rateOf } from '../src/agent/llm/cost.ts';
import { agentEffort } from '../src/agent/llm/index.ts';
import { conversationFor, runTurn, type TurnOutput } from '../src/agent/loop.ts';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const CONFIGS = opt('configs', 'claude-sonnet-5-5:medium,claude-sonnet-5-5:high,claude-sonnet-5-5:xhigh,claude-opus-5-5:low')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean)
  .map((c) => ({ model: c.split(':')[0], effort: c.split(':')[1] || 'medium' }));
const ONLY = new Set(opt('only', '').split(',').map((s) => s.trim()).filter(Boolean));
const CONC = Math.max(1, Number(opt('concurrency', '2')) || 2);

/** A shopper's conversation: one message, or a few in a row (the second answers what the bot asked). */
type Case = { id: string; kind: string; says: string[]; wants: string };
const CASES: Case[] = [
  { id: 'q1', kind: 'product fit', says: ['מחפשת מתנה לחברה שמכורה לקפה, משהו עד 100 ₪. מה יש?'], wants: 'the mugs under 100 ₪ that are in stock (espresso 59 ₪, the sand mug 89 ₪), one or two, with the price and one short question' },
  { id: 'q2', kind: 'size and colour', says: ['כמה נכנס בספל החול? ויש אותו בתכלת?'], wants: '350 ml; light blue (תכלת) is out of stock, sand and grey are in' },
  { id: 'q3', kind: 'stock', says: ['האגרטל הגבוה חזר למלאי?'], wants: 'out of stock (back after the next firing, the store\'s own words), no invented date' },
  { id: 'q4', kind: 'product care', says: ['ספל האספרסו אפשר לשים במדיח?'], wants: 'matte glaze: better washed by hand (the description and the FAQ)' },
  { id: 'q5', kind: 'shipping', says: ['כמה עולה משלוח לחיפה ותוך כמה זמן זה מגיע?'], wants: '35 ₪, free over 300 ₪, 3 to 5 business days' },
  { id: 'q6', kind: 'returns', says: ['קניתי סט צלחות ערב והגוון לא מתאים לי בבית. אפשר להחזיר?'], wants: 'within 14 days, whole and unused, return shipping on the customer' },
  { id: 'q7', kind: 'order, no key', says: ['מה קורה עם ההזמנה שלי? מספר 1042'], wants: 'cannot check here: handed to the store, no invented status' },
  { id: 'q8', kind: 'complaint', says: ['הקערה שהזמנתי הגיעה שבורה. ממש מבאס, חיכיתי לה שבוע'], wants: 'a short human line, a handoff; the store\'s own rule (a photo within 48 hours) may be quoted, nothing promised beyond it' },
  { id: 'q9', kind: 'vague, then precise', says: ['יש לכם משהו יפה לבית?', 'משהו לפרחים, קטן, עד 100 ₪'], wants: 'first one short question (or up to three options); then the small ball vase, 95 ₪, in stock' },
  { id: 'q10', kind: 'English', says: ['Hi, do you ship to London? And how much is the big olive bowl?'], wants: 'in English: no shipping abroad for now; the large olive bowl is 165 ₪' },
  { id: 'q11', kind: 'must hand off', says: ['אני מארגנת אירוע ל-30 איש. אפשר הנחה על 30 ספלים?'], wants: 'a discount is the store\'s: handoff; the FAQ\'s events line (sets of 20 and more, she writes back with an offer) may be quoted' },
  { id: 'q12', kind: 'several conditions', says: ['צריכה משהו לנרות שבת בגוון בהיר, התקציב שלי 120 ₪'], wants: 'the double candle holder in sand, 119 ₪, in stock' },
];

type Call = { apiMs: number | null; wallMs: number; thinking: number | null; cliUsd: number | null; models: string[]; usage: { in: number; out: number; read: number; write: number; iterations: number } };
const calls = new AsyncLocalStorage<Call[]>();
const run: RunFn = async (o) => {
  const t0 = Date.now();
  const r = await spawnRun(o);
  let j: any = null;
  try {
    j = JSON.parse(r.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop() || 'null');
  } catch {
    j = null;
  }
  const u = j?.usage || {};
  calls.getStore()?.push({ apiMs: j?.duration_api_ms ?? null, wallMs: Date.now() - t0, thinking: u.output_tokens_details?.thinking_tokens ?? null, cliUsd: j?.total_cost_usd ?? null, models: Object.keys(j?.modelUsage || {}), usage: { in: u.input_tokens || 0, out: u.output_tokens || 0, read: u.cache_read_input_tokens || 0, write: u.cache_creation_input_tokens || 0, iterations: (u.iterations || []).length } });
  return r;
};

const home = mkdtempSync(path.join(os.tmpdir(), 'toran-eval-models-'));
const env: Record<string, string | undefined> = {
  ...process.env,
  TORAN_HOME: home,
  TORAN_LLM: 'claude-cli',
  // The deadline is production's for a model answering in seconds; here each call also starts the CLI.
  TORAN_TURN_DEADLINE_MS: '900000',
  TORAN_MODELS_DIR: process.env.TORAN_MODELS_DIR || path.join(home, 'models'),
};
const llm = cliClient({ env, run, concurrency: CONC, log: (m) => console.warn(m) });
const db = await openDb({ memory: true });
const app = await makeApp({ env, db, fetcher: exampleFetcher(), llm, wa: simProvider(), quiet: true });
app.render = async () => null;
const { storeId } = await seedDemo(app, { conversation: false });

/** What the same tokens cost on the API path: the conversation's new part written to the 5-minute cache, not the hour. */
const apiPathUsd = (t: TurnOutput['tokens'], model: string) => {
  const r = rateOf(model);
  return (t.in * r.in + t.cacheRead * r.read + t.cacheWrite * r.w5m + t.out * r.out) / 1e6;
};

type Answer = { config: string; id: string; kind: string; n: number; says: string; reply: string; raw: string; tools: { name: string; input: unknown }[]; handoff: string | null; cuts: string[]; rounds: number; apiUsd: number; apiPathUsd: number; modelMs: number; maxCallMs: number; thinking: number; tokens: TurnOutput['tokens']; wallMs: number; calls: Call[] };
const answers: Answer[] = [];
let peer = 0;

async function talk(config: string, c: Case): Promise<void> {
  const conv = await conversationFor(app.db, storeId, 'whatsapp', `97250000${String(1000 + peer++).padStart(4, '0')}`);
  for (let n = 0; n < c.says.length; n++) {
    const log: Call[] = [];
    const t0 = Date.now();
    const out = await calls.run(log, () => runTurn(app, { storeId, conversationId: conv, text: c.says[n], extId: `${config}-${c.id}-${n}-${Date.now()}`, channel: 'whatsapp', footer: false }));
    const model = String(app.env.TORAN_MODEL_AGENT);
    answers.push({
      config,
      id: c.id,
      kind: c.kind,
      n,
      says: c.says[n],
      reply: out.reply,
      raw: out.rawReply,
      tools: out.tools.map((t) => ({ name: t.name, input: t.input })),
      handoff: out.handoff ? `${out.handoff.reason}: ${out.handoff.summary}` : null,
      cuts: out.redactions.map((r) => `${r.rule}: ${r.sentence}`),
      rounds: out.rounds,
      apiUsd: out.apiUsd,
      apiPathUsd: apiPathUsd(out.tokens, model),
      modelMs: log.reduce((a, x) => a + (x.apiMs || 0), 0),
      maxCallMs: Math.max(0, ...log.map((x) => x.apiMs || 0)),
      thinking: log.reduce((a, x) => a + (x.thinking || 0), 0),
      tokens: out.tokens,
      wallMs: Date.now() - t0,
      calls: log,
    });
    console.log(`${config} ${c.id}.${n} ${out.rounds} calls $${out.apiUsd.toFixed(4)} ${(log.reduce((a, x) => a + (x.apiMs || 0), 0) / 1000).toFixed(1)}s: ${out.reply.replace(/\s+/g, ' ').slice(0, 140)}`);
  }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
  }));
}

// Beside npm run eval's transcripts, in the private folder (never the throwaway one the store is built in).
const out = opt('out', path.join(evalDir(process.env), `models-${new Date().toISOString().slice(0, 10)}.json`));
mkdirSync(path.dirname(out), { recursive: true });
const cases = CASES.filter((c) => !ONLY.size || ONLY.has(c.id));
for (const cfg of CONFIGS) {
  const name = `${cfg.model.replace(/^claude-/, '')}:${cfg.effort}`;
  app.env.TORAN_MODEL_AGENT = cfg.model;
  app.env.TORAN_AGENT_EFFORT = cfg.effort;
  // The loop reads the effort through agentEffort, which takes only the levels Toran runs at (no max).
  if (agentEffort(app.env) !== cfg.effort) throw new Error(`the agent does not run at effort ${cfg.effort}: agentEffort gives ${agentEffort(app.env)}`);
  // The warm-up: the store's prompt goes into the cache, as on a store that answered in the last hour.
  const warm = await conversationFor(app.db, storeId, 'whatsapp', `97250000${String(1000 + peer++).padStart(4, '0')}`);
  await calls.run([], () => runTurn(app, { storeId, conversationId: warm, text: 'שלום', extId: `${name}-warm-${Date.now()}`, channel: 'whatsapp', footer: false }));
  await pool(cases, CONC, (c) => talk(name, c));
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), configs: CONFIGS, cases: CASES, answers }, null, 1));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const base = answers.filter((a) => a.config === `${CONFIGS[0].model.replace(/^claude-/, '')}:${CONFIGS[0].effort}`);
const baseUsd = mean(base.map((a) => a.apiPathUsd));
console.log('\nconfig                  answers  $/answer rec  $/answer API  x first  model s/answer  max call s  thinking  calls  handoffs  cuts');
for (const cfg of CONFIGS) {
  const name = `${cfg.model.replace(/^claude-/, '')}:${cfg.effort}`;
  const a = answers.filter((x) => x.config === name);
  const usd = mean(a.map((x) => x.apiPathUsd));
  console.log(`${name.padEnd(22)} ${String(a.length).padStart(8)} ${mean(a.map((x) => x.apiUsd)).toFixed(4).padStart(13)} ${usd.toFixed(4).padStart(13)} ${(baseUsd ? usd / baseUsd : 0).toFixed(2).padStart(8)} ${(mean(a.map((x) => x.modelMs)) / 1000).toFixed(1).padStart(15)} ${(Math.max(0, ...a.map((x) => x.maxCallMs)) / 1000).toFixed(1).padStart(11)} ${Math.round(mean(a.map((x) => x.thinking))).toString().padStart(9)} ${mean(a.map((x) => x.rounds)).toFixed(1).padStart(6)} ${String(a.filter((x) => x.handoff).length).padStart(9)} ${String(a.reduce((s, x) => s + x.cuts.length, 0)).padStart(5)}`);
}
console.log(`\nEvery answer: ${out}`);
await app.db.close();
