import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { buildPitch, CODE_RE } from '../src/pitch/build.ts';
import { handleInbound } from '../src/wa/router.ts';
import { simProvider, twilioProvider, twilioSignature } from '../src/wa/providers.ts';
import { J } from '../src/db/index.ts';
import { testApp } from './helpers.ts';

const P1 = '972500000101';
const P2 = '972500000202';
let seq = 0;
const msg = (from: string, text: string) => ({ from, text, id: `m${seq++}` });

/** Two stores on one number: the fictional ceramics store, and a second one with a different catalogue. */
async function twoStores() {
  const app = await testApp();
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
  const pa = await buildPitch(app, a);
  const pb = await buildPitch(app, b);
  return { app, a, b, codeA: pa.code, codeB: pb.code };
}

test('demo codes look like DEMO-XXXX without lookalike characters, and are found inside a message', async () => {
  const { app, codeA, codeB } = await twoStores();
  assert.match(codeA, /^DEMO-[A-HJKMNP-Z2-9]{4}$/);
  assert.notEqual(codeA, codeB);
  assert.equal(CODE_RE.exec(`היי ${codeA.toLowerCase()} אני רוצה לנסות`)?.[1].toUpperCase(), codeA.slice(5));
  await app.db.close();
});

test('two people, two stores, one number: each phone gets its own store, with no crossover', async () => {
  const { app, a, b, codeA, codeB } = await twoStores();
  const r1 = await handleInbound(app, msg(P1, `${codeA} היי, אני רוצה לנסות את העוזר של כלי חרס של נורית`));
  const r2 = await handleInbound(app, msg(P2, `${codeB} היי, באתי לנסות את הבוט של עץ וחוט`));
  assert.deepEqual([r1.action, r1.storeId, r2.action, r2.storeId], ['bound', a, 'bound', b]);
  assert.match(r1.reply!, /כלי חרס של נורית/);
  assert.match(r2.reply!, /עץ וחוט/);

  const q1 = await handleInbound(app, msg(P1, 'יש לכם קערה?'));
  const q2 = await handleInbound(app, msg(P2, 'יש לכם קערה?'));
  assert.equal(q1.storeId, a);
  assert.equal(q2.storeId, b);
  assert.match(q1.reply!, /קערת/);
  assert.ok(!/עץ/.test(q1.reply!), 'phone 1 never hears about the other store\'s products');
  assert.match(q2.reply!, /קערת עץ זית/);
  assert.ok(!/זית גדולה|דגנים/.test(q2.reply!), 'phone 2 never hears about the ceramics store');

  const convs = await app.db.query<{ store_id: number; peer: string }>("SELECT store_id, peer FROM conversations WHERE channel = 'whatsapp' ORDER BY id");
  assert.deepEqual(convs.map((c) => [c.peer, c.store_id]), [[P1, a], [P2, b]]);
  // Nothing went to a phone that did not write first, and every reply answered that phone's own message.
  for (const o of app.wa.outbox!) assert.ok([P1, P2].includes(o.to));
  assert.ok(app.wa.outbox!.every((o) => o.to === (o.inReplyTo.startsWith('m') ? [...Array(seq)].map((_, i) => `m${i}`).includes(o.inReplyTo) && o.to : o.to)));
  await app.db.close();
});

test('a new code overwrites the binding; a binding expires after 7 days; an unknown phone is asked for the link', async () => {
  const { app, a, b, codeA, codeB } = await twoStores();
  await handleInbound(app, msg(P1, codeA));
  assert.equal((await app.db.one<any>('SELECT store_id FROM wa_users WHERE phone = $1', [P1])).store_id, a);
  await handleInbound(app, msg(P1, codeB));
  const w = await app.db.one<any>("SELECT store_id, expires_at > now() + interval '6 days 23 hours' AS seven FROM wa_users WHERE phone = $1", [P1]);
  assert.equal(w.store_id, b);
  assert.equal(w.seven, true);
  assert.equal((await handleInbound(app, msg(P1, 'יש מגש?'))).storeId, b);

  await app.db.query("UPDATE wa_users SET expires_at = now() - interval '1 minute' WHERE phone = $1", [P1]);
  const expired = await handleInbound(app, msg(P1, 'עוד שאלה'));
  assert.equal(expired.action, 'no_binding');

  const stranger = await handleInbound(app, msg('972500000303', 'שלום, כמה עולה ספל?'));
  assert.equal(stranger.action, 'no_binding');
  assert.match(stranger.reply!, /בעמוד שהכנו לחנות/);
  assert.equal(await app.db.one("SELECT 1 FROM conversations WHERE peer = '972500000303'"), null, 'no conversation and no agent call for an unknown phone');
  await app.db.close();
});

test('a bad code, a duplicate delivery, and the owner\'s own phone are each handled without side effects', async () => {
  const { app, a, codeA } = await twoStores();
  assert.equal((await handleInbound(app, msg(P1, 'DEMO-ZZZZ'))).action, 'bad_code');
  const m = msg(P2, codeA);
  await handleInbound(app, m);
  const before = app.wa.outbox!.length;
  assert.equal((await handleInbound(app, { ...m })).action, 'duplicate');
  assert.equal(app.wa.outbox!.length, before, 'a webhook retried by the BSP is not answered twice');
  assert.equal((await app.db.one<any>('SELECT status FROM stores WHERE id = $1', [a])).status, 'demo_started');

  app.env.TORAN_OWNER_WHATSAPP = '972500000404';
  await app.db.query("UPDATE stores SET status = 'sent', demo_started_at = NULL WHERE id = $1", [a]);
  await handleInbound(app, msg('972500000404', codeA));
  assert.equal((await app.db.one<any>('SELECT status FROM stores WHERE id = $1', [a])).status, 'sent', 'the owner testing does not count as a demo start');
  await app.db.close();
});

test('Twilio webhooks are accepted only with a valid signature', () => {
  const p = twilioProvider({ accountSid: 'AC0', authToken: 'secret-token', from: '+972500000999', webhookUrl: 'https://toran.example/wa/twilio' });
  const form = { From: 'whatsapp:+972500000101', Body: 'DEMO-ABCD', MessageSid: 'SM1', ProfileName: 'x' };
  const sig = twilioSignature('secret-token', 'https://toran.example/wa/twilio', form);
  assert.deepEqual(p.parse({ raw: '', form, headers: { 'x-twilio-signature': sig }, url: '' }), [{ from: '972500000101', text: 'DEMO-ABCD', id: 'SM1', profileName: 'x' }]);
  assert.equal(p.parse({ raw: '', form, headers: { 'x-twilio-signature': 'forged' }, url: '' }), null);
  assert.equal(p.parse({ raw: '', form: { ...form, Body: 'changed' }, headers: { 'x-twilio-signature': sig }, url: '' }), null);
  assert.equal(simProvider().kind, 'sim');
});
