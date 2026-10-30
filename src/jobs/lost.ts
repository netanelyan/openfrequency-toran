import type { App } from '../app.ts';
import { cleanLine } from '../core/hebrew.ts';
import { event } from '../db/log.ts';
import { adapterOf } from '../channels/adapters.ts';
import { accountFor, conversationOf, handOver } from '../channels/store.ts';
import { hold } from '../channels/owner.ts';
import { receivingAccount } from '../channels/mailDomain.ts';
import type { Channel, Inbound } from '../channels/types.ts';
import { alertOperator } from '../ops/alert.ts';
import type { Job } from './queue.ts';

// A customer's message whose job failed its last attempt (the worker, jobs/worker.ts runOne). Before, it stayed a failed
// row in the jobs table that no page showed, and the customer waited for nothing. Now:
//
//   on a store's own channel   the message goes into its conversation (if the turn never wrote it), with a handoff the
//                              owner sees in the inbox and on Today: Toran could not answer it, or its answer did not
//                              reach the customer
//   anywhere else              (the demo number, the owner line, our own line) it is recorded as an event
//
// and either way the operator hears of it, once for each job. The failed job stays on the operator's queue page, where
// it can be run again (web/pages/queue.ts): a second run is safe, a message already written is a duplicate there.

export async function lostMessage(app: App, job: Job, error: string): Promise<{ kept: 'conversation' | 'event'; conversationId?: number }> {
  const inbound = { ...(job.payload || {}), ...(job.kind === 'mail_inbound' ? { channel: 'email' } : {}) } as Inbound;
  const echo = job.kind === 'wa_echo' || job.kind === 'dm_echo';
  const channel = (inbound.channel || 'whatsapp') as Channel;
  const account = !echo && inbound.account && inbound.from ? (await accountFor(app, channel, String(inbound.account))) || (channel === 'email' ? await receivingAccount(app, String(inbound.account)) : null) : null;
  const what = echo ? 'an owner\'s own message to a customer' : `a customer's ${channel} message`;
  await alertOperator(app, `lost:${job.id}`, `הודעה שתורן לא הצליח לטפל בה (${job.kind})`, `עבודה ${job.id}, ${what}${inbound.from ? ` מ-${inbound.from}` : ''}, נכשלה ${job.attempts} פעמים: ${cleanLine(error, 300)}. אפשר להריץ אותה שוב מדף התור.`, { everyMinutes: 7 * 24 * 60, storeId: account?.store_id ?? null });
  if (!account) {
    await event(app.db, null, 'message_lost', { job: job.id, kind: job.kind, error: cleanLine(error, 200) });
    return { kept: 'event' };
  }
  let adapter;
  try {
    adapter = adapterOf(app, channel, account as any);
  } catch {
    adapter = { channel, kind: 'none', limits: { maxChars: 4096 } } as any;
  }
  // No call to Meta for the customer's name here: Meta may be why the job failed.
  const conv = await conversationOf(app, { ...adapter, profile: undefined }, account, inbound);
  const answer = inbound.id ? await app.db.one<{ id: number }>("SELECT id FROM messages WHERE reply_to = $1 AND role = 'agent'", [inbound.id]) : null;
  await hold(app, conv, inbound);
  const text = answer
    ? 'תורן כתב תשובה להודעה הזו, אבל היא לא הגיעה ללקוח גם אחרי כמה ניסיונות. כדאי לענות לו בעצמך.'
    : 'תורן לא הצליח לענות להודעה הזו גם אחרי כמה ניסיונות, אז היא מחכה לך.';
  await handOver(app, account.store_id, conv, 'failed', `job ${job.id} (${job.kind}) failed ${job.attempts} times: ${cleanLine(error, 160)}`, text);
  return { kept: 'conversation', conversationId: conv };
}
