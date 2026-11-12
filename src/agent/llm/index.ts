import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { isSet, toranEnv } from '../../core/env.ts';
import { ensureDir, logsDir } from '../../core/paths.ts';
import { apiClient } from './api.ts';
import { cliClient } from './cli.ts';
import { scriptedClient } from './scripted.ts';
import { type Effort, type Llm, LlmError } from './types.ts';

export type { Llm } from './types.ts';

// Which model backend a process gets:
//   TORAN_LLM forces one (api | claude-cli | scripted)
//   prod (the VPS) runs on the API when ANTHROPIC_API_KEY is set
//   dev (a laptop, the default) runs on the Claude Code CLI, on the subscription
// In dev an API call is refused unless the command was given --allow-api, and each
// refusal is logged (Teder's rule): development never spends API money by accident.

type Env = Record<string, string | undefined>;

/**
 * The model that answers a store's customers, and every other call of Toran's: TORAN_MODEL_AGENT, Sonnet 5.5 unless set
 * (production has set it since before 2026-11-11). Opus 5.5 got the evaluation's shoppers the same facts as Sonnet 5.5
 * at high effort, at 2 to 2.5 times the cost and a longer wait (its slowest call 18.8 seconds, against 7.3: docs/models.md).
 */
export const AGENT_MODEL = 'claude-sonnet-5-5';
export const agentModel = (env: Env = process.env) => String(env.TORAN_MODEL_AGENT || '').trim() || AGENT_MODEL;

/**
 * How hard the agent thinks on a customer's turn: TORAN_AGENT_EFFORT (low, medium, high or xhigh), AGENT_EFFORT when
 * unset. The owner, 2026-11-09: "make him smarter, make him reason ... even if ai costs double" (low answered a request
 * for a yellow shirt with a red one, so it became medium); 2026-11-11: "make sure toran and teder ai are smart ...
 * even if toran costs 1.5x themselves". Measured on twelve shoppers' conversations (docs/models.md): at medium Sonnet
 * 5.5 handed 4 of 55 questions to the owner without looking them up (a dishwasher question, an English one, candles
 * under 120 ₪); at high, 1 of 44, for about 1.1 to 1.2 times the cost and a second more an answer. xhigh came out at
 * 1.5 times, the owner's limit itself. The guard's second opinion, the receipt check and the photos' looks stay at low;
 * the owner's side at OWNER_EFFORT.
 */
export const AGENT_EFFORT: Effort = 'high';
export const agentEffort = (env: Env = process.env): Effort => {
  const v = String(env.TORAN_AGENT_EFFORT || '').trim().toLowerCase();
  return v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' ? v : AGENT_EFFORT;
};

/**
 * The owner's side: the assistant that answers the store's owner about their store, and the store's voice read from its
 * copy (2026-11-11, "make sure toran ... ai are smart"). Medium, with room to think (OWNER_MAX_TOKENS): a few calls a
 * store a week, so thinking costs little there, and they shape what the owner reads and the tone of every answer.
 */
export const OWNER_EFFORT: Effort = 'medium';
export const OWNER_MAX_TOKENS = 4000;

/** Is this a backend that can be shown a photo? The Claude Code CLI is given the turn as text, so it cannot. */
export const canSee = (backend: string) => backend === 'api' || backend === 'scripted';

export function llmBackend(env: Env = process.env): 'api' | 'claude-cli' | 'scripted' {
  const forced = String(env.TORAN_LLM || '').trim().toLowerCase();
  if (forced === 'api' || forced === 'claude-cli' || forced === 'scripted') return forced;
  if (toranEnv(env) === 'prod') return isSet('ANTHROPIC_API_KEY', env) ? 'api' : 'scripted';
  return 'claude-cli';
}

export function apiGate(env: Env, allowApi = process.argv.includes('--allow-api')) {
  return (what: string) => {
    if (toranEnv(env) === 'prod' || allowApi) return;
    try {
      appendFileSync(path.join(ensureDir(logsDir(env)), 'api-refusals.log'), `${new Date().toISOString()}\t${what}\n`);
    } catch {
      /* the refusal stands without its log line */
    }
    throw new LlmError(`refused in development: ${what} would call the Anthropic API. Run with --allow-api, or set TORAN_ENV=prod`, 'api_refused');
  };
}

export function makeLlm(env: Env = process.env, { log = (m: string) => console.warn(m) }: { log?: (m: string) => void } = {}): Llm {
  const b = llmBackend(env);
  if (b === 'scripted') return scriptedClient();
  if (b === 'claude-cli') return cliClient({ env, log });
  return apiClient({ apiKey: String(env.ANTHROPIC_API_KEY || ''), workspaceId: env.ANTHROPIC_WORKSPACE_ID, gate: apiGate(env) });
}
