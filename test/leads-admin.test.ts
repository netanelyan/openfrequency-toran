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
    assert.deepEqual(readyOnly.leads.map((x: any) => x.id), [ready]);
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
