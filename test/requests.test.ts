import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { handleInbound } from '../src/wa/router.ts';
import { testApp } from './helpers.ts';

// A demo asked for on the website counts only once the person writes to the demo number with its code
// (src/channels/request.ts): the number it came from is the proof, and one number gets one demo.

const P1 = '972500000301';
const P2 = '972500000302';
const OWNER = '972500000777';
let seq = 0;
const msg = (from: string, text: string) => ({ from, text, id: `r${seq++}` });

async function withRequests() {
  const app = await testApp();
  app.env.TORAN_OWNER_WHATSAPP = OWNER;
  for (const [code, domain] of [['REQ-AAAAA1', 'new-shop.co.il'], ['REQ-BBBBB2', 'second-shop.co.il'], ['REQ-CCCCC3', 'third-shop.co.il'], ['REQ-DDDDD4', 'kli-cheres.example']]) {
    await app.db.query('INSERT INTO demo_requests (code, url, domain) VALUES ($1, $2, $3)', [code, `https://${domain}/`, domain]);
  }
  const jobs = async () => (await app.db.query<any>("SELECT payload FROM jobs WHERE kind = 'add_store' ORDER BY id")).map((j) => j.payload);
  return { app, jobs };
}

test('the message with the code is the proof: the store is queued for the number that wrote, and the request is claimed', async () => {
  const { app, jobs } = await withRequests();
  const r = await handleInbound(app, msg(P1, 'REQ-AAAAA1 היי, אשמח לדמו של תורן לחנות new-shop.co.il'));
  assert.equal(r.action, 'requested');
  assert.match(r.reply!, /new-shop\.co\.il/);
  assert.deepEqual(await jobs(), [{ url: 'https://new-shop.co.il/', by: 'website', whatsapp: P1 }]);
  const row = await app.db.one<any>("SELECT phone, claimed_at FROM demo_requests WHERE code = 'REQ-AAAAA1'");
  assert.equal(row.phone, P1);
  assert.ok(row.claimed_at);
  await app.db.close();
});

test('one number, one demo: the same code again, or a second request, is answered and nothing more is queued', async () => {
  const { app, jobs } = await withRequests();
  await handleInbound(app, msg(P1, 'REQ-AAAAA1'));
  assert.equal((await handleInbound(app, msg(P1, 'req-aaaaa1'))).action, 'already_requested', 'the same code, sent twice');
  assert.equal((await handleInbound(app, msg(P1, 'REQ-BBBBB2'))).action, 'already_requested', 'a second store from the same number');
  assert.equal((await app.db.one<any>("SELECT phone FROM demo_requests WHERE code = 'REQ-BBBBB2'")).phone, null, 'left for its own number');
  assert.equal((await jobs()).length, 1);
  await app.db.close();
});

test("a code another number used, or one nobody gave out, is refused; a message with no request goes on as before", async () => {
  const { app, jobs } = await withRequests();
  await handleInbound(app, msg(P1, 'REQ-AAAAA1'));
  assert.equal((await handleInbound(app, msg(P2, 'REQ-AAAAA1'))).action, 'bad_code', 'not the number that claimed it');
  assert.equal((await handleInbound(app, msg(P2, 'REQ-ZZZZZ9'))).action, 'bad_code');
  assert.equal((await handleInbound(app, msg(P2, 'היי, מה זה?'))).action, 'no_binding');
  assert.equal((await jobs()).length, 1);
  await app.db.close();
});

test("the owner's phone may ask again, and a store Toran already has keeps its page and gets the number", async () => {
  const { app, jobs } = await withRequests();
  assert.equal((await handleInbound(app, msg(OWNER, 'REQ-AAAAA1'))).action, 'requested');
  assert.equal((await handleInbound(app, msg(OWNER, 'REQ-CCCCC3'))).action, 'requested');
  await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const known = await handleInbound(app, msg(P2, 'REQ-DDDDD4'));
  assert.equal(known.action, 'requested');
  assert.ok(known.storeId);
  assert.equal((await app.db.one<any>('SELECT contact_whatsapp FROM stores WHERE id = $1', [known.storeId])).contact_whatsapp, P2);
  assert.equal((await jobs()).length, 2, 'only the two new stores are queued');
  await app.db.close();
});
