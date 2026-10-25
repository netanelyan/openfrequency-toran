import Anthropic from '@anthropic-ai/sdk';
import { costUsd } from './cost.ts';
import { type Block, type Llm, LlmError, type TurnReq, type TurnRes } from './types.ts';

// The production backend: the Messages API through the official SDK.
//
// PROMPT CACHING (tiyul-plus's layout, its rules pinned): the request renders as
// tools -> system -> messages, and the cache is a prefix match. So:
//   - the tool list is identical for every store and every turn (never changes per turn)
//   - system[0] is the shared Toran prompt, with a 1-hour breakpoint: the same bytes
//     for every store, so every store's first call reads it
//   - system[1] is the store's own block (name, tone, policy index, FAQ), with a 1-hour
//     breakpoint: the same bytes for every customer of that store
//   - the conversation tail gets automatic caching (5 minutes), so the loop's second
//     call within a turn reads the first's
//   - nothing per-turn ever goes into system: the date and the channel ride in the
//     customer's message as a SERVER CONTEXT line
// Longer TTLs come first, as the API requires. Opus 5.5 caches from 512 tokens.
//
// Thinking cannot be turned off on Opus 5.5; effort is the dial (low for chat). The
// server-side refusal fallback ('default') is on, so a safety decline is re-run on the
// fallback model instead of ending the turn; a final refusal is handed off by the loop.

const FALLBACK_MODELS = /^claude-(opus-5-5|fable-5-1|sonnet-5-5)/;

export function apiClient({ apiKey, workspaceId, gate }: { apiKey: string; workspaceId?: string; gate?: (what: string) => void }): Llm {
  if (!apiKey) throw new LlmError('ANTHROPIC_API_KEY is not set', 'no_key');
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000, defaultHeaders: workspaceId ? { 'anthropic-workspace-id': workspaceId } : undefined });
  return {
    backend: 'api',
    async turn(req: TurnReq): Promise<TurnRes> {
      gate?.(req.tag || 'agent turn');
      const system = req.system.map((s) => ({ type: 'text' as const, text: s.text, ...(s.cache ? { cache_control: { type: 'ephemeral' as const, ttl: s.cache } } : {}) }));
      const fallback = FALLBACK_MODELS.test(req.model);
      const params: Record<string, unknown> = {
        model: req.model,
        max_tokens: req.maxTokens,
        system,
        ...(req.tools.length ? { tools: req.tools } : {}),
        messages: req.messages,
        cache_control: { type: 'ephemeral' },
        output_config: { effort: req.effort || 'low' },
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      };
      let msg: any;
      try {
        msg = fallback ? await client.beta.messages.create(params as never) : await client.messages.create(params as never);
      } catch (e: any) {
        if (e instanceof Anthropic.RateLimitError) throw new LlmError('rate limited', 'rate_limit');
        if (e instanceof Anthropic.AuthenticationError) throw new LlmError('the API key was refused', 'auth');
        if (e instanceof Anthropic.BadRequestError) throw new LlmError(`bad request: ${e.message}`, 'bad_request');
        if (e instanceof Anthropic.APIError) throw new LlmError(`API error ${e.status}: ${e.message}`, 'api');
        throw new LlmError(`network: ${e?.message || e}`, 'network');
      }
      const u = msg.usage || {};
      const usage = {
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_read_input_tokens: u.cache_read_input_tokens || 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
        cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        cache_write_5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      };
      const usd = costUsd(usage, msg.model || req.model);
      return { content: (msg.content || []) as Block[], stopReason: msg.stop_reason, usage, model: msg.model || req.model, backend: 'api', usd, apiUsd: usd };
    },
  };
}
