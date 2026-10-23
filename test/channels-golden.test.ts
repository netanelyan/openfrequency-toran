import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { buildPitch } from '../src/pitch/build.ts';
import { handleInbound } from '../src/wa/router.ts';
import { enqueue } from '../src/jobs/queue.ts';
import { drain } from '../src/jobs/worker.ts';
import { J } from '../src/db/index.ts';
import { testApp } from './helpers.ts';

// The WhatsApp demo, end to end, against a snapshot taken before the channel layer (src/channels/) existed: every
// router outcome in one scripted run, and everything it sent and wrote. Moving WhatsApp behind the adapter must leave
// this byte for byte the same. GOLDEN_WRITE=1 rewrites the snapshot; do that only on purpose, and say why in the commit.

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'channels-golden.json');
const P1 = '972500000101';
const P2 = '972500000202';
const P3 = '972500000303';
const OWNER = '972500000404';

async function run() {
  const app = await testApp();
  app.env.TORAN_OWNER_WHATSAPP = OWNER;
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const a = (await app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!.id;
  await ingestStore(app, a);
  const b = (await app.db.one<{ id: number }>(
    "INSERT INTO stores (domain, url, name, platform, source, slug, brand, ingested_at) VALUES ('wood-and-thread.example', 'https://wood-and-thread.example/', 'עץ וחוט', 'shopify', 'seed', 'wood-x1y2', $1::jsonb, now()) RETURNING id",
    [J({ name: 'עץ וחוט', colors: ['#2e5e4e'] })],
  ))!.id;
  for (const [i, title, price] of [[1, 'קערת עץ זית', 140], [2, 'מגש עץ אלון', 210]] as const) {
    await app.db.query("INSERT INTO products (store_id, ext_id, handle, title, url, image, price_min, price_max, available, variants, search_text) VALUES ($1, $2, $3, $4, $5, '/static/demo/x.svg', $6, $6, true, $7::jsonb, $8)", [b, `w${i}`, `w-${i}`, title, `https://wood-and-thread.example/products/w-${i}`, price, J([{ id: `wv${i}`, title: 'Default Title', price, available: true }]), title]);
  }
  const codeA = (await buildPitch(app, a)).code;
  const codeB = (await buildPitch(app, b)).code;
  await app.db.query("UPDATE stores SET status = 'sent' WHERE id = $1", [a]);

  // Only what the run itself writes: the ingest and the pitch build before it are not the router's.
  const mark = (await app.db.one<{ u: number; e: number; m: number }>('SELECT (SELECT COALESCE(MAX(id), 0) FROM usage)::int AS u, (SELECT COALESCE(MAX(id), 0) FROM events)::int AS e, (SELECT COALESCE(MAX(id), 0) FROM messages)::int AS m'))!;
  let seq = 0;
  const steps: unknown[] = [];
  const say = async (from: string, text: string, id = `g${seq++}`) => steps.push(await handleInbound(app, { from, text, id }));

  await say(P1, `${codeA} היי, אני רוצה לנסות את העוזר של כלי חרס של נורית`); // bound, welcome
  await say(P1, 'יש לכם קערה?'); // answered
  await say(P1, 'כמה עולה משלוח?'); // answered, from a policy
  await say(P1, 'יש לכם קערה?', 'g1'); // duplicate
  await say(P2, 'DEMO-ZZZZ'); // bad code
  await say(P2, `${codeB} יש מגש?`); // bound, and the rest answered at once
  await say(P2, '   '); // no text
  await say(P3, 'שלום, כמה עולה ספל?'); // no binding
  await say(OWNER, codeB); // the owner: bound, the store's status stays
  const convP2 = (await app.db.one<{ id: number }>('SELECT id FROM conversations WHERE peer = $1', [P2]))!.id;
  for (let i = 0; i < 40; i++) await app.db.query("INSERT INTO messages (conversation_id, role, text) VALUES ($1, 'agent', 'x')", [convP2]);
  await say(P2, 'ועוד שאלה?'); // the daily limit
  await app.db.query("UPDATE wa_users SET expires_at = now() - interval '1 minute' WHERE phone = $1", [P1]);
  await say(P1, 'עוד שאלה'); // expired
  await enqueue(app.db, 'wa_inbound', { from: OWNER, text: 'יש מגש?', id: 'g-queued' }, { dedupeKey: 'wa:g-queued' });
  await drain(app, { kinds: ['wa_inbound'] }); // through the worker

  const q = (sql: string) => app.db.query<any>(sql);
  const snapshot = {
    steps,
    outbox: app.wa.outbox!.map(({ to, text, inReplyTo }) => ({ to, text, inReplyTo })),
    stores: await q('SELECT id, status, demo_started_at IS NOT NULL AS demo_started FROM stores ORDER BY id'),
    wa_users: await q('SELECT phone, store_id, code, last_inbound_at IS NOT NULL AS inbound FROM wa_users ORDER BY phone'),
    conversations: await q("SELECT id, store_id, channel, peer, handoffs, misses, closed_at FROM conversations WHERE channel = 'whatsapp' ORDER BY id"),
    messages: await q(`SELECT id, conversation_id, role, text, raw_text, tools, guard, handoff, miss, ext_id FROM messages WHERE id > ${mark.m} ORDER BY id`),
    events: await q(`SELECT store_id, kind, data FROM events WHERE id > ${mark.e} ORDER BY id`),
    usage: await q(`SELECT store_id, conversation_id, kind, backend, model, units, usd::float AS usd, api_usd::float AS api_usd, tag FROM usage WHERE id > ${mark.u} ORDER BY id`),
    jobs: await q("SELECT kind, status, result FROM jobs WHERE kind = 'wa_inbound' ORDER BY id"),
  };
  await app.db.close();
  // Timestamps inside ids (sim-out-<ms>-<n>) and the random demo codes are the only things allowed to differ between runs.
  return JSON.parse(JSON.stringify(snapshot).replace(/\d{13}/g, '<ms>').replaceAll(codeA, 'DEMO-<A>').replaceAll(codeB, 'DEMO-<B>'));
}

test('the WhatsApp demo sends and writes exactly what it did before the channel layer', async () => {
  const got = await run();
  if (process.env.GOLDEN_WRITE === '1' || !existsSync(FIXTURE)) {
    assert.ok(process.env.GOLDEN_WRITE === '1', `the snapshot ${FIXTURE} is missing: run with GOLDEN_WRITE=1 to take it`);
    mkdirSync(path.dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, `${JSON.stringify(got, null, 2)}\n`);
    return;
  }
  assert.deepEqual(got, JSON.parse(readFileSync(FIXTURE, 'utf8')));
});
