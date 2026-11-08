import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { simEmail } from '../src/channels/email.ts';
import { storeAddress } from '../src/channels/config.ts';
import { enqueue } from '../src/jobs/queue.ts';
import { drain } from '../src/jobs/worker.ts';
import { isLive, liveOf, liveState, setLive } from '../src/golive.ts';
import type { Block, TurnReq } from '../src/agent/llm/types.ts';
import { testApp } from './helpers.ts';

// Going live, one press (golive.ts, migration 063; TORAN-READINESS.md P1-7): a customer's store starts switched off,
// and until its owner switches Toran on, a message on the store's own channels waits for the owner and Toran says
// nothing; pausing stops it again, and switching on again answers the next message.

const DOMAIN = 'in.toran.test';
let seq = 0;

async function mailStore() {
  const calls: TurnReq[] = [];
  const app = await testApp({ script: (req) => (calls.push(req), [{ type: 'text', text: 'כן, יש לנו קערות.' } as Block]) });
  app.env.TORAN_CHANNELS = 'whatsapp,email';
  app.mail = simEmail({ domain: DOMAIN });
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const store = (await app.db.one<{ id: number; slug: string }>("SELECT id, slug FROM stores WHERE domain = 'kli-cheres.example'"))!;
  await ingestStore(app, store.id);
  const address = storeAddress(store, DOMAIN);
  await app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', 'sim', $2, 'כלי חרס')", [store.id, address]);
  calls.splice(0);
  const mail = () => simEmail({ domain: DOMAIN }).parse({ raw: JSON.stringify({ from: 'Dana <dana@example.test>', to: [address], subject: 'שאלה', text: 'יש לכם קערה?', message_id: `<g${seq++}@example.test>` }), form: {}, headers: {}, url: '' })![0];
  const send = async () => {
    await enqueue(app.db, 'mail_inbound', mail());
    await drain(app, { kinds: ['mail_inbound'] });
  };
  return { app, storeId: store.id, calls, send };
}

test('the state from the row: never, live or paused', () => {
  assert.equal(liveState(null), 'never');
  assert.equal(liveState({ agent_live_at: null }), 'never');
  assert.equal(liveState({ agent_live_at: '2026-11-08T10:00:00Z', agent_paused_at: null }), 'live');
  assert.equal(liveState({ agent_live_at: '2026-11-08T10:00:00Z', agent_paused_at: '2026-11-09T10:00:00Z' }), 'paused');
  assert.equal(isLive({ agent_live_at: '2026-11-08T10:00:00Z' }), true);
  assert.equal(isLive({ agent_live_at: null, agent_paused_at: null }), false);
});

test('switched off, a message waits for the owner and Toran says nothing; on, it answers; paused, it waits again', async () => {
  const s = await mailStore();
  try {
    assert.equal((await liveOf(s.app, s.storeId)).state, 'live', 'a store is live from the start, as before');
    await s.app.db.query('UPDATE stores SET agent_live_at = NULL WHERE id = $1', [s.storeId]); // as a customer's store starts
    assert.equal(await setLive(s.app, s.storeId, false, 'owner'), 'never', 'pausing one that never went live does nothing');

    await s.send();
    await s.send();
    assert.equal(s.calls.length, 0, 'no model call');
    assert.equal(s.app.mail!.outbox!.length, 0, 'nothing to the customer');
    const notes = await s.app.db.query<any>("SELECT text FROM messages WHERE role = 'system' AND handoff->>'reason' = 'not_live'");
    assert.equal(notes.length, 1, 'one note for the owner a conversation, not one a message');
    assert.match(notes[0].text, /תורן עוד לא הופעל בחנות/);
    assert.equal((await s.app.db.query("SELECT 1 FROM messages WHERE role = 'customer'")).length, 2, 'both messages kept for the owner');

    assert.equal(await setLive(s.app, s.storeId, true, 'owner@example.test'), 'live');
    const on = await liveOf(s.app, s.storeId);
    assert.ok(on.liveAt && !on.pausedAt);
    assert.ok(await s.app.db.one("SELECT 1 FROM audit WHERE action = 'toran_went_live' AND actor = 'owner@example.test'"));
    await s.send();
    assert.equal(s.calls.length, 1, 'answered once switched on');
    assert.equal(s.app.mail!.outbox!.length, 1);

    assert.equal(await setLive(s.app, s.storeId, false, 'owner'), 'paused');
    await s.send();
    assert.equal(s.calls.length, 1, 'paused: no model call');
    assert.match((await s.app.db.one<any>("SELECT text FROM messages WHERE handoff->>'reason' = 'not_live' ORDER BY id DESC LIMIT 1")).text, /תורן מושהה בחנות|תורן עוד לא הופעל/);
    assert.equal(await setLive(s.app, s.storeId, true, 'owner'), 'live');
    assert.equal((await liveOf(s.app, s.storeId)).liveAt, on.liveAt, 'the first day stays the first day');
    assert.ok(await s.app.db.one("SELECT 1 FROM audit WHERE action = 'toran_resumed'"));
  } finally {
    await s.app.db.close();
  }
});
