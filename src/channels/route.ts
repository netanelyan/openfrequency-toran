import type { App } from '../app.ts';
import { event, usage } from '../db/log.ts';
import { adapterFor, adapterOf } from './adapters.ts';
import { heldForReconnect, markLive, needsReconnect } from './waStore.ts';
import { lineNumber, lineOf, metaLinesAdapter } from './lines.ts';
import { GraphError, TOKEN_GONE } from './meta.ts';
import { demoNumber, type RouteResult } from './demo.ts';
import { ownerLine } from '../owners/line.ts';
import { LEDGER } from './send.ts';
import { accountFor, storeChannel } from './store.ts';
import { receivingAccount } from './mailDomain.ts';
import { enabledChannels, type AnyChannel } from './config.ts';
import { isSocial } from './social.ts';
import type { Inbound } from './types.ts';

// Every inbound message, from any channel, comes through here (from the worker's queue): a provider's report about an
// address is recorded, a delivery already handled is dropped, the rest of the message is fetched when the webhook
// left it out, its cost is recorded, and it goes to the store it belongs to. Two ways lead to a store:
//
//   a store's own account (its email address, WhatsApp number, Facebook Page or Instagram account, or mail to the
//   receiving subdomain of its own domain): the account's store answers (store.ts); while its WhatsApp token needs
//   connecting again, the message waits for the owner
//   the owner line (TORAN_ASSISTANT_WA): business owners talking to their assistant (owners/line.ts)
//   the shared WhatsApp demo number, whose codes bind a phone to a store (demo.ts)
//
// The owner line and the demo number come through Twilio, or through Meta when META_OWNER_PHONE_ID or
// META_DEMO_PHONE_ID names them (lines.ts); either way they reach the same two functions.
//
// Anything else (mail to an address no store has connected) is recorded and not answered.

export type { RouteResult };
export { adapterFor };

/** Was this written to the owner line? Only when its number is set and is not the demo number too. */
export function isOwnerLine(env: Record<string, string | undefined>, to: string | null | undefined): boolean {
  const line = String(env.TORAN_ASSISTANT_WA || '').replace(/\D/g, '');
  return Boolean(line && to && to === line && line !== String(env.TWILIO_WHATSAPP_FROM || '').replace(/\D/g, ''));
}

export async function handleInbound(app: App, inbound: Inbound): Promise<RouteResult> {
  // Our own demo number or owner line on Meta (lines.ts): Meta names the number by its id, as it does a store's, but
  // it is ours, so it is routed to that line before any store's account is looked at, and answered through the Cloud
  // API from the same number. It is written to the number the line is known by, so what follows is Twilio's path.
  const line = (inbound.channel || 'whatsapp') === 'whatsapp' && inbound.account ? lineOf(app.env, inbound.account) : null;
  // A message to a store's own WhatsApp number, Page or Instagram account (Meta) carries the account's id, and goes
  // through that account's adapter. Messenger and Instagram have nothing else: an account no store has, or a channel
  // whose code was turned off since, is recorded and not answered.
  const social = isSocial(inbound.channel);
  if (social && !enabledChannels(app.env).has(inbound.channel as AnyChannel)) return { action: 'unknown_account' };
  const own = !line && (inbound.channel === 'whatsapp' || social) && inbound.account ? await accountFor(app, inbound.channel!, inbound.account) : null;
  if (!line && ((inbound.channel === 'whatsapp' && inbound.account && !own) || (social && !own))) {
    await event(app.db, null, `${LEDGER[inbound.channel!].tag}_unknown_account`, { account: inbound.account || null });
    return { action: 'unknown_account' };
  }
  const adapter = line ? metaLinesAdapter(app) : own ? adapterOf(app, inbound.channel!, own) : adapterFor(app, inbound.channel);
  if (inbound.report) {
    await app.db.query('INSERT INTO mail_suppressed (address, reason) VALUES ($1, $2) ON CONFLICT (address) DO UPDATE SET reason = EXCLUDED.reason, at = now()', [inbound.from, inbound.report]);
    await event(app.db, null, `mail_${inbound.report}`, { address: inbound.from });
    return { action: 'suppressed' };
  }
  if (await app.db.one('SELECT 1 FROM messages WHERE ext_id = $1', [inbound.id])) return { action: 'duplicate' };
  const msg = adapter.complete && inbound.pending ? await adapter.complete(inbound) : inbound;
  const { tag, kind } = LEDGER[adapter.channel];
  await usage(app.db, { kind, backend: adapter.kind, units: 1, usd: adapter.inboundUsd, apiUsd: adapter.inboundUsd, tag: `${tag}_in` });
  if (line) {
    const ours = { ...msg, channel: 'whatsapp' as const, to: lineNumber(app.env, line) || msg.to || null };
    if (line === 'owner') {
      const r = await ownerLine(app, adapter, ours);
      return { action: r.action === 'assistant' || r.action === 'duplicate' ? r.action : 'owner_line', storeId: r.storeId ?? undefined, reply: r.reply };
    }
    return demoNumber(app, adapter, ours);
  }
  // Mail to a store's own receiving subdomain (its MX, mailDomain.ts) belongs to the store's email account.
  const account = own || (msg.account ? (await accountFor(app, adapter.channel, msg.account)) || (adapter.channel === 'email' ? await receivingAccount(app, msg.account) : null) : null);
  if (account) {
    if (account.status === 'pending') await markLive(app, account.id, account.store_id);
    // The store's token ended (waStore.ts): Toran cannot answer, so the message waits for the owner, said so.
    if (account.status === 'reconnect') return heldForReconnect(app, adapter, msg, account);
    try {
      return await storeChannel(app, adapter, msg, account);
    } catch (e: any) {
      // Meta refused the token while answering: the number needs connecting again, and this message is the owner's.
      if (!(e instanceof GraphError && e.code === TOKEN_GONE && adapter.channel === 'whatsapp')) throw e;
      await needsReconnect(app, account.id, 'token');
      return heldForReconnect(app, adapter, msg, account);
    }
  }
  if (adapter.channel === 'whatsapp' && isOwnerLine(app.env, msg.to)) {
    const r = await ownerLine(app, adapter, msg);
    return { action: r.action === 'assistant' || r.action === 'duplicate' ? r.action : 'owner_line', storeId: r.storeId ?? undefined, reply: r.reply };
  }
  if (adapter.channel === 'whatsapp') return demoNumber(app, adapter, msg);
  await event(app.db, null, `${tag}_unknown_account`, { account: msg.account || null });
  return { action: 'unknown_account' };
}
