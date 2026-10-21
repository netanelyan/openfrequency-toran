import type { Usage } from './types.ts';

// What a model call costs, in USD, from its usage block. Prices per million tokens
// (Anthropic's first-party rates, from the claude-api reference, cached 2026-09-25).
// Cache writes cost 1.25x the input price for the 5-minute TTL and 2x for the 1-hour
// TTL; the two are priced apart (tiyul-plus's aiCost.ts did the same). An unknown model
// is priced at the dearest rate, so a typo can only overstate the cost.

export type Rate = { in: number; out: number; read: number; w5m: number; w1h: number };

export const RATES: Record<string, Rate> = {
  'claude-fable-5-1': { in: 10, out: 50, read: 0.25, w5m: 12.5, w1h: 20 },
  'claude-opus-5-5': { in: 4, out: 20, read: 0.2, w5m: 5, w1h: 8 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.2, w5m: 2.5, w1h: 4 },
  'claude-haiku-4-5': { in: 1, out: 5, read: 0.1, w5m: 1.25, w1h: 2 },
};
const WORST: Rate = RATES['claude-fable-5-1'];

export function rateOf(model: string): Rate {
  const m = String(model || '');
  const key = Object.keys(RATES).find((k) => m === k || m.startsWith(`${k}-`));
  return key ? RATES[key] : WORST;
}

export function costUsd(u: Partial<Usage>, model: string): number {
  const r = rateOf(model);
  const write = u.cache_creation_input_tokens || 0;
  const w1h = u.cache_write_1h ?? (u.cache_write_5m != null ? write - u.cache_write_5m : 0);
  const w5m = write - w1h;
  return ((u.input_tokens || 0) * r.in + (u.output_tokens || 0) * r.out + (u.cache_read_input_tokens || 0) * r.read + w5m * r.w5m + w1h * r.w1h) / 1e6;
}
