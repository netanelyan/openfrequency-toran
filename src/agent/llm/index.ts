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

export const agentModel = (env: Env = process.env) => String(env.TORAN_MODEL_AGENT || '').trim() || 'claude-opus-5-5';

/**
 * How hard the agent thinks on a customer's turn: TORAN_AGENT_EFFORT (low, medium, high or xhigh), medium when unset
 * (the owner, 2026-11-09: "make him smarter, make him reason ... even if ai costs double"). It was low until then, and
 * low answered a request for a yellow shirt with a red one. Every other call (the guard's second opinion, the receipt
 * check, the photos' looks) stays at low.
 */
export const agentEffort = (env: Env = process.env): Effort => {
  const v = String(env.TORAN_AGENT_EFFORT || '').trim().toLowerCase();
  return v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' ? v : 'medium';
};

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
