import type { App } from '../app.ts';
import { usage } from '../db/log.ts';
import { demoNumber, type RouteResult } from './demo.ts';
import { LEDGER } from './send.ts';
import type { Channel, ChannelAdapter, Inbound } from './types.ts';

// Every inbound message, from any channel, comes through here (from the worker's queue): the delivery is checked
// against what was already handled, its cost is recorded, and it goes to the store it belongs to. Today one way leads
// to a store: the shared demo number, whose codes bind a phone to a store (demo.ts).

export type { RouteResult };

export function adapterFor(app: App, channel: Channel = 'whatsapp'): ChannelAdapter {
  if (channel === 'whatsapp') return app.wa;
  throw new Error(`no adapter for channel ${channel}`);
}

export async function handleInbound(app: App, inbound: Inbound): Promise<RouteResult> {
  const adapter = adapterFor(app, inbound.channel);
  if (await app.db.one('SELECT 1 FROM messages WHERE ext_id = $1', [inbound.id])) return { action: 'duplicate' };
  await usage(app.db, { kind: 'bsp', backend: adapter.kind, units: 1, usd: adapter.inboundUsd, apiUsd: adapter.inboundUsd, tag: `${LEDGER[adapter.channel]}_in` });
  return demoNumber(app, adapter, inbound);
}
