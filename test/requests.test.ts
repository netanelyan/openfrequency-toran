import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { discover } from '../src/leads/discover.ts';
import { handleInbound } from '../src/wa/router.ts';
import { drain } from '../src/jobs/worker.ts';
import { deliverRequested, deliverTeder } from '../src/ops/actions.ts';
import { queue, stuckRequests } from '../src/ops/queue.ts';
import { syncTeder } from '../src/ops/sources.ts';
import { INTERNAL_TOKEN, testApp } from './helpers.ts';

// A demo asked for on the website counts only once the person writes to the demo number with its code
// (src/channels/request.ts): the number it came from is the proof, and one number gets one demo of each product,
// Toran's and Teder's. A Teder request is handed to Teder by a job, and its link goes out once Teder has the page up.

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
  // Teder's: the website sends product teder.
  for (const [code, domain] of [['REQ-TTTTT1', 'teder-shop.co.il'], ['REQ-TTTTT2', 'teder-two.co.il'], ['REQ-TTTTT3', 'teder-shop.co.il'], ['REQ-TTTTT4', 'teder-three.co.il']]) {
    await app.db.query("INSERT INTO demo_requests (code, url, domain, product) VALUES ($1, $2, $3, 'teder')", [code, `https://${domain}/`, domain]);
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

// ---- Teder's demos

test('one demo of each product per number: Toran then Teder from one phone, a second Teder refused in its own words, the owner exempt', async () => {
  const { app, jobs } = await withRequests();
  try {
    assert.equal((await handleInbound(app, msg(P1, 'REQ-AAAAA1'))).action, 'requested', "Toran's");
    const teder = await handleInbound(app, msg(P1, 'REQ-TTTTT1 היי, אשמח לדמו של תדר'));
    assert.equal(teder.action, 'requested', "and Teder's, from the same number");
    assert.equal(teder.reply, 'קיבלנו, תודה. אנחנו בונים עכשיו דמו של תדר ל־teder-shop.co.il, ונשלח לכם לכאן את הלינק כשהוא מוכן.');
    const again = await handleInbound(app, msg(P1, 'REQ-TTTTT2'));
    assert.equal(again.action, 'already_requested', 'a second Teder store from the same number');
    assert.equal(again.reply, 'כבר קיבלנו מהמספר הזה בקשה לדמו של תדר, והיא אצלנו. נשלח לכם לכאן את הלינק כשהדמו מוכן.');
    assert.match((await handleInbound(app, msg(P1, 'REQ-BBBBB2'))).reply!, /בקשה לדמו של תורן,/, "a second Toran store: Toran's words");
    assert.equal((await app.db.one<any>("SELECT phone FROM demo_requests WHERE code = 'REQ-TTTTT2'")).phone, null, 'left for its own number');

    // Teder first, then Toran, from another number.
    assert.equal((await handleInbound(app, msg(P2, 'REQ-TTTTT2'))).action, 'requested');
    assert.equal((await handleInbound(app, msg(P2, 'REQ-CCCCC3'))).action, 'requested');

    // The owner's phone may ask for Teder again and again.
    assert.equal((await handleInbound(app, msg(OWNER, 'REQ-TTTTT3'))).action, 'requested');
    assert.equal((await handleInbound(app, msg(OWNER, 'REQ-TTTTT4'))).action, 'requested');

    // A Teder request adds no Toran store: only Toran's two are queued to be read, and each Teder one is a handoff.
    assert.deepEqual((await jobs()).map((j) => j.url), ['https://new-shop.co.il/', 'https://third-shop.co.il/']);
    const handoffs = await app.db.query<any>("SELECT payload, dedupe_key, max_attempts FROM jobs WHERE kind = 'teder_lead' ORDER BY id");
    assert.equal(handoffs.length, 4);
    assert.equal(handoffs[0].max_attempts, 8);
    assert.ok(!(await app.db.one("SELECT 1 FROM stores WHERE domain LIKE 'teder-%'")), 'no Toran store for a Teder request');
  } finally {
    await app.db.close();
  }
});

/** A stand-in for Teder's site: POST /internal/lead (one demo per store, as Teder's requestDemo) and GET /internal/demos. */
async function fakeTeder() {
  const posts: { url: string; whatsapp: string }[] = [];
  const demos = new Map<string, any>();
  let down = false;
  let next = 40;
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`) return send(403, { ok: false, error: 'forbidden' });
    if (down) return send(503, { ok: false, error: 'down' });
    if (req.method === 'POST' && req.url === '/internal/lead') {
      let raw = '';
      for await (const c of req) raw += c;
      const b = JSON.parse(raw);
      posts.push(b);
      if (!/^9725\d{8}$/.test(String(b.whatsapp))) return send(400, { ok: false, error: 'bad' });
      const domain = new URL(b.url).hostname.replace(/^www\./, '');
      const known = demos.get(domain);
      if (known) {
        known.whatsapp = b.whatsapp;
        return send(200, { ok: true, id: known.id, existing: true });
      }
      const d = { id: next++, domain, url: b.url, name: null, status: 'new', whatsapp: b.whatsapp, pageUrl: null, createdAt: new Date().toISOString(), readyAt: null, approvedAt: null, removedAt: null, error: null, opens: 0, visitors: 0, lastOpenAt: null };
      demos.set(domain, d);
      return send(200, { ok: true, id: d.id, existing: false });
    }
    if (req.method === 'GET' && req.url === '/internal/demos') return send(200, { demos: [...demos.values()] });
    return send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    env: { OF_INTERNAL_TOKEN: INTERNAL_TOKEN, TEDER_SITE_INTERNAL: base },
    posts,
    demos,
    down: (v: boolean) => void (down = v),
    /** The demo drawn and up: approved, with its page (Teder gives pageUrl to an approved demo only). */
    approve(domain: string, name: string) {
      const at = new Date().toISOString();
      Object.assign(demos.get(domain), { status: 'approved', name, pageUrl: `https://teder.example/s/${domain.split('.')[0]}-a1b2c3`, readyAt: at, approvedAt: at });
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Run the Teder handoffs due now; with now, a failed one is made due again at once (its backoff skipped). */
const handoffs = async (app: any, { now = false } = {}) => {
  if (now) await app.db.query("UPDATE jobs SET run_at = now() WHERE kind = 'teder_lead' AND status = 'queued'");
  return drain(app, { kinds: ['teder_lead'] });
};

test('a claimed Teder code is handed to Teder by a job, tried again while Teder is down, with the number that wrote', async () => {
  const { app } = await withRequests();
  const teder = await fakeTeder();
  Object.assign(app.env, teder.env);
  try {
    await handleInbound(app, msg(P1, 'REQ-TTTTT1'));
    teder.down(true);
    await handoffs(app);
    let job = await app.db.one<any>("SELECT status, attempts, last_error FROM jobs WHERE kind = 'teder_lead'");
    assert.deepEqual([job.status, job.attempts], ['queued', 1], 'Teder down: queued again, not lost');
    assert.match(job.last_error, /Teder did not take the request: 503 down/);
    assert.equal((await app.db.one<any>("SELECT teder_id FROM demo_requests WHERE code = 'REQ-TTTTT1'")).teder_id, null);
    assert.deepEqual((await stuckRequests(app)).map((s) => [s.domain, s.why, s.storeId]), [['teder-shop.co.il', 'הבקשה בדרך לתדר', null]]);

    teder.down(false);
    await handoffs(app, { now: true });
    job = await app.db.one<any>("SELECT status, attempts FROM jobs WHERE kind = 'teder_lead'");
    assert.deepEqual([job.status, job.attempts], ['done', 2]);
    assert.deepEqual(teder.posts.at(-1), { url: 'https://teder-shop.co.il/', whatsapp: P1 }, 'the url and the number, as Teder takes them');
    assert.equal((await app.db.one<any>("SELECT teder_id FROM demo_requests WHERE code = 'REQ-TTTTT1'")).teder_id, '40');
    await handoffs(app, { now: true });
    assert.equal(teder.posts.length, 1, 'handed over once (Teder down kept nothing)');

    // Its demo is building: listed with why, after Teder is read.
    await syncTeder(app);
    assert.deepEqual((await stuckRequests(app)).map((s) => s.why), ['הדמו של תדר בבנייה']);
  } finally {
    await teder.close();
    await app.db.close();
  }
});

test('a handoff Teder never takes ends failed and is listed; a number Teder does not take is not sent to it', async () => {
  const app = await testApp();
  const teder = await fakeTeder();
  Object.assign(app.env, teder.env);
  try {
    await app.db.query("INSERT INTO demo_requests (code, url, domain, product) VALUES ('REQ-TTTTT5', 'https://abroad.example/', 'abroad.example', 'teder')");
    await handleInbound(app, msg('447700900123', 'REQ-TTTTT5'));
    for (let i = 0; i < 8; i++) await handoffs(app, { now: true });
    const job = await app.db.one<any>("SELECT status, attempts, last_error FROM jobs WHERE kind = 'teder_lead'");
    assert.deepEqual([job.status, job.attempts], ['failed', 8]);
    assert.match(job.last_error, /not an Israeli mobile/);
    assert.equal(teder.posts.length, 0, 'Teder is never asked for what it refuses');
    assert.deepEqual((await stuckRequests(app)).map((s) => [s.domain, s.why]), [['abroad.example', 'תדר לא קיבל את הבקשה']]);
  } finally {
    await teder.close();
    await app.db.close();
  }
});

test("the Teder demo's link goes out by itself on the demo number once Teder has it up, once; two numbers for one store get the same demo", async () => {
  const { app } = await withRequests();
  const teder = await fakeTeder();
  Object.assign(app.env, teder.env);
  try {
    await handleInbound(app, msg(P1, 'REQ-TTTTT1'));
    await handleInbound(app, msg(P2, 'REQ-TTTTT3'));
    await handoffs(app);
    const ids = await app.db.query<any>("SELECT code, teder_id FROM demo_requests WHERE code IN ('REQ-TTTTT1', 'REQ-TTTTT3') ORDER BY code");
    assert.deepEqual(ids.map((r) => r.teder_id), ['40', '40'], 'Teder keeps one demo per store');

    const before = app.wa.outbox!.length;
    assert.equal(await deliverTeder(app), 0, 'still building: nothing');
    teder.approve('teder-shop.co.il', 'חנות תדר');
    assert.equal(await deliverTeder(app), 2);
    const sent = app.wa.outbox!.slice(before);
    assert.deepEqual(sent.map((o) => o.to), [P1, P2]);
    for (const o of sent) assert.equal(o.text, 'הדמו של תדר לחנות תדר מוכן. הכנו לחנות מצגת לדוגמה על נושא מהתחום שלה, בגדלים של טיקטוק ואינסטגרם:\nhttps://teder.example/s/teder-shop-a1b2c3');
    assert.equal(await deliverTeder(app), 0, 'once');
    assert.equal(app.wa.outbox!.length, before + 2);
    const rows = await app.db.query<any>("SELECT delivered_at FROM demo_requests WHERE code IN ('REQ-TTTTT1', 'REQ-TTTTT3')");
    assert.ok(rows.every((r) => r.delivered_at));
    const lead = await app.db.one<any>("SELECT sent_at, reminder_due_at FROM teder_leads WHERE id = '40'");
    assert.ok(lead.sent_at && lead.reminder_due_at, "recorded as sent, as the operator's button would: its one reminder comes due");
    assert.ok(!(await queue(app)).items.some((i) => i.key === 'teder:40'), 'nothing left for the operator to send');
    assert.equal((await app.db.query("SELECT 1 FROM audit WHERE action = 'ops_direct' AND actor = 'auto'")).length, 2);
    assert.deepEqual(await stuckRequests(app), []);
  } finally {
    await teder.close();
    await app.db.close();
  }
});

test("past the 23 hours a Teder demo is not sent by itself: it waits on the operator's list, to send by hand", async () => {
  const { app } = await withRequests();
  const teder = await fakeTeder();
  Object.assign(app.env, teder.env);
  try {
    await handleInbound(app, msg(P1, 'REQ-TTTTT1'));
    await handoffs(app);
    teder.approve('teder-shop.co.il', 'חנות תדר');
    await app.db.query("UPDATE demo_requests SET claimed_at = now() - interval '25 hours' WHERE code = 'REQ-TTTTT1'");
    const before = app.wa.outbox!.length;
    assert.equal(await deliverTeder(app), 0);
    assert.equal(app.wa.outbox!.length, before, 'nothing sent');
    assert.equal(await syncTeder(app), true);
    const item = (await queue(app)).items.find((i) => i.key === 'teder:40')!;
    assert.equal(item.reason, 'asked_teder');
    assert.equal(item.direct, false);
    assert.equal(item.target.href, `https://wa.me/${P1}`, 'to the number that wrote');
    assert.match(item.message!, /^היי, כאן OpenFrequency\. ביקשתם באתר דמו של תדר/);
  } finally {
    await teder.close();
    await app.db.close();
  }
});

test("a Teder request is never taken for Toran's: a store Toran has on that domain gets neither the number nor a Toran link", async () => {
  const { app } = await withRequests();
  try {
    const id = (await app.db.one<any>(
      "INSERT INTO stores (domain, url, name, platform, source, slug, score, qualified, status, approved_at, page_built_at) VALUES ('teder-shop.co.il', 'https://teder-shop.co.il/', 'teder', 'shopify', 'seed', 'teder-x1', 50, true, 'page_ready', now(), now()) RETURNING id",
    )).id;
    await handleInbound(app, msg(P1, 'REQ-TTTTT1'));
    assert.equal((await app.db.one<any>('SELECT contact_whatsapp FROM stores WHERE id = $1', [id])).contact_whatsapp, null, "Toran's store is not given the number");
    assert.equal(await deliverRequested(app), 0);
    assert.ok(!(await queue(app)).items.some((i) => i.reason === 'asked_toran'));
  } finally {
    await app.db.close();
  }
});
