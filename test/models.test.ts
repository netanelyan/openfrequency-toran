import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_EFFORT, AGENT_MODEL, agentEffort, agentModel, OWNER_EFFORT, OWNER_MAX_TOKENS } from '../src/agent/llm/index.ts';
import { cliClient, usageOf, type RunFn } from '../src/agent/llm/cli.ts';
import { costUsd } from '../src/agent/llm/cost.ts';
import { AGENT_MAX_TOKENS, MODEL_TIMEOUT_MS } from '../src/agent/loop.ts';

// Which model answers, and how hard it thinks (docs/models.md, 2026-11-11: twelve shoppers' conversations on the
// fictional store, measured on the subscription): Sonnet 5.5 at high effort for the customers, medium for the owner's
// side, low for the rest; and the CLI's tokens counted as production would be billed for them.

test('the agent answers on Sonnet 5.5 at high effort unless the settings say otherwise; the owner\'s side thinks at medium with room for it', () => {
  assert.equal(AGENT_MODEL, 'claude-sonnet-5-5');
  assert.equal(agentModel({}), 'claude-sonnet-5-5');
  assert.equal(agentModel({ TORAN_MODEL_AGENT: ' claude-opus-5-5 ' }), 'claude-opus-5-5');
  assert.equal(AGENT_EFFORT, 'high');
  assert.equal(agentEffort({}), 'high');
  assert.equal(agentEffort({ TORAN_AGENT_EFFORT: 'medium' }), 'medium', 'production can still go back with one setting');
  assert.equal(agentEffort({ TORAN_AGENT_EFFORT: 'XHIGH' }), 'xhigh');
  assert.equal(agentEffort({ TORAN_AGENT_EFFORT: 'max' }), 'high', 'max is not a level Toran runs at');
  assert.equal(OWNER_EFFORT, 'medium');
  assert.ok(OWNER_MAX_TOKENS >= 4000, 'thinking counts in the output: room for it and the answer');
  // At high effort the longest call measured was 7.3 seconds, and none wrote 700 tokens; a call has 40 seconds and 8,000.
  assert.ok(AGENT_MAX_TOKENS >= 8000 && MODEL_TIMEOUT_MS >= 40_000);
});

// The CLI's answer to one call that it made in two requests (a real one, 2026-11-11, Sonnet 5.5 at xhigh): the model
// thought (119 tokens) and answered, then the JSON was written; `usage` sums both, `iterations` keeps the second.
const TWO_REQUESTS = {
  type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.0081506, structured_output: { reply: 'The 89 mug fits best.' },
  usage: {
    input_tokens: 6, cache_creation_input_tokens: 1298, cache_read_input_tokens: 1083, output_tokens: 273, output_tokens_details: { thinking_tokens: 119 },
    cache_creation: { ephemeral_1h_input_tokens: 1298, ephemeral_5m_input_tokens: 0 },
    iterations: [{ input_tokens: 4, output_tokens: 98, cache_read_input_tokens: 1083, cache_creation_input_tokens: 215, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 215 }, type: 'message' }],
  },
  modelUsage: { 'claude-sonnet-5-5': { outputTokens: 273, thinkingTokens: 119 } },
};
// One request: the total and the iteration are the same, and its output holds its thinking.
const ONE_REQUEST = {
  type: 'result', subtype: 'success', is_error: false, num_turns: 2, structured_output: { reply: 'יש.' },
  usage: { input_tokens: 2, cache_creation_input_tokens: 1126, cache_read_input_tokens: 0, output_tokens: 78, output_tokens_details: { thinking_tokens: 30 }, cache_creation: { ephemeral_1h_input_tokens: 1126, ephemeral_5m_input_tokens: 0 }, iterations: [{ input_tokens: 2, output_tokens: 78, cache_read_input_tokens: 0, cache_creation_input_tokens: 1126, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1126 }, type: 'message' }] },
  modelUsage: { 'claude-sonnet-5-5': {} },
};

test("the CLI's tokens as production would be billed: one pass over the conversation, the answer and all its thinking, never more than the CLI's own total", async () => {
  const two = usageOf(TWO_REQUESTS);
  assert.equal(two.output_tokens, 98 + 119, 'the second request alone left out the thinking of the first');
  assert.equal(two.input_tokens, 4);
  assert.equal(two.cache_read_input_tokens, 1083);
  assert.equal(two.cache_creation_input_tokens, 215);
  assert.equal(two.cache_write_1h, 215);
  assert.equal(usageOf(ONE_REQUEST).output_tokens, 78, 'one request: its output already holds its thinking');
  assert.equal(usageOf({ usage: { output_tokens: 500, output_tokens_details: { thinking_tokens: 900 }, iterations: [{ output_tokens: 100 }] } }).output_tokens, 500, 'never more than the total');
  assert.equal(usageOf({}).output_tokens, 0);
  // Through the client: what is recorded as apiUsd is that, at the model's API prices.
  const run: RunFn = async () => ({ code: 0, stdout: JSON.stringify(TWO_REQUESTS), stderr: '', timedOut: false });
  const res = await cliClient({ env: { PATH: '' }, run, log: () => {} }).turn({ system: [{ text: 'x' }], messages: [{ role: 'user', content: 'q' }], tools: [], model: 'claude-sonnet-5-5', maxTokens: 100, effort: 'high' });
  assert.equal(res.usage.output_tokens, 217);
  assert.equal(res.usd, 0, 'the subscription pays nothing a call');
  assert.equal(res.apiUsd, costUsd(two, 'claude-sonnet-5-5'));
  assert.ok(res.apiUsd > costUsd({ ...two, output_tokens: 98 }, 'claude-sonnet-5-5'));
});
