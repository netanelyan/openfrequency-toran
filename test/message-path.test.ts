import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { buildPitch } from '../src/pitch/build.ts';
import { handleInbound } from '../src/channels/route.ts';
import { simEmail } from '../src/channels/email.ts';
import { storeAddress } from '../src/channels/config.ts';
import { closeSilent, forgetTracking, openConversation, withoutTracking } from '../src/channels/conversations.ts';
import { DuplicateTurn, conversationFor, runTurn, MAX_TEXT } from '../src/agent/loop.ts';
import { forgetMonthSpend, storeCapUsd } from '../src/agent/spend.ts';
import { scriptedClient, type Script } from '../src/agent/llm/scripted.ts';
import type { Block, TurnReq } from '../src/agent/llm/types.ts';
import { claim, done, enqueue, MESSAGE_KINDS, queueState, release, requeueOrphans, retryJob } from '../src/jobs/queue.ts';
import { drain, rescrapeOffsetMs, startWorker } from '../src/jobs/worker.ts';
import { dailyRetention, markServiceStopped, retention } from '../src/jobs/retention.ts';
import { interruptedSends, sendAgain } from '../src/auto/send.ts';
import { filesDir } from '../src/core/paths.ts';
import { J } from '../src/db/index.ts';
import { usage } from '../src/db/log.ts';
import type { App } from '../src/app.ts';
import { customer, testApp } from './helpers.ts';
import { serve } from './serve.ts';
import { fakeOwnerAccounts, fakeTeder } from './owner-fakes.ts';

// The message path when something fails (the readiness audit's PRA-BE-001 to -009, PRA-DB-004 to -007, PRA-AI-004 and
// -007, PRA-QA-002 and -008): the queue's order and leases, a send that fails and is sent again without a model call, a
// message that fails every attempt, the spend caps, the hourly limits, conversations started once, the retention pass
// and a workspace's deletion. Faults are switched on per test on the simulators; `due()` brings a retry's time forward,
// so a test reaches the second attempt and the last one.

const DOMAIN = 'in.toran.test';
let seq = 0;

/** Every queued job due now: a retry's backoff skipped. */
const due = (app: App) => app.db.query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'queued'");

/** The fictional store with its email connected, and the email channel on. */
async function mailStore(script?: Script, calls?: TurnReq[]) {
  const app = await testApp({ script });
  app.env.TORAN_CHANNELS = 'whatsapp,email';
  app.mail = simEmail({ domain: DOMAIN });
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const s = (await app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!;
  await ingestStore(app, s.id);
  await buildPitch(app, s.id);
  const store = (await app.db.one<{ id: number; slug: string }>('SELECT id, slug FROM stores WHERE id = $1', [s.id]))!;
  const address = storeAddress(store, DOMAIN);
  await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', 'sim', $2, 'כלי חרס של נורית')", [store.id, address]);
  calls?.splice(0); // the page's sample chat asked the model too: count from here
  const mail = (o: Partial<{ from: string; subject: string; text: string; message_id: string }> = {}) =>
    simEmail({ domain: DOMAIN }).parse({ raw: JSON.stringify({ from: 'Dana <dana@example.test>', to: [address], subject: 'שאלה על קערה', text: 'יש לכם קערה?', message_id: `<m${seq++}@example.test>`, ...o }), form: {}, headers: {}, url: '' })![0];
  return { app, storeId: store.id, address, mail };
}

/** A model that counts its calls and answers in one plain sentence. */
function counting(text = 'כן, יש לנו קערות.') {
  const calls: TurnReq[] = [];
  const script: Script = (req) => {
    calls.push(req);
    return [{ type: 'text', text } as Block];
  };
  return { calls, script };
}

/** Make the adapter's send throw on the sends listed (1 = the first send from now). */
function failSends(adapter: { send: (...a: any[]) => Promise<any> }, which: number[] | 'always') {
  const real = adapter.send.bind(adapter);
  let n = 0;
  adapter.send = async (...a: any[]) => {
    n++;
    if (which === 'always' || which.includes(n)) throw new Error('the provider answered 503');
    return real(...a);
  };
}

test('the queue: a customer\'s second message waits while the first runs, others and background jobs go on; the message loops take only messages', async () => {
  const app = await testApp();
  try {
    const a1 = await enqueue(app.db, 'wa_inbound', { from: '972500000001', account: 'x', id: 'a1' });
    const a2 = await enqueue(app.db, 'wa_inbound', { from: '972500000001', account: 'x', id: 'a2' });
    const b1 = await enqueue(app.db, 'wa_inbound', { from: '972500000002', account: 'x', id: 'b1' });
    const bg = await enqueue(app.db, 'rescrape', { storeId: 1 });
    assert.equal((await claim(app.db, MESSAGE_KINDS))!.id, a1);
    assert.equal((await claim(app.db, MESSAGE_KINDS))!.id, b1, "a2 waits: a1, the same customer's, is running");
    assert.equal(await claim(app.db, MESSAGE_KINDS), null);
    assert.equal((await claim(app.db, null, { except: MESSAGE_KINDS }))!.id, bg, 'the background loop takes the re-scrape');
    await done(app.db, a1);
    assert.equal((await claim(app.db, MESSAGE_KINDS))!.id, a2, 'and once a1 is done, a2');
  } finally {
    await app.db.close();
  }
});

test('a restart: jobs another boot left running go back at once, a job past its 3-minute lease too, and neither costs an attempt', async () => {
  const app = await testApp();
  try {
    const id = await enqueue(app.db, 'rescrape', { storeId: 1 });
    await claim(app.db, null, { boot: 'old-boot' });
    assert.equal(await requeueOrphans(app.db, 'old-boot'), 0, 'its own boot keeps it');
    assert.equal(await requeueOrphans(app.db, 'new-boot'), 1);
    const back = await app.db.one<any>('SELECT status, attempts, locked_by FROM jobs WHERE id = $1', [id]);
    assert.deepEqual([back.status, back.attempts, back.locked_by], ['queued', 0, null]);

    await claim(app.db, null, { boot: 'b' });
    await app.db.query("UPDATE jobs SET locked_at = now() - interval '4 minutes' WHERE id = $1", [id]);
    const again = await claim(app.db, null, { boot: 'c' });
    assert.equal(again!.id, id, 'no heartbeat for 4 minutes: taken again');
    await release(app.db, id, 0);
    assert.equal((await app.db.one<any>('SELECT attempts FROM jobs WHERE id = $1', [id])).attempts, 1, 'released: the attempt is not counted');
  } finally {
    await app.db.close();
  }
});

test('a daily re-scrape gets its own offset of up to six hours, the same each day', () => {
  const offsets = [1, 2, 3, 95, 1000].map(rescrapeOffsetMs);
  for (const o of offsets) assert.ok(o >= 0 && o < 6 * 3_600_000);
  assert.ok(new Set(offsets).size > 3);
  assert.equal(rescrapeOffsetMs(95), rescrapeOffsetMs(95));
});

test('a send that fails is retried as a send: the answer written the first time goes out once, with no second model call', async () => {
  const m = counting();
  const s = await mailStore(m.script, m.calls);
  try {
    failSends(s.app.mail!, [1]);
    await enqueue(s.app.db, 'mail_inbound', s.mail());
    await drain(s.app, { kinds: ['mail_inbound'] });
    assert.equal(s.app.mail!.outbox!.length, 0);
    assert.equal(m.calls.length, 1);
    const answer = await s.app.db.one<any>("SELECT id, delivery, reply_to FROM messages WHERE role = 'agent' AND reply_to IS NOT NULL");
    assert.ok(answer.reply_to, 'the answer knows which message it answers');
    assert.equal(answer.delivery, null);
    await due(s.app);
    await drain(s.app, { kinds: ['mail_inbound'] });
    assert.equal(s.app.mail!.outbox!.length, 1, 'sent once');
    assert.equal(m.calls.length, 1, 'no second model call');
    assert.equal((await s.app.db.one<any>("SELECT delivery FROM messages WHERE reply_to = $1", [answer.reply_to])).delivery.length, 1);
    assert.equal((await s.app.db.one<any>("SELECT COUNT(*)::int AS n FROM messages WHERE reply_to = $1", [answer.reply_to])).n, 1);
    assert.equal((await s.app.db.one<any>("SELECT status FROM jobs WHERE kind = 'mail_inbound'")).status, 'done');
    // The same message once more (a webhook delivered twice): nothing is sent again.
    assert.equal((await handleInbound(s.app, { ...s.mail(), id: answer.reply_to, channel: 'email' })).action, 'duplicate');
    assert.equal(s.app.mail!.outbox!.length, 1);
  } finally {
    await s.app.db.close();
  }
});

test('an answer in parts that stops after the first: a retry sends only the parts that did not go out', async () => {
  const long = `${'א'.repeat(1500)} ${'ב'.repeat(1500)}`;
  const m = counting(long);
  const app = await testApp({ script: m.script });
  try {
    const { storeId } = await (await import('../src/demoSeed.ts')).seedDemo(app, { conversation: false });
    const acc = (await app.db.one<{ id: number }>("INSERT INTO channel_accounts (store_id, channel, kind, external_id) VALUES ($1, 'whatsapp', 'sim', '972500000555') RETURNING id", [storeId]))!;
    m.calls.splice(0);
    const { storeChannel, accountFor } = await import('../src/channels/store.ts');
    const account = (await accountFor(app, 'whatsapp', '972500000555'))!;
    failSends(app.wa, [2]);
    const inbound = { channel: 'whatsapp' as const, from: '972500000777', text: 'שאלה ארוכה', id: 'part-1', at: Date.now(), account: '972500000555' };
    await assert.rejects(storeChannel(app, app.wa, inbound, account));
    assert.equal(app.wa.outbox!.length, 1, 'the first part went out');
    assert.equal((await app.db.one<any>("SELECT delivery FROM messages WHERE reply_to = 'part-1'")).delivery.length, 1, 'and it is written down');
    const r = await handleInbound(app, inbound);
    assert.equal(r.action, 'resent');
    assert.equal(app.wa.outbox!.length, 2, 'only the second part again');
    assert.equal(m.calls.length, 1);
    assert.ok(acc.id);
  } finally {
    await app.db.close();
  }
});

test('a message that fails every attempt is not lost: it waits in its conversation with a handoff, the operator hears, and the operator can run it again', async () => {
  const s = await mailStore(counting().script);
  try {
    failSends(s.app.mail!, 'always');
    const id = await enqueue(s.app.db, 'mail_inbound', s.mail({ text: 'מתי זה מגיע?' }));
    for (let i = 0; i < 3; i++) {
      await drain(s.app, { kinds: ['mail_inbound'] });
      await due(s.app);
    }
    assert.equal((await s.app.db.one<any>('SELECT status, attempts FROM jobs WHERE id = $1', [id])).status, 'failed');
    const conv = (await s.app.db.one<any>("SELECT id FROM conversations WHERE channel = 'email'")).id;
    const msgs = await s.app.db.query<any>('SELECT role, text, handoff FROM messages WHERE conversation_id = $1 ORDER BY id', [conv]);
    assert.ok(msgs.some((x) => x.role === 'customer' && x.text === 'מתי זה מגיע?'));
    const h = msgs.find((x) => x.role === 'system' && x.handoff?.reason === 'failed');
    assert.ok(h, 'a handoff for the owner');
    assert.match(h.text, /לא הגיעה ללקוח/);
    assert.ok(await s.app.db.one("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' = $1", [`lost:${id}`]));
    const q = await queueState(s.app.db);
    assert.equal(q.failed.length, 1);
    assert.equal(await retryJob(s.app.db, id), true);
    assert.equal((await s.app.db.one<any>('SELECT status FROM jobs WHERE id = $1', [id])).status, 'queued');
  } finally {
    await s.app.db.close();
  }
});

test('N worker loops at once: every message is answered once, a customer\'s two in order, and a stop puts back nothing half done', async () => {
  const m = counting();
  const s = await mailStore(m.script, m.calls);
  try {
    for (const from of ['a@example.test', 'b@example.test', 'c@example.test']) {
      await enqueue(s.app.db, 'mail_inbound', s.mail({ from, text: `שאלה 1 מ-${from}` }));
      await enqueue(s.app.db, 'mail_inbound', s.mail({ from, text: `שאלה 2 מ-${from}`, subject: 'Re: שאלה על קערה' }));
    }
    const w = startWorker(s.app, { messageLoops: 4, backgroundLoops: 1, idleMs: 20, scheduler: false, boot: 'test-boot' });
    for (let i = 0; i < 300; i++) {
      const left = await s.app.db.one<any>("SELECT COUNT(*)::int AS n FROM jobs WHERE status IN ('queued', 'running')");
      if (!left.n) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await w.stop({ graceMs: 2000 });
    assert.equal(s.app.mail!.outbox!.length, 6);
    assert.equal(m.calls.length, 6);
    for (const from of ['a@example.test', 'b@example.test', 'c@example.test']) {
      const order = s.app.mail!.outbox!.filter((o) => o.to === from).map((o) => o.at);
      assert.equal(order.length, 2);
    }
    assert.equal((await s.app.db.one<any>("SELECT COUNT(*)::int AS n FROM jobs WHERE status <> 'done'")).n, 0);
  } finally {
    await s.app.db.close();
  }
});

test('two messages of a new customer at once start one conversation; a week of silence closes the old one and starts a new one', async () => {
  const app = await testApp();
  try {
    const { storeId } = await (await import('../src/demoSeed.ts')).seedDemo(app, { conversation: false });
    const acc = (await app.db.one<{ id: number }>("INSERT INTO channel_accounts (store_id, channel, kind, external_id) VALUES ($1, 'whatsapp', 'sim', '972500000556') RETURNING id", [storeId]))!.id;
    // Meta's profile name is slow: the gap where two lookups used to both find nothing.
    const meta = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { name: 'דנה' };
    };
    const [a, b] = await Promise.all([1, 2].map(() => openConversation(app.db, { storeId, channel: 'whatsapp', peer: '972500000888', accountId: acc, meta })));
    assert.equal(a.id, b.id);
    assert.equal((await app.db.one<any>('SELECT COUNT(*)::int AS n FROM conversations WHERE account_id = $1', [acc])).n, 1);
    await assert.rejects(app.db.query("INSERT INTO conversations (store_id, channel, peer, account_id) VALUES ($1, 'whatsapp', '972500000888', $2)", [storeId, acc]), 'the partial unique index is the second guard');
    await app.db.query("UPDATE conversations SET last_at = now() - interval '8 days' WHERE id = $1", [a.id]);
    const c = await openConversation(app.db, { storeId, channel: 'whatsapp', peer: '972500000888', accountId: acc });
    assert.notEqual(c.id, a.id);
    assert.ok((await app.db.one<any>('SELECT closed_at FROM conversations WHERE id = $1', [a.id])).closed_at, 'the old one is closed');
    // The demo number's conversations (no account) the same.
    const [d1, d2] = await Promise.all([conversationFor(app.db, storeId, 'whatsapp', '972500000999'), conversationFor(app.db, storeId, 'whatsapp', '972500000999')]);
    assert.equal(d1, d2);
  } finally {
    await app.db.close();
  }
});

test('an order lookup\'s tracking number and link are taken out when its conversation closes; the status words stay', async () => {
  const app = await testApp();
  try {
    const result = 'Order #1001, placed 1.10: shipped.\nShipments:\n- in transit, with Israel Post, tracking number RR123456789IL, tracking link: https://track.example/RR123\nRule: tell the customer this status in your own short words, with the tracking link exactly as written when there is one. A delivery date...';
    assert.equal(withoutTracking(result).includes('RR123456789IL'), false);
    assert.equal(withoutTracking(result).includes('https://track.example'), false);
    assert.match(withoutTracking(result), /in transit, with Israel Post/);
    const { storeId } = await (await import('../src/demoSeed.ts')).seedDemo(app, { conversation: false });
    const conv = await conversationFor(app.db, storeId, 'whatsapp', '972500000444');
    await app.db.query("INSERT INTO messages (conversation_id, role, text, tools) VALUES ($1, 'agent', 'נשלחה', $2::jsonb)", [conv, J([{ name: 'get_order_status', input: { order: '1001' }, ok: true, result }])]);
    await app.db.query("UPDATE conversations SET last_at = now() - interval '15 days' WHERE id = $1", [conv]);
    assert.equal(await closeSilent(app.db, 14), 1);
    const kept = (await app.db.one<any>("SELECT tools FROM messages WHERE conversation_id = $1 AND role = 'agent'", [conv])).tools[0].result;
    assert.equal(kept.includes('RR123456789IL'), false);
    assert.match(kept, /shipped/);
    assert.equal(await forgetTracking(app.db, [conv]), 0, 'nothing left to take out');
  } finally {
    await app.db.close();
  }
});

test('the store\'s spend cap: past it that store hands off with no model call, while another store still answers; 80% is said to the operator', async () => {
  const m = counting();
  const app = await testApp();
  app.llm = scriptedClient(m.script, { as: 'api', usd: 0.01 });
  try {
    const { storeId } = await (await import('../src/demoSeed.ts')).seedDemo(app, { conversation: false });
    m.calls.splice(0);
    assert.equal(storeCapUsd({}, {}), 150, '300 conversations, twice, at $0.25');
    assert.equal(storeCapUsd({}, { plan: 'big' }), 750);
    assert.equal(storeCapUsd({}, { capUsd: 20 }), 20, "the operator's own number");
    await usage(app.db, { storeId, kind: 'llm', usd: 121, tag: 'agent' });
    const conv = await conversationFor(app.db, storeId, 'whatsapp', '972500000301');
    const first = await runTurn(app, { storeId, conversationId: conv, text: 'יש קערה?', extId: 'cap-1' });
    assert.equal(m.calls.length, 1, 'under the cap: answered');
    assert.equal(first.handoff, null);
    assert.ok(await app.db.one("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' LIKE 'cap80:store:%'"), '80%: the operator hears');
    await usage(app.db, { storeId, kind: 'llm', usd: 30, tag: 'agent' });
    const capped = await runTurn(app, { storeId, conversationId: conv, text: 'ועוד שאלה', extId: 'cap-2' });
    assert.equal(m.calls.length, 1, 'past the cap: no model call');
    assert.match(String(capped.handoff?.summary), /store's spend cap/);
    // Another store is not stopped by this one.
    const other = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, source, platform) VALUES ('other.example', 'https://other.example/', 'אחרת', 'manual', 'shopify') RETURNING id"))!.id;
    const conv2 = await conversationFor(app.db, other, 'whatsapp', '972500000302');
    await runTurn(app, { storeId: other, conversationId: conv2, text: 'שלום', extId: 'cap-3' });
    assert.equal(m.calls.length, 2);
  } finally {
    await app.db.close();
  }
});

test('the monthly cap over every store: reached, a message gets the holding line and a handoff, no model call; last month\'s spend does not count', async () => {
  const m = counting();
  const app = await testApp();
  app.llm = scriptedClient(m.script, { as: 'api', usd: 0 });
  app.env.TORAN_MONTHLY_CAP_USD = '1';
  try {
    const { storeId } = await (await import('../src/demoSeed.ts')).seedDemo(app, { conversation: false });
    m.calls.splice(0);
    await app.db.query("INSERT INTO usage (at, kind, usd, api_usd, tag) VALUES (date_trunc('month', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem' - interval '2 days', 'llm', 5, 5, 'agent')");
    forgetMonthSpend();
    const conv = await conversationFor(app.db, storeId, 'whatsapp', '972500000303');
    await runTurn(app, { storeId, conversationId: conv, text: 'שאלה', extId: 'g-1' });
    assert.equal(m.calls.length, 1, "last month's $5 does not count");
    await app.db.query("INSERT INTO usage (kind, usd, api_usd, tag) VALUES ('llm', 1, 1, 'agent')");
    forgetMonthSpend();
    const out = await runTurn(app, { storeId, conversationId: conv, text: 'עוד', extId: 'g-2' });
    assert.equal(m.calls.length, 1);
    assert.match(String(out.handoff?.summary), /monthly spend cap/);
    assert.ok(out.reply.length > 0, 'the holding line');
  } finally {
    forgetMonthSpend();
    await app.db.close();
  }
});

test('one customer\'s 21st message of the day goes to the owner with no model call, and another customer of the same store is still answered', async () => {
  const m = counting();
  const s = await mailStore(m.script, m.calls);
  try {
    await handleInbound(s.app, { ...s.mail(), channel: 'email' });
    const conv = (await s.app.db.one<any>("SELECT id FROM conversations WHERE channel = 'email'")).id;
    for (let i = 0; i < 19; i++) await s.app.db.query("INSERT INTO messages (conversation_id, role, text) VALUES ($1, 'agent', 'תשובה')", [conv]);
    const before = m.calls.length;
    const r = await handleInbound(s.app, { ...s.mail({ subject: 'Re: שאלה על קערה', text: 'ועוד אחת' }), channel: 'email' });
    assert.equal(r.action, 'limit');
    assert.equal(m.calls.length, before);
    const other = await handleInbound(s.app, { ...s.mail({ from: 'Yossi <yossi@example.test>', text: 'שלום' }), channel: 'email' });
    assert.equal(other.action, 'answered');
  } finally {
    await s.app.db.close();
  }
});

test('a store\'s hour: past its answers an hour, or a burst of new email senders, the next messages wait for the owner and the operator hears', async () => {
  const m = counting();
  const s = await mailStore(m.script, m.calls);
  s.app.env.TORAN_STORE_TURNS_PER_HOUR = '2';
  try {
    assert.equal((await handleInbound(s.app, { ...s.mail({ from: 'a@example.test' }), channel: 'email' })).action, 'answered');
    assert.equal((await handleInbound(s.app, { ...s.mail({ from: 'b@example.test' }), channel: 'email' })).action, 'answered');
    assert.equal((await handleInbound(s.app, { ...s.mail({ from: 'c@example.test' }), channel: 'email' })).action, 'limit');
    assert.ok(await s.app.db.one("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' LIKE 'busy:turns:%'"));
    s.app.env.TORAN_STORE_TURNS_PER_HOUR = '100';
    s.app.env.TORAN_NEW_SENDERS_PER_HOUR = '3';
    assert.equal((await handleInbound(s.app, { ...s.mail({ from: 'd@example.test' }), channel: 'email' })).action, 'limit', 'the fourth new address in an hour');
    assert.ok(await s.app.db.one("SELECT 1 FROM events WHERE kind = 'operator_alert' AND data->>'key' LIKE 'busy:senders:%'"));
    assert.equal((await handleInbound(s.app, { ...s.mail({ from: 'a@example.test', subject: 'Re: שאלה על קערה', text: 'תודה' }), channel: 'email' })).action, 'answered', 'someone who wrote before is answered');
  } finally {
    await s.app.db.close();
  }
});

test('a long email reaches the model cut to 4,000 characters, and the owner keeps all of it; a turn past its deadline hands off', async () => {
  const m = counting();
  const s = await mailStore(m.script, m.calls);
  try {
    const long = `שאלה: ${'מילה '.repeat(2400)}`;
    await handleInbound(s.app, { ...s.mail({ text: long }), channel: 'email' });
    // A message's content is a string, or blocks (the app's line and the customer's text go as blocks of their own).
    const sent = m.calls[0].messages.map((x) => (typeof x.content === 'string' ? x.content : x.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('\n'))).join('\n');
    assert.ok(sent.length < MAX_TEXT + 1000, `the model got ${sent.length} characters`);
    assert.match(sent, /is not shown/);
    assert.equal((await s.app.db.one<any>("SELECT m.text FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'customer' AND c.channel = 'email'")).text.length, long.trim().length);

    s.app.env.TORAN_TURN_DEADLINE_MS = '1500';
    s.app.llm = scriptedClient(async () => {
      await new Promise((r) => setTimeout(r, 900));
      return [{ type: 'tool_use', id: `slow${seq++}`, name: 'search_products', input: { query: 'קערה' } }];
    });
    const conv = (await s.app.db.one<any>("SELECT id FROM conversations WHERE channel = 'email'")).id;
    const out = await runTurn(s.app, { storeId: s.storeId, conversationId: conv, text: 'עוד שאלה', channel: 'email', footer: false });
    assert.match(String(out.handoff?.summary), /no answer within 2 seconds/);
  } finally {
    await s.app.db.close();
  }
});

test('the same message answered twice is caught inside the conversation\'s lock', async () => {
  const app = await testApp({ script: counting().script });
  try {
    const { storeId } = await (await import('../src/demoSeed.ts')).seedDemo(app, { conversation: false });
    const conv = await conversationFor(app.db, storeId, 'whatsapp', '972500000305');
    await runTurn(app, { storeId, conversationId: conv, text: 'שלום', extId: 'dup-1' });
    await assert.rejects(runTurn(app, { storeId, conversationId: conv, text: 'שלום', extId: 'dup-1' }), DuplicateTurn);
  } finally {
    await app.db.close();
  }
});

test('the owner line: an answer that failed to go out is sent when the message comes again, and nothing is acted on twice', async () => {
  const app = await testApp();
  const accounts = await fakeOwnerAccounts();
  const teder = await fakeTeder();
  Object.assign(app.env, accounts.env, teder.env, { TORAN_ASSISTANT_WA: '972500000888' });
  try {
    accounts.link({ phone: '972500000123', workspace: 7 });
    failSends(app.wa, [1]);
    const msg = { channel: 'whatsapp' as const, from: '972500000123', text: 'הפסק', id: 'own-1', at: Date.now(), to: '972500000888' };
    await assert.rejects(handleInbound(app, msg));
    assert.equal(app.wa.outbox!.length, 0);
    const consentCalls = accounts.calls.length;
    await handleInbound(app, msg);
    assert.equal(app.wa.outbox!.length, 1, 'the kept answer went out');
    assert.equal(accounts.calls.length, consentCalls, 'and the stop was not asked of accounts again');
    assert.equal((await handleInbound(app, msg)).action, 'duplicate', 'a third time: delivered already');
  } finally {
    await accounts.close();
    await teder.close();
    await app.db.close();
  }
});

test('an automatic message cut off in its send is marked not sent, never sent again by itself; a shipping one can be sent again by hand', async () => {
  const app = await testApp();
  try {
    const { storeId } = await (await import('../src/demoSeed.ts')).seedDemo(app, { conversation: false });
    const add = (message: string, key: string) => app.db.one<{ id: number }>("INSERT INTO auto_events (store_id, key, kind, message, source, happened_at, due_at, status, sending_at) VALUES ($1, $2, 'order', $3, 'poll', now(), now(), 'sending', now() - interval '11 minutes') RETURNING id", [storeId, key, message]);
    const shipped = (await add('shipped', 'k1'))!.id;
    const cart = (await add('cart', 'k2'))!.id;
    assert.equal(await interruptedSends(app), 2);
    assert.deepEqual(await app.db.one<any>('SELECT status, why FROM auto_events WHERE id = $1', [shipped]), { status: 'failed', why: 'interrupted' });
    assert.equal(await sendAgain(app, storeId, cart), false, 'a cart reminder is not sent again by hand');
    assert.equal(await sendAgain(app, storeId, shipped), true);
    assert.equal((await app.db.one<any>('SELECT status FROM auto_events WHERE id = $1', [shipped])).status, 'waiting');
  } finally {
    await app.db.close();
  }
});

test('retention: a store whose service stopped has its customers\' conversations deleted 30 days on, opt-outs kept; leads after six months; old jobs emptied and deleted; once a day', async () => {
  const s = await mailStore(counting().script);
  try {
    const { app, storeId } = s;
    await handleInbound(app, { ...s.mail(), channel: 'email' });
    await app.db.query("INSERT INTO auto_consent (store_id, channel, address, scope, state, source, at) VALUES ($1, 'email', 'dana@example.test', 'marketing', 'out', 'customer', now())", [storeId]);
    // A kept file nobody names any more, and one still named.
    const dir = path.join(filesDir(app.env), 'ab');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `ab${'0'.repeat(62)}`), 'x');
    await app.db.query("UPDATE channel_accounts SET status = 'off' WHERE store_id = $1", [storeId]);
    let r = await retention(app);
    assert.equal(r.stopped, 1, 'no channel on: the service stopped');
    assert.equal(r.conversations || 0, 0, 'nothing deleted before 30 days');
    assert.equal(r.files, 1);
    assert.equal(existsSync(path.join(dir, `ab${'0'.repeat(62)}`)), false);
    await app.db.query("UPDATE stores SET service_stopped_at = now() - interval '31 days' WHERE id = $1", [storeId]);
    await app.db.query("INSERT INTO demo_requests (code, url, domain, created_at) VALUES ('REQ-OLD001', 'https://a.example/', 'a.example', now() - interval '7 months'), ('REQ-NEW001', 'https://b.example/', 'b.example', now())");
    await app.db.query("INSERT INTO jobs (kind, payload, status, done_at) VALUES ('rescrape', '{\"storeId\": 1}', 'done', now() - interval '8 days'), ('rescrape', '{\"storeId\": 2}', 'done', now() - interval '31 days')");
    r = await retention(app);
    assert.ok(r.conversations >= 1);
    assert.equal((await app.db.one<any>('SELECT COUNT(*)::int AS n FROM conversations WHERE store_id = $1', [storeId])).n, 0);
    assert.equal((await app.db.one<any>('SELECT COUNT(*)::int AS n FROM auto_consent WHERE store_id = $1', [storeId])).n, 1, 'the opt-out stays');
    assert.equal(r.demoRequests, 1);
    assert.ok(await app.db.one("SELECT 1 FROM demo_requests WHERE code = 'REQ-NEW001'"));
    assert.ok(r.jobPayloads >= 1);
    assert.ok(r.jobs >= 1);
    assert.ok(await dailyRetention(app));
    assert.equal(await dailyRetention(app), null, 'once a day');
    // A channel on again: the service goes on.
    await app.db.query("UPDATE channel_accounts SET status = 'active' WHERE store_id = $1", [storeId]);
    await app.db.query("UPDATE stores SET service_stopped_at = now() WHERE id = $1", [storeId]);
    assert.equal((await retention(app)).resumed, 1);
    await markServiceStopped(app.db, storeId, 'plan');
    assert.equal((await retention(app)).resumed || 0, 0, "a stop by the plan is not undone by a channel");
  } finally {
    await s.app.db.close();
  }
});

test('the operator\'s queue page lists the failed jobs with a way to run each again; a customer never sees it', async () => {
  const s = await serve();
  try {
    const id = await enqueue(s.app.db, 'wa_inbound', { from: '972500000700', id: 'q1' }, { maxAttempts: 1 });
    await s.app.db.query("UPDATE jobs SET status = 'failed', attempts = 1, last_error = 'the provider answered 503', done_at = now() WHERE id = $1", [id]);
    s.login();
    const page = await (await s.get('/queue')).text();
    assert.match(page, /עבודות שנכשלו/);
    assert.match(page, /the provider answered 503/);
    assert.equal((await s.post(`/queue/${id}/again`, { _csrf: await s.csrf('/queue') })).status, 303);
    assert.equal((await s.app.db.one<any>('SELECT status FROM jobs WHERE id = $1', [id])).status, 'queued');
    s.as(s.accounts.session(customer(7)).cookie);
    assert.notEqual((await s.get('/queue')).status, 200);
    assert.equal((await s.post(`/queue/${id}/again`, { _csrf: await s.csrf('/') })).status, 403);
  } finally {
    await s.close();
  }
});
