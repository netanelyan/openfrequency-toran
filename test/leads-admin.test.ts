import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/core/paths.ts';
import { INTERNAL_TOKEN } from './helpers.ts';
import { serve } from './serve.ts';
import { enqueue } from '../src/jobs/queue.ts';
import { readSocial, SOCIAL_UNREAD } from '../src/leads/social.ts';

// The shared lead dashboard's data, for accounts' /admin/leads (the owner, 2026-11-08: "make the shared lead dashboard
// be in the admin dashboard, not in one of the products"; ops/leadsAdmin.ts): Toran's stores that are leads, each
// merged with its Teder lead by Toran's id, else by the domain, and Teder's leads Toran has no store for; where each
// stands; one lead's page with which messages can go; and a lead's buttons. Teder is a stand-in answering its list as
// test/fixtures/teder-leads.json says (the same file in Teder).

const CONTRACT = JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', 'teder-leads.json'), 'utf8'));
const EXAMPLE = CONTRACT.routes.find((r: any) => r.path === '/internal/leads/list').answers[0].body.leads[0];
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

async function stubTeder(leads: any[]) {
  const srv = createServer((req, res) => {
    const p = new URL(req.url || '/', 'http://teder').pathname;
    res.writeHead(p === '/internal/leads/list' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(p === '/internal/leads/list' ? { ok: true, leads } : { error: 'not_found' }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise((r) => srv.close(r)) };
}

test('one list for both products: merged by Toran\'s id, else the domain; Teder-only leads apart; where each stands; filtered and searched', async () => {
  const s = await serve();
  const add = async (domain: string, cols: Record<string, unknown> = {}) => {
    const all: Record<string, unknown> = { domain, url: `https://${domain}/`, name: domain.split('.')[0], platform: 'shopify', source: 'seed', slug: `${domain.split('.')[0]}-c1`, score: 50, qualified: true, ...cols };
    const keys = Object.keys(all);
    return (await s.app.db.one<{ id: number }>(`INSERT INTO stores (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(all)))!.id;
  };
  const ready = await add('merged-by-id.example', { status: 'page_ready', approved_at: ago(1), page_built_at: ago(1), contact_whatsapp: '972500000401' });
  const byDomain = await add('merged-by-domain.example');
  const talking = await add('answered.example', { status: 'sent', approved_at: ago(100), page_built_at: ago(100), sent_at: ago(50), replied_at: ago(5) });
  await add('customer.example', { workspace_id: 3, source: 'signup' });
  const teder = await stubTeder([
    { ...EXAMPLE, id: 1, toranId: String(ready), domain: 'merged-by-id.example' },
    { ...EXAMPLE, id: 2, toranId: null, domain: 'www.merged-by-domain.example', stage: 'sent', sentAt: ago(2) },
    { ...EXAMPLE, id: 3, toranId: null, domain: 'teder-only.example', name: 'רק בתדר', stage: 'new', demo: null },
  ]);
  s.app.env.TEDER_SITE_INTERNAL = teder.base;
  const get = (p: string) => fetch(`${s.base}${p}`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } }).then((r) => r.json());
  try {
    const all = await get('/internal/leads');
    assert.equal(all.teder.ok, true);
    const row = (id: number) => all.leads.find((x: any) => x.id === id);
    assert.deepEqual([row(ready).where, row(ready).toran.state, row(ready).teder.state], ['ready', 'ready', 'ready'], 'merged by Toran\'s id');
    assert.deepEqual([row(byDomain).where, row(byDomain).teder.sentAt !== null], ['sent', true], 'merged by the domain, www. left out');
    assert.equal(row(talking).where, 'talking');
    assert.ok(!all.leads.some((x: any) => x.domain === 'customer.example'), "a customer's store is not a lead");
    assert.deepEqual(all.tederOnly.map((x: any) => [x.domain, x.where, x.teder.state]), [['teder-only.example', 'new', 'none']]);
    assert.equal(all.counts.all, all.leads.length + all.tederOnly.length);
    const readyOnly = await get('/internal/leads?where=ready');
    // The seeded store's demo page lacks nothing now that its price is the plans' (src/offer.ts, 2026-11-12: every page
    // had a "price" gap while no price was typed), so it is ready too.
    assert.deepEqual(readyOnly.leads.map((x: any) => x.id).sort((x: number, y: number) => x - y), [s.seeded.storeId, ready].sort((x, y) => x - y));
    assert.deepEqual((await get('/internal/leads?q=answered')).leads.map((x: any) => x.id), [talking]);

    // One lead: both demos up and nothing sent, so the message with both is the main way when our number is on.
    const one = await get(`/internal/leads/${ready}`);
    assert.equal(one.lead.send.stage, 'first');
    assert.match(one.lead.send.toranText, /merged-by-id|merged/);
    assert.equal(one.lead.links, undefined, 'no links to the products\' own pages');
    assert.doesNotMatch(JSON.stringify(one), /\/admin\/(?:toran|teder)\b|\/demos\/\d|leads\?tab=/, 'nothing points at an old front');
    assert.doesNotMatch(JSON.stringify(all), /\/admin\/(?:toran|teder)\b|\/demos\/\d|leads\?tab=/);

    // Teder down: the list still answers, every teder state none.
    s.app.env.TEDER_SITE_INTERNAL = 'http://127.0.0.1:9';
    const down = await get('/internal/leads');
    assert.equal(down.teder.ok, false);
    assert.ok(down.leads.every((x: any) => x.teder.state === 'none') && down.tederOnly.length === 0);
  } finally {
    await teder.close();
    await s.close();
  }
});

test("a lead's buttons: notes saved, a store skipped leaves the list's open stages, a build refused for a platform Toran cannot read", async () => {
  const s = await serve();
  const post = (p: string, body: unknown) => fetch(`${s.base}${p}`, { method: 'POST', headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    const id = (await s.app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, score, qualified) VALUES ('buttons.example', 'https://buttons.example/', 'buttons', 'magento', 'seed', 'buttons-c1', 50, true) RETURNING id"))!.id;
    assert.deepEqual(await post(`/internal/leads/${id}/notes`, { by: 'Admin', notes: 'לחזור בחמישי' }), { status: 200, json: { ok: true, message: 'ההערות נשמרו.' } });
    assert.equal((await s.app.db.one<{ notes: string }>('SELECT notes FROM stores WHERE id = $1', [id]))!.notes, 'לחזור בחמישי');
    const refused = await post(`/internal/leads/${id}/build-toran`, { by: 'Admin' });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /תורן קורא כרגע רק/);
    assert.equal((await post(`/internal/leads/${id}/skip`, { by: 'Admin', reason: 'לא מתאים' })).status, 200);
    const list = await fetch(`${s.base}/internal/leads?where=closed`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } }).then((r) => r.json());
    assert.ok(list.leads.some((x: any) => x.id === id), 'a skipped store is closed');
  } finally {
    await s.close();
  }
});

/** Teder for one store: what it has of it (nothing at first), that lead on its list, a demo built on asking, each mark kept. */
async function tederFor(domain: string, toranId: () => number) {
  const answer = (p: string) => CONTRACT.routes.find((r: any) => r.path === p).answers[0].body;
  const state: { lead: any; built: number; marked: any[]; moved: any[]; acted: any[] } = { lead: null, built: 0, marked: [], moved: [], acted: [] };
  const srv = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const p = new URL(req.url || '/', 'http://teder').pathname;
    const out = (status: number, b: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (p === '/internal/leads/state') return out(200, { ok: true, lead: state.lead });
    if (p === '/internal/leads/list') return out(200, { ok: true, leads: state.lead ? [{ ...state.lead, toranId: String(toranId()), domain, name: null }] : [] });
    if (p === '/internal/leads/demo') {
      state.built++;
      state.lead = answer('/internal/leads/demo').lead;
      return out(200, answer('/internal/leads/demo'));
    }
    if (p === '/internal/leads/mark') {
      state.marked.push(JSON.parse(raw));
      return out(200, answer('/internal/leads/mark'));
    }
    if (p === '/internal/leads/stage') {
      const b = JSON.parse(raw);
      state.moved.push(b);
      if (state.lead) state.lead = { ...state.lead, stage: b.stage === 'back' ? 'new' : b.stage };
      return out(200, answer('/internal/leads/stage'));
    }
    if (p === '/internal/leads/demo-act') {
      const b = JSON.parse(raw);
      state.acted.push(b);
      if (state.lead?.demo && b.act === 'remove') state.lead = { ...state.lead, demo: { ...state.lead.demo, status: 'removed', pageUrl: null } };
      return out(200, answer('/internal/leads/demo-act'));
    }
    return out(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { state, ready: answer('/internal/leads/state').lead, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise((r) => srv.close(r)) };
}

test("a demo made from the list (the owner, 2026-11-11): each row says what can be built; the choice is kept and leads the message; each message as the store reads it; \"שלחתי\" marks the demo it was for", async () => {
  const s = await serve();
  let id = 0;
  const teder = await tederFor('pick.example', () => id);
  s.app.env.TEDER_SITE_INTERNAL = teder.base;
  const auth = { authorization: `Bearer ${INTERNAL_TOKEN}` };
  const get = (p: string) => fetch(`${s.base}${p}`, { headers: auth }).then((r) => r.json());
  const post = (p: string, body: unknown) => fetch(`${s.base}${p}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const row = async () => (await get('/internal/leads')).leads.find((x: any) => x.id === id);
  const chosen = async () => (await s.app.db.one<{ demo_for: string | null }>('SELECT demo_for FROM stores WHERE id = $1', [id]))!.demo_for;
  try {
    id = (await s.app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, score, qualified, contact_whatsapp) VALUES ('pick.example', 'https://pick.example/', 'pick', 'shopify', 'seed', 'pick-c1', 60, true, '972500000403') RETURNING id"))!.id;
    // Nothing yet: either one, or both at once.
    assert.deepEqual([(await row()).build, (await row()).chosen], [{ toran: true, teder: true, both: true, toranWhyNot: null, go: { both: { can: true, makes: ['toran', 'teder'] }, toran: { can: true, makes: ['toran'] }, teder: { can: true, makes: ['teder'] } } }, null]);

    // Teder's alone, then Toran's too: the choice becomes both.
    assert.equal((await post(`/internal/leads/${id}/build-teder`, { by: 'Admin' })).status, 200);
    assert.equal(teder.state.built, 1);
    assert.deepEqual([(await row()).chosen, (await row()).build.teder, (await row()).build.both], ['teder', false, false], 'Teder is being built: no second one');
    assert.equal((await post(`/internal/leads/${id}/build-toran`, { by: 'Admin' })).status, 200);
    assert.equal(await chosen(), 'both');
    // Reading Toran's built page again is not a choice.
    await s.app.db.query("UPDATE stores SET demo_for = 'teder', page_built_at = now() WHERE id = $1", [id]);
    assert.equal((await post(`/internal/leads/${id}/build-toran`, { by: 'Admin' })).status, 200);
    assert.equal(await chosen(), 'teder');

    // Toran's page waits for the operator's look: no message for it, nothing to copy.
    await s.app.db.query("UPDATE jobs SET status = 'done' WHERE kind = 'ingest'");
    let one = (await get(`/internal/leads/${id}`)).lead;
    assert.deepEqual([one.send.toranText, one.send.bothText, one.send.copy], [null, null, null]);

    // Both up, our number not connected: each message to copy, with its demo's link in it.
    await s.app.db.query('UPDATE stores SET approved_at = now() WHERE id = $1', [id]);
    teder.state.lead = teder.ready;
    one = (await get(`/internal/leads/${id}`)).lead;
    const toranUrl = one.toran.pageUrl;
    const tederUrl = teder.ready.demo.pageUrl;
    assert.deepEqual([one.send.pitchable, one.send.options], [false, []]);
    assert.ok(one.send.toranText.includes(toranUrl) && !one.send.toranText.includes(tederUrl), "Toran's: its page only");
    assert.ok(one.send.tederText.includes(tederUrl) && !one.send.tederText.includes(toranUrl), "Teder's: its demo only");
    assert.match(one.send.tederText, /מצגת אחת לדוגמה/);
    assert.ok(one.send.bothText.includes(toranUrl) && one.send.bothText.includes(tederUrl), 'both: both links');
    assert.equal(one.send.copy.href, 'https://wa.me/972500000403', 'the chat, the message written in by accounts');

    // From our number: the chosen one is the main way, and the texts are the templates' words.
    s.app.env.META_OUTREACH_PHONE_ID = '1234567890';
    one = (await get(`/internal/leads/${id}`)).lead;
    assert.deepEqual([one.send.options, one.send.main], [['teder', 'both', 'toran'], 'teder']);
    assert.match(one.send.tederText, /בכפתור כאן למטה/);
    await s.app.db.query('UPDATE stores SET demo_for = NULL WHERE id = $1', [id]);
    assert.equal((await get(`/internal/leads/${id}`)).lead.send.main, 'both', 'nothing chosen: both, as before');

    // The owner, 2026-11-12: "Lead page shouldnt let me send a message while a demo is being built". Toran's page
    // made again (a new sample chat), or Teder's demo written again: no message is due, and a press refused.
    await enqueue(s.app.db, 'pitch', { storeId: id, by: 'Admin' }, { dedupeKey: `pitch:${id}` });
    one = (await get(`/internal/leads/${id}`)).lead;
    assert.deepEqual([one.send.options, one.send.main, one.send.toranText, one.send.tederText, one.send.bothText, one.send.copy], [[], null, null, null, null, null]);
    for (const p of ['send-toran', 'send-teder', 'send-both']) assert.deepEqual(await post(`/internal/leads/${id}/${p}`, { by: 'Admin' }), { status: 400, json: { ok: false, error: 'הדף של תורן עוד נבנה. אפשר יהיה לשלוח כשהוא מוכן.' } });
    await s.app.db.query("UPDATE jobs SET status = 'done' WHERE kind = 'pitch'");
    teder.state.lead = { ...teder.ready, demo: { ...teder.ready.demo, status: 'building', building: true, pageUrl: null } };
    assert.deepEqual((await get(`/internal/leads/${id}`)).lead.send.options, []);
    assert.deepEqual(await post(`/internal/leads/${id}/send-toran`, { by: 'Admin' }), { status: 400, json: { ok: false, error: 'הדמו של תדר עוד נבנה. אפשר יהיה לשלוח כשהוא מוכן.' } });
    // A build a restart cut off (still marked building, nothing building it): failed, built again from here, and it
    // holds no message for good.
    teder.state.lead = { ...teder.ready, demo: { ...teder.ready.demo, status: 'building', building: false, pageUrl: null } };
    one = (await get(`/internal/leads/${id}`)).lead;
    assert.deepEqual([one.teder.state, one.teder.error, (await row()).build.teder], ['failed', 'הבנייה של הדמו נעצרה באמצע. אפשר לבנות אותו שוב.', true]);
    assert.deepEqual(one.send.options, ['toran'], "Toran's message alone can go");
    teder.state.lead = teder.ready;
    assert.equal((await get(`/internal/leads/${id}`)).lead.send.options.length, 3, 'built: the messages are due again');
    delete s.app.env.META_OUTREACH_PHONE_ID;

    // Sent by hand: Teder's alone marks Teder, and Toran stays to send.
    const t1 = await post(`/internal/leads/${id}/mark-sent`, { by: 'Admin', product: 'teder' });
    assert.deepEqual(t1, { status: 200, json: { ok: true, message: 'סומן שנשלח בתדר. התזכורת האחת תחכה בעוד ארבעה ימים.' } });
    assert.deepEqual(teder.state.marked.map((m) => m.stage), ['first']);
    assert.equal((await s.app.db.one<{ sent_at: string | null }>('SELECT sent_at FROM stores WHERE id = $1', [id]))!.sent_at, null);
    // Teder's went already: refused, nothing marked.
    teder.state.lead = { ...teder.ready, stage: 'sent', sentAt: new Date().toISOString() };
    const again = await post(`/internal/leads/${id}/mark-sent`, { by: 'Admin', product: 'teder' });
    assert.deepEqual([again.status, again.json.error], [400, 'לתדר אין עכשיו הודעה ראשונה לסמן לחנות הזו.']);
    assert.equal(teder.state.marked.length, 1);
    // Both in one message: Toran's lead and Teder's lead marked.
    teder.state.lead = teder.ready;
    const both = await post(`/internal/leads/${id}/mark-sent`, { by: 'Admin', product: 'both' });
    assert.equal(both.status, 200, JSON.stringify(both.json));
    assert.ok((await s.app.db.one<{ sent_at: string | null }>('SELECT sent_at FROM stores WHERE id = $1', [id]))!.sent_at, "Toran's lead marked sent");
    assert.deepEqual(teder.state.marked.map((m) => m.stage), ['first', 'first']);
  } finally {
    await teder.close();
    await s.close();
  }
});

// The owner, 2026-11-12: "i dont see a button for going on with teder/toran/both for each lead". A lead whose Toran page
// was up offered Teder alone, and never both again: the choice is now what the lead goes on with, whatever is built.
test('going on with Toran, Teder or both: each can be chosen whatever is built, only what is missing is made, and the line says whether the message can go', async () => {
  const s = await serve();
  let id = 0;
  const teder = await tederFor('go.example', () => id);
  s.app.env.TEDER_SITE_INTERNAL = teder.base;
  const auth = { authorization: `Bearer ${INTERNAL_TOKEN}` };
  const get = (p: string) => fetch(`${s.base}${p}`, { headers: auth }).then((r) => r.json());
  const post = (p: string) => fetch(`${s.base}${p}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ by: 'Admin' }) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const row = async () => (await get('/internal/leads')).leads.find((x: any) => x.id === id);
  const chosen = async () => (await s.app.db.one<{ demo_for: string | null }>('SELECT demo_for FROM stores WHERE id = $1', [id]))!.demo_for;
  const ingests = async () => (await s.app.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM jobs WHERE kind = 'ingest' AND (payload->>'storeId')::int = $1", [id]))!.n;
  try {
    // Toran's page is up and approved, Teder has nothing: the first demo the owner opened was such a store.
    id = (await s.app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, score, qualified, status, page_built_at, approved_at, contact_whatsapp) VALUES ('go.example', 'https://go.example/', 'go', 'shopify', 'seed', 'go-c1', 60, true, 'page_ready', now(), now(), '972500000404') RETURNING id"))!.id;
    assert.deepEqual((await row()).build.go, { both: { can: true, makes: ['teder'] }, toran: { can: true, makes: [] }, teder: { can: true, makes: ['teder'] } }, "both can still be chosen: it makes Teder's");

    // Toran alone: nothing to make, the message can go.
    assert.deepEqual(await post(`/internal/leads/${id}/go-toran`), { status: 200, json: { ok: true, message: 'ממשיכים עם תורן. ההודעה מוכנה לשליחה.', ready: true } });
    assert.deepEqual([await chosen(), teder.state.built, await ingests()], ['toran', 0, 0], "Toran's page is not read again");

    // Both: Teder's demo made, Toran's kept; the choice is both as said, not merged.
    const both = await post(`/internal/leads/${id}/go-both`);
    assert.equal(both.status, 200);
    assert.equal(both.json.ready, false);
    assert.match(both.json.message, /^ממשיכים עם תורן ותדר\. תדר: /);
    assert.deepEqual([await chosen(), teder.state.built, await ingests()], ['both', 1, 0]);

    // Teder's demo up: both again makes nothing more, and the message can go.
    teder.state.lead = teder.ready;
    assert.deepEqual((await row()).build.go.both, { can: true, makes: [] });
    assert.deepEqual(await post(`/internal/leads/${id}/go-both`), { status: 200, json: { ok: true, message: 'ממשיכים עם תורן ותדר. ההודעה מוכנה לשליחה.', ready: true } });
    assert.equal(teder.state.built, 1);
    // Teder alone, as said: the lead's page leads with Teder's message.
    assert.equal((await post(`/internal/leads/${id}/go-teder`)).json.ready, true);
    assert.equal(await chosen(), 'teder');
    s.app.env.META_OUTREACH_PHONE_ID = '1234567890';
    assert.equal((await get(`/internal/leads/${id}`)).lead.send.main, 'teder');
    delete s.app.env.META_OUTREACH_PHONE_ID;

    // Toran's page held back for a look: chosen, and the line says what it waits for.
    await s.app.db.query('UPDATE stores SET approved_at = NULL WHERE id = $1', [id]);
    assert.deepEqual(await post(`/internal/leads/${id}/go-toran`), { status: 200, json: { ok: true, message: 'ממשיכים עם תורן. הדף של תורן מחכה לבדיקה.', ready: false } });

    // A site Toran cannot read: Teder only; Toran and both are refused, and nothing changes.
    await s.app.db.query("UPDATE stores SET platform = 'other', demo_for = 'teder' WHERE id = $1", [id]);
    assert.deepEqual((await row()).build.go, { both: { can: false, makes: [] }, toran: { can: false, makes: [] }, teder: { can: true, makes: [] } });
    const no = await post(`/internal/leads/${id}/go-both`);
    assert.deepEqual([no.status, no.json.ok], [400, false]);
    assert.match(no.json.error, /אפשר להמשיך רק עם תדר/);
    assert.equal(await chosen(), 'teder');

    // Nothing built yet: both makes both, Teder's first.
    await s.app.db.query("UPDATE stores SET platform = 'shopify', page_built_at = NULL, approved_at = NULL, demo_for = NULL WHERE id = $1", [id]);
    teder.state.lead = null;
    const fresh = await post(`/internal/leads/${id}/go-both`);
    assert.deepEqual([fresh.status, fresh.json.ready, teder.state.built, await ingests(), await chosen()], [200, false, 2, 1, 'both']);
    assert.match(fresh.json.message, /תדר: .*תורן קורא את האתר ובונה את הדף/);
    // While Toran reads the site, both makes nothing twice.
    teder.state.lead = teder.ready;
    assert.deepEqual((await row()).build.go.both, { can: true, makes: [] });
    assert.deepEqual(await post(`/internal/leads/${id}/go-both`), { status: 200, json: { ok: true, message: 'ממשיכים עם תורן ותדר. תורן עוד בונה את הדף.', ready: false } });
    assert.deepEqual([teder.state.built, await ingests()], [2, 1]);
  } finally {
    await teder.close();
    await s.close();
  }
});

test('going on with Teder or both while Teder does not answer: refused in its words, and nothing is made or chosen', async () => {
  const s = await serve();
  s.app.env.TEDER_SITE_INTERNAL = 'http://127.0.0.1:9';
  s.app.log = () => {};
  const auth = { authorization: `Bearer ${INTERNAL_TOKEN}`, 'content-type': 'application/json' };
  try {
    const id = (await s.app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, score, qualified) VALUES ('down.example', 'https://down.example/', 'down', 'shopify', 'seed', 'down-c1', 60, true) RETURNING id"))!.id;
    const list = await fetch(`${s.base}/internal/leads`, { headers: auth }).then((r) => r.json());
    assert.deepEqual(list.leads.find((x: any) => x.id === id).build.go, { both: { can: false, makes: [] }, toran: { can: true, makes: ['toran'] }, teder: { can: false, makes: [] } });
    for (const p of ['both', 'teder']) {
      const r = await fetch(`${s.base}/internal/leads/${id}/go-${p}`, { method: 'POST', headers: auth, body: JSON.stringify({ by: 'Admin' }) }).then(async (x) => ({ status: x.status, json: await x.json() }));
      assert.deepEqual([r.status, r.json.ok], [400, false], p);
      assert.match(r.json.error, /תדר לא ענה/);
    }
    assert.equal((await s.app.db.one<{ demo_for: string | null }>('SELECT demo_for FROM stores WHERE id = $1', [id]))!.demo_for, null);
    assert.equal((await s.app.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM jobs WHERE kind = 'ingest'"))!.n, 0);
  } finally {
    await s.close();
  }
});

// The owner, 2026-11-12: "i want https://accounts.openfrequency.co.il/admin/leads to have everything i need for creating
// and doing leads. i want each store to have a short description, so that i will know if i should build
// toran/teder/both/neither for that store. it MUST not send me to old fronts".
test('a store in a few words: its own line, its products and prices once read, the count when found, its own profiles; nothing made up', async () => {
  const s = await serve();
  const get = (p: string) => fetch(`${s.base}${p}`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } }).then((r) => r.json());
  s.app.env.TEDER_SITE_INTERNAL = 'http://127.0.0.1:9';
  try {
    const signals = { description: 'פופים, הדומים וספות נפתחות לסלון | משלוח חינם', title: 'פופי', productCount: 250, productCountCapped: true, social: { instagram: 'https://www.instagram.com/pofi/', tiktok: 'javascript:alert(1)' } };
    const read = (await s.app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, score, qualified, signals) VALUES ('pofi.example', 'https://pofi.example/', 'פופי', 'shopify', 'seed', 'pofi-c1', 70, true, $1::jsonb) RETURNING id", [JSON.stringify(signals)]))!.id;
    const found = (await s.app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, score, qualified, signals) VALUES ('found.example', 'https://found.example/', 'found', 'woocommerce', 'seed', 'found-c1', 60, true, $1::jsonb) RETURNING id", [JSON.stringify({ title: 'found | Home', productCount: 40 })]))!.id;
    for (const [i, title, type, lo, hi] of [[1, 'פוף עגול', 'פופים', 299, 349], [2, 'פוף מרובע', 'פופים', 249, 249], [3, 'ספה נפתחת', 'ספות', 1999, 4999], [4, 'משלוח אקספרס', '', 30, 30], [5, 'מתנה', '', 0, 0]] as const) {
      await s.app.db.query('INSERT INTO products (store_id, ext_id, title, url, handle, price_min, price_max, available, product_type) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)', [read, `p${i}`, title, `https://pofi.example/products/p${i}`, `p${i}`, lo, hi, type]);
    }
    const list = await get('/internal/leads');
    const row = (id: number) => list.leads.find((x: any) => x.id === id);
    assert.equal(row(read).about, 'פופים, הדומים וספות נפתחות לסלון | משלוח חינם');
    assert.deepEqual(row(read).facts, { products: 5, productsAtLeast: false, priceMin: 249, priceMax: 4999, currency: 'ILS', kinds: ['פופים', 'ספות'], social: { instagram: 'https://www.instagram.com/pofi/', tiktok: null, facebook: null }, socialRead: true }, 'what Toran read wins over the count when found; the prices are of what it sells (no shipping line, nothing free); a profile that is not an https address is left out');
    assert.equal(row(found).about, null, 'a title that is only its name says nothing more');
    assert.deepEqual([row(found).facts.products, row(found).facts.productsAtLeast, row(found).facts.priceMin, row(found).facts.kinds], [40, false, null, []], 'not read yet: the count when it was found');
    assert.equal(row(found).facts.socialRead, false, 'found before its profiles were read: having none is not known');

    // Read now (leads/social.ts): its home page, then its contact page for a network the home page lacks; a profile
    // kept already is never replaced, and a site that does not answer stays unread.
    const pages: Record<string, string> = {
      'https://found.example/': '<html><body><a href="https://www.instagram.com/found.shop/">IG</a><a href="/pages/contact">צור קשר</a></body></html>',
      'https://found.example/pages/contact': '<html><body><a href="https://www.tiktok.com/@found.shop">TikTok</a></body></html>',
    };
    const asked: string[] = [];
    s.app.fetcher = async (url) => {
      asked.push(url);
      if (!pages[url]) throw new Error('not here');
      return { url, status: 200, contentType: 'text/html', text: pages[url], headers: {} };
    };
    assert.deepEqual((await s.app.db.query<{ id: number }>(`SELECT id FROM stores WHERE ${SOCIAL_UNREAD} AND id IN ($1, $2)`, [read, found])).map((r) => r.id), [found], 'only the store never read');
    assert.deepEqual(await readSocial(s.app, { id: found, url: 'https://found.example/' }), { instagram: 'https://www.instagram.com/found.shop/', tiktok: 'https://www.tiktok.com/@found.shop', facebook: null });
    const again = (await get('/internal/leads')).leads.find((x: any) => x.id === found);
    assert.deepEqual([again.facts.social, again.facts.socialRead], [{ instagram: 'https://www.instagram.com/found.shop/', tiktok: 'https://www.tiktok.com/@found.shop', facebook: null }, true]);
    assert.equal(await readSocial(s.app, { id: read, url: 'https://pofi.example/' }), null, 'did not answer');
    assert.equal((await get('/internal/leads')).leads.find((x: any) => x.id === read).facts.social.instagram, 'https://www.instagram.com/pofi/', 'nothing written');
  } finally {
    await s.close();
  }
});

test("everything a lead needs, on the lead's page: neither, Toran's page checked and fixed, where it stands with Teder moved to match, Teder's demo worked, taken down, deleted", async () => {
  const s = await serve();
  let id = 0;
  const teder = await tederFor('every.example', () => id);
  s.app.env.TEDER_SITE_INTERNAL = teder.base;
  const auth = { authorization: `Bearer ${INTERNAL_TOKEN}` };
  const get = (p: string) => fetch(`${s.base}${p}`, { headers: auth }).then((r) => r.json());
  const post = (p: string, body: Record<string, unknown> = {}) => fetch(`${s.base}${p}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ by: 'Admin', ...body }) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const col = async (c: string) => (await s.app.db.one<any>(`SELECT ${c} AS v FROM stores WHERE id = $1`, [id]))?.v;
  try {
    id = (await s.app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, score, qualified, status, page_built_at, contact_whatsapp, brand) VALUES ('every.example', 'https://every.example/', NULL, 'shopify', 'seed', 'every-c1', 60, true, 'page_ready', now(), '972500000405', '{\"colors\": [\"#b4532a\", \"nothing\"]}'::jsonb) RETURNING id"))!.id;
    teder.state.lead = teder.ready;

    // Toran's page is checked here: it waits for a name and a sample chat, and says so; approving is refused until then.
    let one = (await get(`/internal/leads/${id}`)).lead;
    assert.deepEqual(one.review.gaps.map((g: any) => g.key).sort(), ['name', 'products', 'sample']);
    assert.deepEqual([one.review.approved, one.review.held, one.review.color, one.review.colorsFound], [false, false, '#b4532a', ['#b4532a']]);
    const refused = await post(`/internal/leads/${id}/approve-toran`);
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /^עוד אי אפשר לאשר: .*אין שם לחנות/);
    // The name and the colour are fixed here, over what the site said; a colour that is not one is refused.
    assert.equal((await post(`/internal/leads/${id}/brand`, { color: 'red' })).status, 400);
    assert.equal((await post(`/internal/leads/${id}/brand`, { name: 'כל מה שצריך', color: '#0A7D4F' })).status, 200);
    assert.deepEqual(await col('brand_override'), { name: 'כל מה שצריך', colors: ['#0a7d4f'] });
    one = (await get(`/internal/leads/${id}`)).lead;
    assert.deepEqual([one.name, one.review.name, one.review.color], ['כל מה שצריך', 'כל מה שצריך', '#0a7d4f']);
    // The sample chat made again, on its own job; the page is being built meanwhile.
    assert.equal((await post(`/internal/leads/${id}/sample`)).status, 200);
    assert.equal((await s.app.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM jobs WHERE kind = 'pitch' AND (payload->>'storeId')::int = $1", [id]))!.n, 1);
    assert.equal((await get(`/internal/leads/${id}`)).lead.review.building, true);
    await s.app.db.query("UPDATE jobs SET status = 'done' WHERE kind = 'pitch'");

    // Nothing missing: approved here, then held back, which keeps it back until it is built again.
    await s.app.db.query("INSERT INTO products (store_id, ext_id, title, url, handle, price_min, price_max, available) VALUES ($1, 'e1', 'כוס', 'https://every.example/products/cup', 'cup', 50, 50, true)", [id]);
    await s.app.db.query("INSERT INTO pitches (store_id, sample_chat, built_at) VALUES ($1, $2::jsonb, now())", [id, JSON.stringify([{ role: 'customer', text: 'יש כוס?' }, { role: 'agent', text: 'כן, 50 ₪.' }, { role: 'customer', text: 'ומשלוח?' }, { role: 'agent', text: 'תוך 3 ימים.' }])]);
    assert.deepEqual(await post(`/internal/leads/${id}/approve-toran`), { status: 200, json: { ok: true, message: 'הדף של תורן אושר, ואפשר לשלוח אותו.' } });
    assert.equal((await post(`/internal/leads/${id}/approve-toran`)).status, 400, 'once');
    assert.equal((await post(`/internal/leads/${id}/hold-toran`)).status, 200);
    one = (await get(`/internal/leads/${id}`)).lead;
    assert.deepEqual([one.review.approved, one.review.held, one.review.chat.length], [false, true, 4]);
    await post(`/internal/leads/${id}/approve-toran`);

    // They answered: Toran's lead talks, and Teder's lead says so too, so no Teder reminder goes.
    assert.equal((await post(`/internal/leads/${id}/replied`)).status, 200);
    assert.ok(await col('replied_at'));
    assert.deepEqual(teder.state.moved.map((m) => m.stage), ['replied']);
    assert.equal((await get('/internal/leads')).leads.find((x: any) => x.id === id).where, 'talking');
    // Not interested: closed on both; a reason is a must.
    assert.equal((await post(`/internal/leads/${id}/lost`, { reason: 'whatever' })).status, 400);
    assert.equal((await post(`/internal/leads/${id}/lost`, { reason: 'price' })).status, 200);
    assert.equal((await get('/internal/leads')).leads.find((x: any) => x.id === id).where, 'closed', '"לא מעוניינים" closes the lead');
    assert.deepEqual(teder.state.moved.map((m) => m.stage), ['replied', 'irrelevant']);
    // Back on the list, on both.
    assert.equal((await post(`/internal/leads/${id}/reopen`)).status, 200);
    assert.deepEqual([await col('lost_at'), teder.state.moved.map((m) => m.stage)], [null, ['replied', 'irrelevant', 'back']]);

    // Teder's demo worked from here: another topic.
    assert.deepEqual(await post(`/internal/leads/${id}/teder-other`), { status: 200, json: { ok: true, message: 'תדר: בונים את הדמו על נושא אחר.' } });
    assert.deepEqual(teder.state.acted.map((a) => [a.act, a.toran]), [['other', String(id)]]);

    // Taken down when they ask: Toran's page and Teder's demo with it, and nobody writes to them.
    const down = await post(`/internal/leads/${id}/takedown`);
    assert.equal(down.status, 200);
    assert.match(down.json.message, /העמוד של תורן הוסר.*גם הדמו של תדר הורד/);
    assert.deepEqual([Boolean(await col('taken_down_at')), await col('status'), teder.state.acted.at(-1).act], [true, 'skipped', 'remove']);
    assert.equal((await post(`/internal/leads/${id}/reopen`)).status, 400, 'a page taken down on their word stays down');

    // Deleted: Teder's lead marked not relevant first, then the store is out of Toran.
    const gone = await post(`/internal/leads/${id}/delete`);
    assert.deepEqual([gone.status, gone.json.gone], [200, true]);
    assert.equal(await col('id'), undefined);
    assert.equal(teder.state.moved.at(-1).stage, 'irrelevant');
    assert.equal((await get(`/internal/leads/${id}`)).ok, false);
  } finally {
    await teder.close();
    await s.close();
  }
});

test('neither: skipped, closed on the list, Teder\'s lead not relevant; a store Teder has a lead of is listed even when its score fell', async () => {
  const s = await serve();
  let id = 0;
  const teder = await tederFor('neither.example', () => id);
  s.app.env.TEDER_SITE_INTERNAL = teder.base;
  const auth = { authorization: `Bearer ${INTERNAL_TOKEN}` };
  const get = (p: string) => fetch(`${s.base}${p}`, { headers: auth }).then((r) => r.json());
  try {
    // Not qualified any more, and nothing built or sent: listed because Teder has a lead of it.
    id = (await s.app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, score, qualified) VALUES ('neither.example', 'https://neither.example/', 'neither', 'shopify', 'seed', 'neither-c1', 30, false) RETURNING id"))!.id;
    teder.state.lead = teder.ready;
    let list = await get('/internal/leads');
    assert.ok(list.leads.some((x: any) => x.id === id), 'listed with its Teder lead');
    assert.equal(list.tederOnly.length, 0);
    const none = await fetch(`${s.base}/internal/leads/${id}/go-none`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ by: 'Admin' }) }).then((r) => r.json());
    assert.deepEqual(none, { ok: true, message: 'לא ממשיכים עם החנות הזו, לא עם תורן ולא עם תדר. היא עברה לסגורים, ולא כותבים לה.' });
    assert.equal((await s.app.db.one<{ status: string }>('SELECT status FROM stores WHERE id = $1', [id]))!.status, 'skipped');
    assert.deepEqual(teder.state.moved.map((m) => m.stage), ['irrelevant']);
    list = await get('/internal/leads?where=closed');
    assert.ok(list.leads.some((x: any) => x.id === id));
  } finally {
    await teder.close();
    await s.close();
  }
});

test('creating leads from the list: a store added by its address is read and listed whatever its score, with nothing built; more found by a discovery run, each from the page after the last', async () => {
  const s = await serve();
  s.app.env.TEDER_SITE_INTERNAL = 'http://127.0.0.1:9';
  const auth = { authorization: `Bearer ${INTERNAL_TOKEN}` };
  const post = (p: string, body: Record<string, unknown>) => fetch(`${s.base}${p}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ by: 'Admin', ...body }) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const get = (p: string) => fetch(`${s.base}${p}`, { headers: auth }).then((r) => r.json());
  try {
    const added = await post('/internal/leads/add', { url: 'brand-new.example' });
    assert.deepEqual(added, { status: 200, json: { ok: true, message: 'קוראים את האתר. בעוד דקה החנות תופיע ברשימה, עם התיאור שלה.' } });
    const job = (await s.app.db.one<any>("SELECT payload, max_attempts FROM jobs WHERE kind = 'add_store'"))!;
    assert.deepEqual([job.payload.url, job.payload.added, job.max_attempts], ['https://brand-new.example/', true, 1]);
    assert.deepEqual((await get('/internal/leads')).adding.map((a: any) => [a.url, a.state]), [['https://brand-new.example/', 'reading']]);
    // Refused by detection: said on the list with its reason, for a day.
    await s.app.db.query("UPDATE jobs SET status = 'failed', last_error = 'האתר לא נכנס כליד: לא נמצאה חנות' WHERE kind = 'add_store'");
    assert.deepEqual((await get('/internal/leads')).adding.map((a: any) => [a.state, a.error]), [['failed', 'האתר לא נכנס כליד: לא נמצאה חנות']]);
    // One Toran knows but did not list (its score is low): listed now.
    const low = (await s.app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, score, qualified) VALUES ('low.example', 'https://low.example/', 'low', 'shopify', 'storecensus', 'low-c1', 20, false) RETURNING id"))!.id;
    assert.ok(!(await get('/internal/leads')).leads.some((x: any) => x.id === low));
    assert.deepEqual(await post('/internal/leads/add', { url: 'https://www.low.example/collections/all' }), { status: 200, json: { ok: true, message: 'החנות כבר ברשימה.', id: low } });
    assert.ok((await get('/internal/leads')).leads.some((x: any) => x.id === low), 'added by hand: listed whatever its score');
    for (const bad of ['', 'not a site', 'javascript:alert(1)']) assert.equal((await post('/internal/leads/add', { url: bad })).status, 400, bad);
    // A lead deleted since is read again: its domain was still marked seen, with no store.
    await s.app.db.query("INSERT INTO seen_domains (domain, verdict) VALUES ('deleted.example', 'lead'), ('not-a-store.example', 'rejected')");
    await post('/internal/leads/add', { url: 'deleted.example' });
    await post('/internal/leads/add', { url: 'not-a-store.example' });
    assert.deepEqual((await s.app.db.query<{ domain: string }>("SELECT domain FROM seen_domains WHERE domain IN ('deleted.example', 'not-a-store.example') ORDER BY domain")).map((r) => r.domain), ['not-a-store.example'], 'a site that is not a store stays refused');

    // Discovery: Shopify's directory from page 1, then from the page after the last run's.
    assert.equal((await post('/internal/leads/discover', {})).status, 200);
    const first = (await s.app.db.one<any>("SELECT id, payload FROM jobs WHERE kind = 'discover' ORDER BY id DESC LIMIT 1"))!;
    assert.deepEqual(first.payload, { source: 'storecensus', from: 1 });
    assert.equal((await get('/internal/leads')).discovery.running, 'storecensus');
    await s.app.db.query("UPDATE jobs SET status = 'done' WHERE id = $1", [first.id]);
    await post('/internal/leads/discover', {});
    assert.equal((await s.app.db.one<any>("SELECT payload FROM jobs WHERE kind = 'discover' ORDER BY id DESC LIMIT 1"))!.payload.from, 4);
    delete s.app.env.BRAVE_API_KEY;
    assert.equal((await post('/internal/leads/discover', { source: 'brave' })).status, 400);
    assert.ok(!(await get('/internal/leads')).discovery.sources.includes('brave'), 'Brave is offered only with its key');
  } finally {
    await s.close();
  }
});
