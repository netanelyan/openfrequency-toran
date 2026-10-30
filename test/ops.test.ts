import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { queue, conversations } from '../src/ops/queue.ts';
import { markLost, markReminded, markReplied, markSent, markWon, later, NOT_LIVE, sendDirect, setNext, OpsError } from '../src/ops/actions.ts';
import { customers, syncTeder, type Customer } from '../src/ops/sources.ts';
import { funnels, money, rate } from '../src/ops/funnel.ts';
import { israelWeekdayHour } from '../src/core/clock.ts';
import { customer, fakeMetaSends, INTERNAL_TOKEN, META_DEMO, testApp } from './helpers.ts';
import { serve } from './serve.ts';

// The operator's dashboard (src/ops/, pages/ops.ts, docs/operator.md): who to write to today and in what order, what
// each button records, the one-approach-one-reminder line, the demo link sent on the demo number inside its 24 hours,
// Teder's demos copied in, and the money from accounts.

const PHONE = '972500000301';

async function store(app: any, domain: string, cols: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = { domain, url: `https://${domain}/`, name: domain.split('.')[0], platform: 'shopify', source: 'seed', slug: `${domain.split('.')[0]}-x1`, score: 50, qualified: true, ...cols };
  const keys = Object.keys(all);
  const vals = Object.values(all);
  return (await app.db.one('INSERT INTO stores (' + keys.join(', ') + ') VALUES (' + keys.map((_, i) => `$${i + 1}`).join(', ') + ') RETURNING id', vals)).id as number;
}
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/** A stand-in for Teder's GET /internal/demos, accounts' GET /internal/ops/customers and the website's GET /internal/leads, all behind the token. */
async function fakeServices(demos: unknown[], workspaces: Customer[] | null, leads: unknown[] | null = []) {
  const server = http.createServer((req, res) => {
    const send = (s: number, b: unknown) => {
      res.writeHead(s, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`) return send(401, { error: 'bad_token' });
    if (req.url === '/internal/demos') return send(200, { demos });
    if (req.url === '/internal/ops/customers') return workspaces ? send(200, { today: '2026-10-24', workspaces }) : send(500, {});
    if (req.url === '/internal/leads') return leads ? send(200, { leads }) : send(500, {});
    return send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { env: { OF_INTERNAL_TOKEN: INTERNAL_TOKEN, TEDER_SITE_INTERNAL: base, OF_ACCOUNTS_INTERNAL: base, OF_WEB_INTERNAL: base }, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ws = (id: number, name: string, subs: Partial<Customer['subscriptions'][number]>[]): Customer => ({ id, slug: `w${id}`, name, disabled: false, createdAt: ago(100), products: subs.map((s) => s.product!), people: 1, invitesWaiting: 0, lastLoginAt: null, subscriptions: subs.map((s) => ({ product: 'toran', monthly: 590, vat: 'excluded', setup: 990, startedOn: '2026-10-01', paidUntil: null, endsOn: null, state: 'paid', nextChargeOn: null, ...s })) as Customer['subscriptions'], invoices: { count: 0, lastIssuedOn: null } });

test('who to write to today, in order: tried the demo, asked on the website, the reminders, then new pages by score', async () => {
  const app = await testApp();
  const svc = await fakeServices([
    { id: 7, domain: 'teder-asked.example', url: 'https://teder-asked.example/', name: 'מצגות לבית', status: 'approved', whatsapp: '972500000302', pageUrl: 'https://teder.example/s/tb-x1', createdAt: ago(30), readyAt: ago(29), approvedAt: ago(29), removedAt: null, error: null, opens: 0, visitors: 0, lastOpenAt: null },
    { id: 8, domain: 'teder-building.example', url: null, name: null, status: 'building', whatsapp: '972500000303', pageUrl: null, createdAt: ago(1), readyAt: null, approvedAt: null, removedAt: null, error: null, opens: 0, visitors: 0, lastOpenAt: null },
  ], []);
  Object.assign(app.env, svc.env);
  try {
    const tried = await store(app, 'tried.example', { status: 'demo_started', approved_at: ago(200), page_built_at: ago(200), sent_at: ago(100), demo_started_at: ago(5), contact_whatsapp: '972500000304' });
    const asked = await store(app, 'asked.example', { status: 'page_ready', approved_at: ago(1), page_built_at: ago(1), contact_whatsapp: PHONE });
    await app.db.query("INSERT INTO demo_requests (code, url, domain, phone, claimed_at, store_id) VALUES ('REQ-AAAAAA', 'https://asked.example/', 'asked.example', $1, $2, $3)", [PHONE, ago(2), asked]);
    const opened = await store(app, 'opened.example', { status: 'opened', approved_at: ago(200), page_built_at: ago(200), sent_at: ago(100), followup_due_at: ago(4), opened_at: ago(50), contact_email: 'owner@opened.example' });
    const quiet = await store(app, 'quiet.example', { status: 'sent', approved_at: ago(200), page_built_at: ago(200), sent_at: ago(100), followup_due_at: ago(5), contact_whatsapp: '972500000305' });
    const high = await store(app, 'high.example', { status: 'page_ready', approved_at: ago(3), page_built_at: ago(3), score: 90, contact_whatsapp: '972500000306' });
    const low = await store(app, 'low.example', { status: 'page_ready', approved_at: ago(3), page_built_at: ago(3), score: 20, contact_whatsapp: '972500000307' });
    const none = await store(app, 'none.example', { status: 'page_ready', approved_at: ago(3), page_built_at: ago(3) });
    await store(app, 'reminded.example', { status: 'sent', approved_at: ago(200), sent_at: ago(100), followup_due_at: ago(4), followup_sent_at: ago(3), contact_whatsapp: '972500000308' });
    await store(app, 'lost.example', { status: 'page_ready', approved_at: ago(3), page_built_at: ago(3), contact_whatsapp: '972500000309', lost_at: ago(1), lost_reason: 'price' });
    await store(app, 'snoozed.example', { status: 'page_ready', approved_at: ago(3), page_built_at: ago(3), contact_whatsapp: '972500000310', snoozed_until: new Date(Date.now() + 86_400_000).toISOString() });

    assert.equal(await syncTeder(app), true);
    const q = await queue(app);
    assert.deepEqual(q.items.map((i) => [i.key, i.reason]), [
      [`toran:${tried}`, 'tried_demo'],
      ['teder:7', 'asked_teder'], // asked on the website, both: the one waiting longer first
      [`toran:${asked}`, 'asked_toran'],
      [`toran:${opened}`, 'reminder'],
      [`toran:${quiet}`, 'reminder'],
      [`toran:${high}`, 'first_send'],
      [`toran:${low}`, 'first_send'],
    ]);
    assert.deepEqual(q.noContact.map((s) => s.id), [none], 'a page with nothing to send it to is listed apart');
    const askedItem = q.items[2];
    assert.equal(askedItem.direct, true, 'asked two hours ago: it can go out on the demo number');
    assert.match(askedItem.message!, /הדמו של תורן ל־asked מוכן/);
    // Each link opens the chat or the mail with the card's message already written in it.
    assert.equal(askedItem.target.href, `https://wa.me/${PHONE}?text=${encodeURIComponent(askedItem.message!)}`);
    for (const i of q.items.filter((x) => x.target.kind === 'whatsapp')) assert.equal(new URL(i.target.href!).searchParams.get('text'), i.message, i.key);
    const mail = new URL(q.items[3].target.href!);
    assert.equal(`${mail.protocol}${mail.pathname}`, 'mailto:owner@opened.example');
    assert.deepEqual([mail.searchParams.get('subject'), mail.searchParams.get('body')], ['תורן ל־opened', q.items[3].message]);
    assert.doesNotMatch(q.items[3].target.href!, /\+/, 'spaces as %20, which mail programs read');
    assert.match(q.items[0].message!, /ראינו שניסיתם את הדמו/, 'tried the demo: the question takes the reminder\'s place');
    assert.match(q.items[1].message!, /ביקשתם באתר דמו של תדר[^]*https:\/\/teder\.example\/s\/tb-x1/);
    assert.equal(q.items[3].target.kind, 'email');
  } finally {
    await svc.close();
    await app.db.close();
  }
});

test("every Teder demo not up yet, at its stage, with Teder's reason and a link to it in Teder; a failed one has a message; one a request lists, or that is up, is not here twice", async () => {
  const { tederDemos } = await import('../src/ops/queue.ts');
  const { opsData } = await import('../src/ops/api.ts');
  const demo = (id: number, domain: string, status: string, more: Record<string, unknown> = {}) => ({ id, domain, url: `https://${domain}/`, name: null, status, whatsapp: '972500000351', pageUrl: null, createdAt: ago(id), readyAt: null, approvedAt: null, removedAt: null, error: null, opens: 0, visitors: 0, lastOpenAt: null, ...more });
  const app = await testApp();
  const svc = await fakeServices([
    demo(1, 'building.example', 'building'),
    demo(2, 'fresh.example', 'new', { whatsapp: null }),
    demo(3, 'check-me.example', 'ready', { name: 'בדיקה' }),
    demo(4, 'broken.example', 'failed', { name: 'חנות שבורה', error: 'לא הצלחנו לקרוא את החנות: 404' }),
    demo(5, 'up.example', 'approved', { pageUrl: 'https://teder.example/s/up-x1', approvedAt: ago(4) }),
    demo(6, 'gone.example', 'removed', { removedAt: ago(5) }),
    demo(7, 'asked.example', 'failed', { error: 'המצגת לא עברה את הבדיקות' }),
    demo(900, 'old.example', 'failed', { createdAt: ago(31 * 24) }),
  ], []);
  Object.assign(app.env, svc.env);
  try {
    // Demo 7 was asked for with a code: its request is listed with nothing to send, so it is not here again.
    await app.db.query("INSERT INTO demo_requests (code, url, domain, phone, claimed_at, product, teder_id) VALUES ('REQ-TDEMO7', 'https://asked.example/', 'asked.example', '972500000352', $1, 'teder', '7')", [ago(2)]);
    assert.equal(await syncTeder(app), true);
    const list = await tederDemos(app);
    assert.deepEqual(list.map((d) => [d.id, d.status, d.why]), [['4', 'failed', 'לא נבנה'], ['1', 'building', 'בבנייה'], ['2', 'new', 'בבנייה'], ['3', 'ready', 'מחכה לבדיקה בתדר']], 'failed first, then the newest; not the one up, taken down, asked with a code, or older than 30 days');
    const failed = list[0];
    assert.equal(failed.error, 'לא הצלחנו לקרוא את החנות: 404', "Teder's reason");
    assert.equal(failed.message, 'היי, כאן OpenFrequency. ביקשתם באתר דמו של תדר לחנות שבורה, ולא הצלחנו לבנות אותו. אם יש שאלה, אפשר לענות כאן.');
    assert.equal(failed.target.href, `https://wa.me/972500000351?text=${encodeURIComponent(failed.message!)}`);
    assert.deepEqual(list.slice(1).map((d) => [d.message, d.target.href]), [[null, 'https://wa.me/972500000351'], [null, null], [null, 'https://wa.me/972500000351']], 'the others open the chat alone, when there is a number');

    // In the dashboard's data, each links to its page in Teder: TEDER_URL, else Teder's address on our domain.
    let d = await opsData(app);
    assert.deepEqual(d.tederDemos.map((x) => x.leadUrl), ['4', '1', '2', '3'].map((id) => `https://teder.openfrequency.co.il/demos/${id}`));
    app.env.TEDER_URL = 'https://teder.example/';
    d = await opsData(app);
    assert.equal(d.tederDemos[0].leadUrl, 'https://teder.example/demos/4');
    const asked = d.stuck.find((s) => s.domain === 'asked.example')!;
    assert.deepEqual([asked.why, asked.leadUrl, 'tederId' in asked], ['תדר לא הצליח לבנות את הדמו', 'https://teder.example/demos/7', false], "a Teder request links to its demo in Teder");
  } finally {
    await svc.close();
    await app.db.close();
  }
});

test("the website's leads that reached only the email: Toran's waitlist, and a hand-off no product took after 10 minutes; the website not answering says so", async () => {
  const { websiteLeads, siteLeads, webSite } = await import('../src/ops/sources.ts');
  const lead = (id: number, source: string, minutes: number, more: Record<string, unknown> = {}) => ({ id, source, store: `shop${id}.example`, contact: '972500000361', page: '/teder', createdAt: new Date(Date.now() - minutes * 60_000).toISOString(), handedTo: null, handedAt: null, ...more });
  const app = await testApp();
  const svc = await fakeServices([], [], [
    lead(1, 'waitlist', 5, { store: null, contact: 'wait@shop.example', page: '/toran' }),
    lead(2, 'teder', 60, { handedTo: 'teder' }), // Teder never took it
    lead(3, 'teder', 2, { handedTo: 'teder' }), // just came: the website is still handing it over
    lead(4, 'demo', 60, { contact: null, handedTo: 'toran', handedAt: new Date().toISOString() }), // taken
    lead(5, 'demo', 90, { contact: null, handedTo: 'toran' }), // a Toran demo with its code, not taken
    { id: 'x', source: 'teder' }, // not a lead
  ]);
  Object.assign(app.env, svc.env);
  try {
    assert.equal((await siteLeads(app))!.length, 5);
    const l = await websiteLeads(app);
    assert.equal(l.ok, true);
    assert.deepEqual(l.waitlist.map((x) => [x.id, x.contact, x.store, x.page]), [[1, 'wait@shop.example', null, '/toran']]);
    assert.deepEqual(l.failed.map((x) => [x.id, x.product, x.source, x.store, x.contact]), [[2, 'teder', 'teder', 'shop2.example', '972500000361'], [5, 'toran', 'demo', 'shop5.example', null]]);
    assert.deepEqual(Object.keys(l.failed[0]).sort(), ['at', 'contact', 'id', 'page', 'product', 'source', 'store']);
    // The website down, or the token unset: the section says it could not read them.
    app.env.OF_WEB_INTERNAL = 'http://127.0.0.1:9';
    assert.deepEqual(await websiteLeads(app), { ok: false, waitlist: [], failed: [] });
    assert.equal(webSite({}), 'http://127.0.0.1:4720', "the website's lead service, by default");
  } finally {
    await svc.close();
    await app.db.close();
  }
});

test('one approach and one reminder: "sent" sets the reminder four days on (never on Shabbat), and a second reminder is refused', async () => {
  const app = await testApp();
  try {
    const id = await store(app, 'a.example', { status: 'page_ready', approved_at: ago(1), page_built_at: ago(1), contact_whatsapp: '972500000311' });
    await markSent(app, 'toran', String(id), 'op');
    const s = await app.db.one<any>('SELECT status, sent_at, followup_due_at FROM stores WHERE id = $1', [id]);
    assert.equal(s.status, 'sent');
    const due = new Date(s.followup_due_at).getTime();
    assert.ok(due - new Date(s.sent_at).getTime() >= 4 * 86_400_000 - 1000);
    const { weekday, hour } = israelWeekdayHour(due);
    assert.ok(!(weekday === 6 || (weekday === 5 && hour >= 13)), 'not on Shabbat');
    await assert.rejects(markSent(app, 'toran', String(id), 'op'), OpsError);
    await markReminded(app, 'toran', String(id), 'op');
    await assert.rejects(markReminded(app, 'toran', String(id), 'op'), /לא כותבים להם יותר/);
    assert.equal((await queue(app)).items.length, 0, 'after the reminder, nothing more');
    const audit = await app.db.query<any>("SELECT action, actor FROM audit WHERE action LIKE 'ops_%' ORDER BY id");
    assert.deepEqual(audit.map((a) => a.action), ['ops_sent', 'ops_reminded']);
  } finally {
    await app.db.close();
  }
});

test('the link to a demo asked for on the website goes out on the demo number inside its 24 hours, and only then', async () => {
  const app = await testApp();
  try {
    const id = await store(app, 'asked.example', { status: 'page_ready', approved_at: ago(1), page_built_at: ago(1), contact_whatsapp: PHONE });
    await app.db.query("INSERT INTO demo_requests (code, url, domain, phone, claimed_at) VALUES ('REQ-BBBBBB', 'https://asked.example/', 'asked.example', $1, $2)", [PHONE, ago(3)]);
    await sendDirect(app, String(id), 'op');
    const out = app.wa.outbox!.at(-1)!;
    assert.equal(out.to, PHONE);
    assert.match(out.text, /הדמו של תורן ל־asked מוכן[^]*\/s\/asked-x1/);
    assert.ok((await app.db.one<any>('SELECT sent_at FROM stores WHERE id = $1', [id])).sent_at);

    const late = await store(app, 'late.example', { status: 'page_ready', approved_at: ago(1), page_built_at: ago(1), contact_whatsapp: '972500000312' });
    await app.db.query("INSERT INTO demo_requests (code, url, domain, phone, claimed_at) VALUES ('REQ-CCCCCC', 'https://late.example/', 'late.example', '972500000312', $1)", [ago(30)]);
    const n = app.wa.outbox!.length;
    await assert.rejects(sendDirect(app, String(late), 'op'), /עברו 24 שעות/);
    assert.equal(app.wa.outbox!.length, n, 'nothing sent');
    const item = (await queue(app)).items.find((i) => i.key === `toran:${late}`)!;
    assert.equal(item.direct, false);
    assert.match(item.message!, /^היי, כאן OpenFrequency\. ביקשתם באתר דמו של תורן/, 'later, from the operator\'s own WhatsApp');
  } finally {
    await app.db.close();
  }
});

test('replied, the next step, later, not interested and won: each moves the lead where it belongs', async () => {
  const app = await testApp();
  try {
    const a = String(await store(app, 'a.example', { status: 'sent', approved_at: ago(200), page_built_at: ago(200), sent_at: ago(100), followup_due_at: ago(4), contact_whatsapp: '972500000313' }));
    const b = String(await store(app, 'b.example', { status: 'page_ready', approved_at: ago(3), page_built_at: ago(3), contact_whatsapp: '972500000314' }));
    const c = String(await store(app, 'c.example', { status: 'page_ready', approved_at: ago(3), page_built_at: ago(3), contact_whatsapp: '972500000315' }));
    await markReplied(app, 'toran', a, 'op');
    assert.ok(!(await queue(app)).items.some((i) => i.key === `toran:${a}`), 'answered: off the list');
    const conv = await conversations(app);
    assert.deepEqual(conv.map((x) => x.key), [`toran:${a}`]);
    assert.ok(new Date(conv[0].next_step_at!).getTime() > Date.now(), 'the next step is set for tomorrow');

    await setNext(app, 'toran', a, 'לשלוח הצעת מחיר', 1, 'op');
    // A day later (moved here by hand: setNext never lands on Shabbat, and the test may run on one).
    await app.db.query("UPDATE stores SET next_step_at = now() - interval '1 minute' WHERE id = $1", [Number(a)]);
    const due = (await queue(app)).items.find((i) => i.key === `toran:${a}`)!;
    assert.equal(due.reason, 'next_step');
    assert.match(due.why, /לשלוח הצעת מחיר/);

    await later(app, 'toran', b, 7, 'op');
    await markLost(app, 'toran', c, 'price', 'op');
    assert.ok(!(await queue(app)).items.some((i) => i.key === `toran:${b}` || i.key === `toran:${c}`));
    assert.equal((await app.db.one<any>('SELECT lost_reason FROM stores WHERE id = $1', [Number(c)])).lost_reason, 'price');

    await markWon(app, 'toran', a, 'paid', 'op');
    assert.equal((await app.db.one<any>('SELECT status FROM stores WHERE id = $1', [Number(a)])).status, 'paid');
    assert.deepEqual(await conversations(app), [], 'a customer is no longer in a conversation');
  } finally {
    await app.db.close();
  }
});

test("the money, from accounts: monthly revenue before VAT, who is late, who hasn't paid yet, the week's renewals", () => {
  const m = money([
    ws(1, 'א', [{ product: 'toran', monthly: 590, state: 'paid', nextChargeOn: '2026-10-27' }]),
    ws(2, 'ב', [{ product: 'teder', monthly: 790, state: 'ending' }, { product: 'toran', monthly: 1190, state: 'late', nextChargeOn: '2026-10-20' }]),
    ws(3, 'ג', [{ product: 'toran', monthly: 590, state: 'waiting' }]),
    ws(4, 'ד', [{ product: 'teder', monthly: 1180, vat: 'included', state: 'paid', nextChargeOn: '2026-11-20' }]),
    { ...ws(5, 'ה', [{ product: 'toran', monthly: 9999, state: 'paid' }]), disabled: true },
  ], '2026-10-24');
  assert.equal(m.mrr, 590 + 790 + 1000);
  assert.deepEqual(m.paying, { toran: 1, teder: 2 });
  assert.deepEqual(m.late.map((x) => [x.w.name, x.since]), [['ב', '2026-10-20']]);
  assert.deepEqual(m.waiting.map((x) => x.w.name), ['ג']);
  assert.deepEqual(m.renewals.map((x) => [x.w.name, x.on]), [['א', '2026-10-27']]);
});

test('the funnel counts each stage and its rate from the one before; customers are accounts\' word', async () => {
  const app = await testApp();
  try {
    await store(app, 'a.example', { page_built_at: ago(10), sent_at: ago(9), opened_at: ago(8), demo_started_at: ago(7), replied_at: ago(6) });
    await store(app, 'b.example', { page_built_at: ago(10), sent_at: ago(9) });
    await store(app, 'c.example', { qualified: false });
    const f = await funnels(app, [ws(1, 'א', [{ product: 'toran', state: 'paid', startedOn: new Date().toISOString().slice(0, 10) }])]);
    assert.deepEqual(f.toran.map((s) => [s.key, s.all]), [['found', 3], ['qualified', 2], ['page', 2], ['sent', 2], ['opened', 1], ['demo', 1], ['replied', 1], ['customers', 1]]);
    assert.equal(rate(f.toran, 4, 'all'), 50);
    assert.equal(rate(f.teder, 1, 'all'), null, 'nothing before it: no rate');
  } finally {
    await app.db.close();
  }
});

test("the dashboard is accounts' /admin's: Toran gives it as data on /internal/ops, from this machine with the token only, and Today shows Toran alone", async () => {
  const s = await serve();
  try {
    const id = await store(s.app, 'zz.example', { status: 'page_ready', approved_at: ago(1), page_built_at: ago(1), contact_whatsapp: '972500000316' });
    const token = { authorization: `Bearer ${INTERNAL_TOKEN}` };
    const get = (h: Record<string, string>) => fetch(`${s.base}/internal/ops`, { headers: h });
    assert.equal((await get({})).status, 401, 'no token: 401 bad_token, as the contract says');
    assert.equal((await get({ ...token, 'x-forwarded-for': '1.2.3.4' })).status, 403, 'never through Caddy');
    const r = await get(token);
    assert.equal(r.status, 200);
    const d = await r.json();
    const item = d.items.find((i: any) => i.key === `toran:${id}`);
    assert.equal(item.reason, 'first_send');
    assert.match(item.leadUrl, new RegExp(`/lead/${id}$`));
    assert.equal(d.funnels.toran.at(-1).key, 'customers');
    assert.equal(d.funnels.toran.at(-1).all, null, "customers are accounts' to fill");
    assert.deepEqual([d.ourNumber, d.demoLine], [null, { live: true, via: 'sim', number: '972500000999' }], 'no number of ours connected; the simulator is the phone here');
    s.app.env.TORAN_ENV = 'prod';
    assert.deepEqual((await (await get(token)).json()).demoLine, { live: false, via: 'sim', number: '972500000999' }, 'on the VPS the simulator reaches nobody');
    delete s.app.env.TORAN_ENV;

    const post = (path: string, body: unknown) => fetch(`${s.base}/internal/ops/${path}`, { method: 'POST', headers: { ...token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const sent = await post(`toran/${id}/sent`, { by: 'operator@example.test' });
    assert.deepEqual(await sent.json(), { ok: true, message: 'סומן שנשלח. התזכורת האחת תחכה ברשימה בעוד ארבעה ימים.' });
    const again = await post(`toran/${id}/sent`, { by: 'op' });
    assert.equal(again.status, 400);
    assert.match((await again.json()).error, /כבר סומן/);
    assert.equal((await fetch(`${s.base}/internal/ops/toran/${id}/lost`, { method: 'POST', body: '{}' })).status, 401, 'no token: 401 bad_token');
    assert.equal((await s.app.db.one<any>("SELECT actor FROM audit WHERE action = 'ops_sent'")).actor, 'operator@example.test');

    // Toran's own site shows Toran only: no cross-product dashboard on Today, for anyone.
    s.login();
    const home = await (await s.get('/')).text();
    assert.doesNotMatch(home, /לפנות היום|לקוחות וכסף|המשפך/);
    assert.match(home, /מוכנים לשליחה/);
    const cust = s.accounts.session(customer(5));
    s.as(cust.cookie);
    assert.doesNotMatch(await (await s.get('/')).text(), /לפנות היום/);
  } finally {
    await s.close();
  }
});

test('Teder not answering: the copy from before stays, and syncTeder says it failed', async () => {
  const app = await testApp();
  try {
    Object.assign(app.env, { OF_INTERNAL_TOKEN: INTERNAL_TOKEN, TEDER_SITE_INTERNAL: 'http://127.0.0.1:9', OF_ACCOUNTS_INTERNAL: 'http://127.0.0.1:9' });
    await app.db.query("INSERT INTO teder_leads (id, domain, status, page_url, whatsapp, approved_at) VALUES ('3', 'kept.example', 'approved', 'https://teder.example/s/k', '972500000317', now())");
    assert.equal(await syncTeder(app), false);
    assert.equal(await customers(app), null);
    assert.ok((await queue(app)).items.some((i) => i.key === 'teder:3'));
  } finally {
    await app.db.close();
  }
});

test("one number for us and the demos: the page's own messages reach the operator, not the demo's reply", async () => {
  const { handleInbound } = await import('../src/channels/route.ts');
  const { PAGE_ABOUT, PAGE_DOWN } = await import('../src/offer.ts');
  const app = await testApp();
  try {
    app.env.DEMO_WA_NUMBER = app.env.TORAN_OWNER_WHATSAPP = '972500000999';
    const id = await store(app, 'shop.example', { status: 'sent', approved_at: ago(10), page_built_at: ago(10), sent_at: ago(5) });
    const down = await handleInbound(app, { from: '972500000321', text: `${PAGE_DOWN} לshop? https://toran.example/s/shop-x1`, id: 'p1', at: Date.now() });
    assert.equal(down.action, 'takedown');
    assert.match(down.reply!, /נוריד את העמוד/);
    assert.ok((await app.db.one<any>('SELECT takedown_asked_at FROM stores WHERE id = $1', [id])).takedown_asked_at, 'Today lists it');
    const about = await handleInbound(app, { from: '972500000322', text: `${PAGE_ABOUT} לshop: https://toran.example/s/shop-x1`, id: 'p2', at: Date.now() });
    assert.equal(about.action, 'contact');
    const c = await app.db.one<any>("SELECT c.handoffs FROM conversations c WHERE c.peer = '972500000322'");
    assert.equal(c.handoffs, 1, 'handed to the operator, in the store\'s chat');
    // Anything else without a code is still the demo's "press the button" answer.
    assert.equal((await handleInbound(app, { from: '972500000323', text: 'היי, מה זה?', id: 'p3', at: Date.now() })).action, 'no_binding');
  } finally {
    await app.db.close();
  }
});

test('a demo asked for on the website goes out by itself once its page is public, once, inside the 23 hours', async () => {
  const { discover } = await import('../src/leads/discover.ts');
  const { ingestStore } = await import('../src/ingest/pack.ts');
  const { buildPitch } = await import('../src/pitch/build.ts');
  const { setOffer } = await import('../src/offer.ts');
  const { deliverRequested } = await import('../src/ops/actions.ts');
  const app = await testApp();
  try {
    Object.assign(app.env, { DEMO_WA_NUMBER: '972500000999', TORAN_OWNER_WHATSAPP: '972500000999', PUBLIC_BASE_URL: 'https://toran.example' });
    await setOffer(app.db, { monthly: 199, vat: 'excluded', setup: 0, city: 'אשדוד' });
    await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
    const s = (await app.db.one<any>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!;
    await app.db.query("INSERT INTO demo_requests (code, url, domain, phone, claimed_at) VALUES ('REQ-DDDDDD', 'https://kli-cheres.example/', 'kli-cheres.example', $1, $2)", [PHONE, ago(1)]);
    assert.equal(await deliverRequested(app), 0, 'no page yet: nothing');
    await ingestStore(app, s.id);
    await buildPitch(app, s.id);
    assert.ok((await app.db.one<any>('SELECT approved_at FROM stores WHERE id = $1', [s.id])).approved_at, 'nothing missing: the page approved itself');
    assert.equal(await deliverRequested(app), 1);
    const out = app.wa.outbox!.at(-1)!;
    assert.equal(out.to, PHONE);
    assert.match(out.text, /הדמו של תורן[^]*https:\/\/toran\.example\/s\//);
    assert.equal(await deliverRequested(app), 0, 'once');
    assert.ok((await app.db.one<any>('SELECT sent_at FROM stores WHERE id = $1', [s.id])).sent_at);
    // Past the 23 hours it waits for the operator, who sends it from their own WhatsApp.
    await app.db.query("UPDATE stores SET sent_at = NULL WHERE id = $1", [s.id]);
    await app.db.query("UPDATE demo_requests SET claimed_at = now() - interval '25 hours'");
    assert.equal(await deliverRequested(app), 0);
  } finally {
    await app.db.close();
  }
});

test("our number not connected (the simulator on the VPS): the send-now button is refused, nothing goes or is marked sent, the links wait; on Meta they go", async () => {
  const { discover } = await import('../src/leads/discover.ts');
  const { ingestStore } = await import('../src/ingest/pack.ts');
  const { buildPitch } = await import('../src/pitch/build.ts');
  const { setOffer } = await import('../src/offer.ts');
  const { deliverRequested } = await import('../src/ops/actions.ts');
  const { demoLine } = await import('../src/channels/lines.ts');
  const s = await serve();
  const { app } = s;
  try {
    Object.assign(app.env, { OF_INTERNAL_TOKEN: INTERNAL_TOKEN, TORAN_ENV: 'prod', PUBLIC_BASE_URL: 'https://toran.example' });
    assert.deepEqual(await demoLine(app).then((l) => [l.via, l.live]), ['sim', false], 'prod on the simulator: not live');
    const asked = await store(app, 'asked.example', { status: 'page_ready', approved_at: ago(1), page_built_at: ago(1), contact_whatsapp: PHONE });
    await app.db.query("INSERT INTO demo_requests (code, url, domain, phone, claimed_at) VALUES ('REQ-LIVE01', 'https://asked.example/', 'asked.example', $1, $2)", [PHONE, ago(2)]);
    await setOffer(app.db, { monthly: 199, vat: 'excluded', setup: 0, city: 'אשדוד' });
    await discover(app.db, (async function* () { yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
    const auto = (await app.db.one<any>("SELECT id FROM stores WHERE domain = 'kli-cheres.example'"))!.id;
    await ingestStore(app, auto);
    await buildPitch(app, auto);
    await app.db.query("INSERT INTO demo_requests (code, url, domain, phone, claimed_at) VALUES ('REQ-LIVE02', 'https://kli-cheres.example/', 'kli-cheres.example', '972500000341', $1)", [ago(1)]);
    const outbox = app.wa.outbox!.length;

    await assert.rejects(sendDirect(app, String(asked), 'op'), (e: any) => e instanceof OpsError && e.message === NOT_LIVE);
    const r = await fetch(`${s.base}/internal/ops/toran/${asked}/direct`, { method: 'POST', headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, 'content-type': 'application/json' }, body: '{"by":"op"}' });
    assert.deepEqual([r.status, await r.json()], [400, { ok: false, error: NOT_LIVE }], 'the button says why');
    assert.equal(await deliverRequested(app), 0, 'the link that goes by itself waits');
    assert.equal(app.wa.outbox!.length, outbox, 'nothing went into the simulator');
    assert.deepEqual((await app.db.query<any>('SELECT sent_at FROM stores WHERE id IN ($1, $2)', [asked, auto])).map((x) => x.sent_at), [null, null], 'nothing marked sent');
    assert.equal((await app.db.query("SELECT 1 FROM audit WHERE action IN ('ops_sent', 'ops_direct')")).length, 0);
    const card = (await queue(app)).items.find((i) => i.key === `toran:${asked}`)!;
    assert.equal(card.direct, false, 'no send-now button');
    assert.match(card.message!, /^היי, כאן OpenFrequency\. ביקשתם באתר דמו של תורן/, 'the message for the operator\'s own WhatsApp');

    // Our number on Meta: the same two go, from it, and are marked sent.
    const meta = fakeMetaSends();
    Object.assign(app.env, META_DEMO);
    app.graph = meta.f;
    assert.deepEqual(await demoLine(app).then((l) => [l.via, l.live]), ['meta', true]);
    assert.equal((await queue(app)).items.find((i) => i.key === `toran:${asked}`)!.direct, true);
    await sendDirect(app, String(asked), 'op');
    assert.equal(await deliverRequested(app), 1);
    assert.deepEqual(meta.sent.map((m) => m.to), [PHONE, '972500000341']);
    assert.match(meta.sent[0].text, /^הדמו של תורן ל־asked מוכן[^]*https:\/\/toran\.example\/s\/asked-x1/);
    assert.ok((await app.db.query<any>('SELECT sent_at FROM stores WHERE id IN ($1, $2)', [asked, auto])).every((x) => x.sent_at));
    assert.equal(app.wa.outbox!.length, outbox, 'the simulator still has nothing');
  } finally {
    await s.close();
  }
});

test('a demo asked for on the website with nothing to send is listed, with why', async () => {
  const { stuckRequests } = await import('../src/ops/queue.ts');
  const app = await testApp();
  try {
    await store(app, 'konimbo-shop.example', { platform: 'konimbo' });
    await app.db.query("INSERT INTO demo_requests (code, url, domain, phone, claimed_at) VALUES ('REQ-EEEEEE', 'https://konimbo-shop.example/', 'konimbo-shop.example', $1, now()), ('REQ-FFFFFF', 'https://gone.example/', 'gone.example', '972500000331', now())", [PHONE]);
    const s = await stuckRequests(app);
    assert.deepEqual(s.map((x) => [x.domain, x.why]), [['konimbo-shop.example', 'האתר על Konimbo, ותורן בונה דמו רק לחנויות Shopify, WooCommerce, Wix ו־Cashcow'], ['gone.example', 'לא הצלחנו לקרוא את האתר']]);
    // Each with a message for its reason, written in the link to the number that asked.
    assert.deepEqual(s.map((x) => x.message), [
      'היי, כאן OpenFrequency. ביקשתם באתר דמו של תורן ל־konimbo-shop. תורן בונה דמו רק לחנויות Shopify, WooCommerce, Wix ו־Cashcow, והחנות על Konimbo, אז לא יכולנו לבנות אותו. אם יש שאלה, אפשר לענות כאן.',
      'היי, כאן OpenFrequency. ביקשתם באתר דמו של תורן ל־gone.example, ולא הצלחנו לבנות אותו. אם יש שאלה, אפשר לענות כאן.',
    ]);
    assert.deepEqual(s.map((x) => [x.product, x.target.kind, x.target.label]), [['toran', 'whatsapp', 'להעתיק ולפתוח וואטסאפ'], ['toran', 'whatsapp', 'להעתיק ולפתוח וואטסאפ']]);
    assert.equal(s[1].target.href, `https://wa.me/972500000331?text=${encodeURIComponent(s[1].message!)}`);
    // A page still being built: the link comes once it is ready.
    await app.db.query("INSERT INTO jobs (kind, dedupe_key, status, payload) VALUES ('add_store', 'add:gone.example', 'queued', '{}')");
    const building = (await stuckRequests(app)).find((x) => x.domain === 'gone.example')!;
    assert.deepEqual([building.why, building.message], ['הדף בבנייה', 'היי, כאן OpenFrequency. ביקשתם באתר דמו של תורן ל־gone.example. הוא עוד בבנייה, ונשלח לכם את הלינק כשיהיה מוכן.']);
  } finally {
    await app.db.close();
  }
});
