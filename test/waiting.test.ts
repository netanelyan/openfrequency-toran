import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { simEmail } from '../src/channels/email.ts';
import { storeAddress } from '../src/channels/config.ts';
import { enqueue } from '../src/jobs/queue.ts';
import { drain } from '../src/jobs/worker.ts';
import { DIGESTS_PER_DAY, nightEnd, waitingDigest, waitingMail } from '../src/owners/waiting.ts';
import { israelWeekdayHour } from '../src/core/clock.ts';
import type { Block } from '../src/agent/llm/types.ts';
import { testApp } from './helpers.ts';
import { fakeOwnerAccounts } from './owner-fakes.ts';

// The owner hears when a customer waits (owners/waiting.ts; TORAN-READINESS.md P0-2): one email a burst, with each
// conversation's link, each conversation once in twelve hours, a few a day at most; the demo number is not the owner's.

const DOMAIN = 'in.toran.test';
let seq = 0;

async function shop() {
  const app = await testApp({ script: () => [{ type: 'text', text: 'כן.' } as Block] });
  const accounts = await fakeOwnerAccounts();
  Object.assign(app.env, accounts.env, { TORAN_CHANNELS: 'whatsapp,email', PUBLIC_BASE_URL: 'https://toran.example' });
  app.mail = simEmail({ domain: DOMAIN });
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const store = (await app.db.one<{ id: number; slug: string }>("SELECT id, slug FROM stores WHERE domain = 'kli-cheres.example'"))!;
  await ingestStore(app, store.id);
  await app.db.query('UPDATE stores SET workspace_id = 7, agent_live_at = NULL WHERE id = $1', [store.id]); // a customer's store, not switched on
  accounts.link({ phone: '972500000123', workspace: 7, products: ['toran'] });
  const address = storeAddress(store, DOMAIN);
  await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', 'sim', $2, 'כלי חרס')", [store.id, address]);
  const write = async (from: string, text: string) => {
    await enqueue(app.db, 'mail_inbound', simEmail({ domain: DOMAIN }).parse({ raw: JSON.stringify({ from, to: [address], subject: 'שאלה', text, message_id: `<w${seq++}@example.test>` }), form: {}, headers: {}, url: '' })![0]);
    await drain(app, { kinds: ['mail_inbound'] });
  };
  const digest = async () => {
    await app.db.query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE kind = 'owner_waiting' AND status = 'queued'");
    await drain(app, { kinds: ['owner_waiting'] });
  };
  const toOwner = () => app.mail!.outbox!.filter((m: any) => m.to === 'owner7@example.test' || (Array.isArray(m.to) && m.to.includes('owner7@example.test')));
  return { app, accounts, storeId: store.id, write, digest, toOwner };
}

test('two customers waiting in a few minutes are one email to the owner, each with its link; the same ones are not told again', async () => {
  const s = await shop();
  try {
    await s.write('Dana <dana@example.test>', 'אפשר לאסוף מהמחסן?');
    await s.write('Yossi <yossi@example.test>', 'יש משלוח לאילת?');
    assert.equal((await s.app.db.query("SELECT 1 FROM jobs WHERE kind = 'owner_waiting' AND status = 'queued'")).length, 1, 'one digest asked for, not two');
    await s.digest();
    const mails: any[] = s.toOwner();
    assert.equal(mails.length, 1, 'one email');
    assert.match(mails[0].subject, /2 לקוחות מחכים לתשובה שלכם ב/);
    const ids = (await s.app.db.query<{ id: number }>('SELECT id FROM conversations ORDER BY id')).map((r) => r.id);
    for (const id of ids) assert.ok(mails[0].text.includes(`https://toran.example/chat/${id}`), `the link to ${id}`);
    assert.match(mails[0].text, /אפשר לאסוף מהמחסן\?/);

    // Again within twelve hours: the same conversations are not told again.
    await s.write('Dana <dana@example.test>', 'ועוד שאלה');
    await s.digest();
    assert.equal(s.toOwner().length, 1, 'nothing new to tell');
    const r = await waitingDigest(s.app, s.storeId);
    assert.equal(r.why, 'nothing new waits');
  } finally {
    await s.accounts.close();
    await s.app.db.close();
  }
});

test('the demo number is not the owner\'s; a day has at most a few emails; the night waits for the morning', async () => {
  const s = await shop();
  try {
    // A conversation on our demo number (no account): nothing asked for.
    const demo = (await s.app.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer) VALUES ($1, 'whatsapp', '972500000999') RETURNING id", [s.storeId]))!.id;
    const { notifyWaiting } = await import('../src/owners/waiting.ts');
    await notifyWaiting(s.app, s.storeId, demo);
    assert.equal((await s.app.db.query("SELECT 1 FROM jobs WHERE kind = 'owner_waiting'")).length, 0);

    for (let i = 0; i < DIGESTS_PER_DAY; i++) await s.app.db.query("INSERT INTO events (store_id, kind, data) VALUES ($1, 'owner_digest', '{}')", [s.storeId]);
    await s.write('Dana <dana@example.test>', 'שאלה');
    assert.equal((await waitingDigest(s.app, s.storeId)).why, 'enough emails today');
    assert.equal(s.toOwner().length, 0);

    // 23:30 Israel time waits for 07:00.
    const late = Date.parse('2026-11-08T21:30:00Z'); // 23:30 in Israel (UTC+2)
    const at = nightEnd(late);
    assert.equal(israelWeekdayHour(at).hour, 7);
    assert.equal(nightEnd(Date.parse('2026-11-08T10:00:00Z')), Date.parse('2026-11-08T10:00:00Z'), 'noon is now');
  } finally {
    await s.accounts.close();
    await s.app.db.close();
  }
});

test('the email says what each customer asked, or what Toran handed over when it is in Hebrew', () => {
  const m = waitingMail('כלי חרס', [{ id: 5, peer: 'x', channel: 'email', summary: 'the guard cut price: ...', last_q: 'כמה עולה?' }], 'https://toran.example');
  assert.equal(m.subject, 'לקוח מחכה לתשובה שלכם בכלי חרס');
  assert.match(m.text, /• כמה עולה\?\n  https:\/\/toran\.example\/chat\/5/);
  assert.doesNotMatch(m.text, /guard/, 'the English line for the operator stays out');
  const he = waitingMail('כלי חרס', [{ id: 6, peer: 'x', channel: 'email', summary: 'הלקוחה שואלת על איסוף', last_q: 'x' }], 'https://toran.example');
  assert.match(he.text, /הלקוחה שואלת על איסוף/);
});
