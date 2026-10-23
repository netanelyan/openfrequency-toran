import type { Db } from '../db/index.ts';
import { J } from '../db/index.ts';
import type { Channel } from './types.ts';

// Which channels exist, at two levels:
//
//   the code    TORAN_CHANNELS (e.g. "whatsapp,email") turns a channel's code on: its webhook answers, a store can
//               connect it, the inbox lists it. WhatsApp is always on. A channel not listed is 404 everywhere.
//   the world   the settings row "channels": each channel off | demo | live, set by the operator on /settings. It is
//               what the website says (its "בקרוב" tags read GET /channels.json), so it says "live" only when a
//               paying store can really have Toran answer there. A channel whose code is off cannot be demo or live.
//
// Messenger and Instagram are listed so the website can show them as coming; their code arrives in later steps.

export const ALL_CHANNELS = ['whatsapp', 'email', 'messenger', 'instagram'] as const;
export type AnyChannel = (typeof ALL_CHANNELS)[number];
export type ChannelState = 'off' | 'demo' | 'live';
const STATES: ChannelState[] = ['off', 'demo', 'live'];

/** The channels of a conversation the inbox shows (the others are the CLI, the pitch builder and the evals). */
export const MESSAGING: Channel[] = ['whatsapp', 'email'];
export const messagingSql = (column = 'channel') => `${column} IN (${MESSAGING.map((c) => `'${c}'`).join(', ')})`;

export const CHANNEL_HE: Record<AnyChannel, string> = { whatsapp: 'וואטסאפ', email: 'מייל', messenger: 'מסנג׳ר', instagram: 'אינסטגרם' };

/** The channels whose code is on here. */
export function enabledChannels(env: Record<string, string | undefined>): Set<AnyChannel> {
  const listed = String(env.TORAN_CHANNELS || '').split(/[,\s]+/).map((c) => c.trim().toLowerCase()).filter(Boolean);
  return new Set<AnyChannel>(['whatsapp', ...ALL_CHANNELS.filter((c) => listed.includes(c))]);
}

const DEFAULTS: Record<AnyChannel, ChannelState> = { whatsapp: 'demo', email: 'off', messenger: 'off', instagram: 'off' };

export async function channelStates(db: Db): Promise<Record<AnyChannel, ChannelState>> {
  const row = await db.one<{ value: any }>("SELECT value FROM settings WHERE key = 'channels'");
  const out = { ...DEFAULTS };
  for (const c of ALL_CHANNELS) if (STATES.includes(row?.value?.[c])) out[c] = row!.value[c];
  return out;
}

/** Set one channel's state; refused when its code is off and the state is not "off". */
export async function setChannelState(db: Db, env: Record<string, string | undefined>, channel: string, state: string): Promise<Record<AnyChannel, ChannelState>> {
  if (!(ALL_CHANNELS as readonly string[]).includes(channel) || !STATES.includes(state as ChannelState)) throw new Error('unknown channel or state');
  if (state !== 'off' && !enabledChannels(env).has(channel as AnyChannel)) throw new Error(`the code for ${channel} is off (TORAN_CHANNELS)`);
  const next = { ...(await channelStates(db)), [channel]: state };
  await db.query("INSERT INTO settings (key, value) VALUES ('channels', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [J(next)]);
  return next;
}

/** GET /channels.json: what the website shows. Nothing about any store or workspace. */
export async function publicChannels(db: Db) {
  const states = await channelStates(db);
  return { channels: states, live: ALL_CHANNELS.filter((c) => states[c] === 'live'), demo: ALL_CHANNELS.filter((c) => states[c] === 'demo'), soon: ALL_CHANNELS.filter((c) => states[c] === 'off') };
}

/** The address a store's mail is forwarded to. */
export const storeAddress = (s: { id: number; slug: string | null }, domain: string) => `${(s.slug || `store-${s.id}`).toLowerCase()}@${domain}`;
