import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/core/paths.ts';
import { INTERNAL_TOKEN } from './helpers.ts';
import { serve } from './serve.ts';

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
    assert.ok(one.lead.links.toranPage.endsWith(`/admin/toran/lead/${ready}`));

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
  const state: { lead: any; built: number; marked: any[] } = { lead: null, built: 0, marked: [] };
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
