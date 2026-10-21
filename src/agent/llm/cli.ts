import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costUsd } from './cost.ts';
import { type Block, type Llm, LlmError, type Msg, type TurnReq, type TurnRes, isText } from './types.ts';

// The development backend: the Claude Code CLI, headless, on the owner's subscription.
// Ported from Teder's llm/cli.js, extended for tool use.
//
// THE SAME TURN. The loop hands this the same request it hands the API: the same system
// parts, the same tool definitions, the same conversation. The CLI runs it as one model
// request with its own tools off (--tools ""), nothing of the machine's setup
// (--safe-mode), a fresh unsaved session, and a JSON schema for the answer:
//   { "tool_calls": [{ "name", "input" }] }   to call tools; the loop runs them and asks again
//   { "reply": "..." }                         the message to the customer
// The schema's tool names are the tool list's, so a call to a tool that does not exist
// cannot come back. The tool definitions and the transcript (tool calls and their
// results included) are written into the prompt as text.
//
// NEVER THE KEY. The child's environment has no ANTHROPIC_* variables: with
// ANTHROPIC_API_KEY in it, the CLI would bill the API instead of the subscription. The
// variables of a Claude Code session this may run inside are dropped too.
//
// TOKENS. The usage the CLI reports is recorded at API prices as apiUsd (what
// production would pay), with usd 0.
//
// A usage limit waits for the reset the CLI names (or half an hour) and asks again,
// never the API instead.

const DROP_ENV = /^(ANTHROPIC_|CLAUDECODE$|CLAUDE_CODE_(SESSION|CHILD|MESSAGING|BRIDGE|ENTRYPOINT|SSE)|CLAUDE_PID$|CLAUDE_EFFORT$)/;
export const childEnv = (env: Record<string, string | undefined> = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !DROP_ENV.test(k))) as Record<string, string>;

export function claudeBin(env: Record<string, string | undefined> = process.env): string {
  if (env.TORAN_CLAUDE_BIN) return env.TORAN_CLAUDE_BIN;
  if (process.platform !== 'win32') return 'claude';
  for (const dir of String(env.PATH || env.Path || '').split(';').filter(Boolean)) {
    const exe = path.join(dir, 'claude.exe');
    if (existsSync(exe)) return exe;
    const shim = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(path.join(dir, 'claude.cmd')) && existsSync(shim)) return shim;
  }
  return 'claude.exe';
}

/** The conversation as text: what the customer said, what was called, what came back. */
export function transcript(messages: Msg[]): string {
  const out: string[] = [];
  for (const m of messages) {
    const blocks: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    for (const b of blocks) {
      if (b.type === 'text') out.push(`${m.role === 'user' ? '[CUSTOMER]' : '[YOU]'} ${(b as any).text}`);
      else if (b.type === 'tool_use') out.push(`[YOU CALLED] ${(b as any).name} ${JSON.stringify((b as any).input)}`);
      else if (b.type === 'tool_result') out.push(`[TOOL RESULT${(b as any).is_error ? ', ERROR' : ''}]\n${(b as any).content}`);
    }
  }
  return out.join('\n\n');
}

export function protocol(req: TurnReq): string {
  const tools = req.tools.map((t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.input_schema)}`).join('\n');
  return `\n\n# How you answer in this environment\nYou have these tools:\n${tools}\n\nAnswer with one JSON object and nothing else:\n- {"tool_calls": [{"name": "<tool>", "input": {...}}]} to call one or more tools. You will get their results and answer again.\n- {"reply": "<your message to the customer>"} when you are ready to answer the customer.\nNever both in one answer.`;
}

export function schemaFor(req: TurnReq) {
  return {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      tool_calls: { type: 'array', items: { type: 'object', properties: { name: { type: 'string', enum: req.tools.map((t) => t.name) }, input: { type: 'object' } }, required: ['name', 'input'] } },
    },
  };
}

export type RunFn = (o: { bin: string; args: string[]; input: string; env: Record<string, string>; cwd: string; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

export const spawnRun: RunFn = ({ bin, args, input, env, cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });

const LIMIT = /usage limit|hit your limit|limit reached|rate.?limit|too many requests|overloaded/i;
let idSeq = 0;

export function cliClient({ env = process.env, run = spawnRun, timeoutMs = Number(env.TORAN_CLI_TIMEOUT_MS) || 180_000, concurrency = Number(env.TORAN_CLI_CONCURRENCY) || 2, log = (m: string) => console.warn(m), sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) }: { env?: Record<string, string | undefined>; run?: RunFn; timeoutMs?: number; concurrency?: number; log?: (m: string) => void; sleep?: (ms: number) => Promise<unknown> } = {}): Llm {
  const bin = claudeBin(env);
  const base = path.join(os.tmpdir(), 'toran-cli');
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = () => (active < concurrency ? (active++, Promise.resolve()) : new Promise<void>((r) => waiting.push(() => (active++, r()))));
  const release = () => {
    active--;
    waiting.shift()?.();
  };

  async function once(req: TurnReq, note: string) {
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(path.join(base, 'call-'));
    const systemFile = path.join(dir, 'system.txt');
    writeFileSync(systemFile, req.system.map((s) => s.text).join('\n\n') + protocol(req));
    const args = ['-p', '--output-format', 'json', '--model', req.model, '--effort', req.effort || 'low', '--json-schema', JSON.stringify(schemaFor(req)), '--system-prompt-file', systemFile, '--tools', '', '--no-session-persistence', '--safe-mode', '--strict-mcp-config'];
    const input = `${transcript(req.messages)}${note ? `\n\n${note}` : ''}\n\nAnswer now with the JSON object.`;
    await acquire();
    try {
      return await run({ bin, args, input, env: childEnv(env), cwd: dir, timeoutMs });
    } catch (e: any) {
      if (e?.code === 'ENOENT') throw new LlmError(`the Claude Code CLI was not found (${bin}): install it and log in, or set TORAN_CLAUDE_BIN`, 'cli_missing');
      throw new LlmError(`the Claude Code CLI could not start: ${e.message}`, 'cli');
    } finally {
      release();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    backend: 'claude-cli',
    async turn(req: TurnReq): Promise<TurnRes> {
      let note = '';
      for (let attempt = 0; ; ) {
        const r = await once(req, note);
        if (r.timedOut) throw new LlmError(`the Claude Code CLI gave no answer in ${Math.round(timeoutMs / 1000)} s`, 'timeout');
        let res: any = null;
        try {
          res = JSON.parse(r.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop() || 'null');
        } catch {
          res = null;
        }
        const said = `${res?.result || ''} ${r.stderr || ''}`;
        if (!res || res.is_error) {
          if (res?.api_error_status === 429 || LIMIT.test(said)) {
            log(`claude-cli: usage limit (${said.trim().slice(0, 120)}); waiting 30 min, then the same call again`);
            await sleep(30 * 60_000);
            continue;
          }
          throw new LlmError(`the Claude Code CLI failed: ${said.trim().slice(0, 300) || `exit ${r.code}`}`, 'cli');
        }
        let data = res.structured_output;
        if (data == null) {
          try {
            data = JSON.parse(String(res.result || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
          } catch {
            data = null;
          }
        }
        const calls = Array.isArray(data?.tool_calls) ? data.tool_calls.filter((c: any) => c && typeof c.name === 'string') : [];
        const reply = typeof data?.reply === 'string' ? data.reply : '';
        if (!calls.length && !reply.trim()) {
          if (attempt++ >= 1) throw new LlmError('the model returned neither a reply nor a tool call, twice', 'not_json');
          note = 'Your previous answer was not a usable JSON object. Answer with {"reply": "..."} or {"tool_calls": [...]} only.';
          continue;
        }
        const model = Object.keys(res.modelUsage || {})[0] || req.model;
        const last = (res.usage?.iterations || []).at(-1) || res.usage || {};
        const usage = { input_tokens: last.input_tokens || 0, output_tokens: last.output_tokens || 0, cache_read_input_tokens: last.cache_read_input_tokens || 0, cache_creation_input_tokens: last.cache_creation_input_tokens || 0, cache_write_1h: last.cache_creation?.ephemeral_1h_input_tokens ?? 0, cache_write_5m: last.cache_creation?.ephemeral_5m_input_tokens ?? 0 };
        const content: Block[] = calls.length ? calls.map((c: any) => ({ type: 'tool_use', id: `cli_${Date.now().toString(36)}_${idSeq++}`, name: c.name, input: c.input && typeof c.input === 'object' ? c.input : {} })) : [{ type: 'text', text: reply }];
        return { content, stopReason: calls.length ? 'tool_use' : 'end_turn', usage, model, backend: 'claude-cli', usd: 0, apiUsd: costUsd(usage, model) };
      }
    },
  };
}

export const textOf = (blocks: Block[]) => blocks.filter(isText).map((b) => b.text).join('\n').trim();
