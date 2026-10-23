import type { App } from '../app.ts';
import { event, usage } from '../db/log.ts';
import { adapterFor } from './adapters.ts';
import { demoNumber, type RouteResult } from './demo.ts';
import { LEDGER } from './send.ts';
import { accountFor, storeChannel } from './store.ts';
import type { Inbound } from './types.ts';

// Every inbound message, from any channel, comes through here (from the worker's queue): a provider's report about an
// address is recorded, a delivery already handled is dropped, the rest of the message is fetched when the webhook
// left it out, its cost is recorded, and it goes to the store it belongs to. Two ways lead to a store:
//
//   a store's own account (its email address): the account's store answers (store.ts)
//   the shared WhatsApp demo number, whose codes bind a phone to a store (demo.ts)
//
// Anything else (mail to an address no store has connected) is recorded and not answered.

export type { RouteResult };
export { adapterFor };

export async function handleInbound(app: App, inbound: Inbound): Promise<RouteResult> {
  const adapter = adapterFor(app, inbound.channel);
  if (inbound.report) {
    await app.db.query('INSERT INTO mail_suppressed (address, reason) VALUES ($1, $2) ON CONFLICT (address) DO UPDATE SET reason = EXCLUDED.reason, at = now()', [inbound.from, inbound.report]);
    await event(app.db, null, `mail_${inbound.report}`, { address: inbound.from });
    return { action: 'suppressed' };
  }
  if (await app.db.one('SELECT 1 FROM messages WHERE ext_id = $1', [inbound.id])) return { action: 'duplicate' };
  const msg = adapter.complete && inbound.pending ? await adapter.complete(inbound) : inbound;
  const { tag, kind } = LEDGER[adapter.channel];
  await usage(app.db, { kind, backend: adapter.kind, units: 1, usd: adapter.inboundUsd, apiUsd: adapter.inboundUsd, tag: `${tag}_in` });
  const account = msg.account ? await accountFor(app, adapter.channel, msg.account) : null;
  if (account) return storeChannel(app, adapter, msg, account);
  if (adapter.channel === 'whatsapp') return demoNumber(app, adapter, msg);
  await event(app.db, null, `${tag}_unknown_account`, { account: msg.account || null });
  return { action: 'unknown_account' };
}
