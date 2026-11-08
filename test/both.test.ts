import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as outreach from '../src/ops/outreach.ts';
import { setNow } from '../src/core/clock.ts';
import { ROOT } from '../src/core/paths.ts';
import { INTERNAL_TOKEN, META_DEMO } from './helpers.ts';
import { serve } from './serve.ts';

// One store, both products, on Toran's lead page (the owner, 2026-11-08: "i want to be able to build only toran or
// only teder for a page, or both. i want to be able to send them 2 demos or 1"): what Teder has of the store, its demo
// built from here, alone or with Toran's page, Teder's message alone, and one message with both demos, every one sent
// from our number under ops/outreach.ts's limits. Teder is a stand-in answering as test/fixtures/teder-leads.json says
// (the same file in Teder, whose own test serves it); Meta is a stand-in too: nothing leaves this machine.

const CONTRACT = JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', 'teder-leads.json'), 'utf8'));
const route = (p: string) => CONTRACT.routes.find((r: any) => r.path === p);
const WABA = '999888777666555';
const PHONE = '972500000123';
/** A Tuesday, 12:00 in Israel: never quiet. */
const NOON = Date.parse('2026-11-10T10:00:00.000Z');

/** Teder's three routes: `lead` is what it has of the store (the contract's example by default), each call kept. */
async function stubTeder() {
  const state: { lead: any; asked: { method: string; path: string; body: any; auth: string }[]; built: number; marked: any[] } = {
    lead: null,
    asked: [],
    built: 0,
    marked: [],
  };
  const srv = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = new URL(req.url || '/', 'http://teder');
    const body = raw ? JSON.parse(raw) : null;
    state.asked.push({ method: req.method || '', path: url.pathname, body, auth: String(req.headers.authorization || '') });
    const out = (status: number, b: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`) return out(401, { error: 'bad_token' });
    if (url.pathname === '/internal/leads/state') return out(200, { ok: true, lead: state.lead });
    if (url.pathname === '/internal/leads/demo') {
      state.built++;
      state.lead = route('/internal/leads/demo').answers[0].body.lead;
      return out(200, route('/internal/leads/demo').answers[0].body);
    }
    if (url.pathname === '/internal/leads/mark') {
      state.marked.push(body);
      return out(200, route('/internal/leads/mark').answers[0].body);
    }
    return out(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { state, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** Meta for our number: green, approved, every template send kept. */
function fakeMeta() {
  const sends: any[] = [];
  const f = (async (input: any, init: any = {}) => {
    const u = new URL(String(input));
    const p = u.pathname.replace(/^\/v\d+\.\d+\//, '');
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (init.method === 'POST' && p === `${META_DEMO.META_DEMO_PHONE_ID}/messages`) {
      sends.push(JSON.parse(String(init.body)));
      return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.out-${sends.length}` }] });
    }
    if (p === META_DEMO.META_DEMO_PHONE_ID) return json({ quality_rating: 'GREEN' });
    if (p === `${WABA}/message_templates`) return json({ data: [{ name: u.searchParams.get('name'), status: 'APPROVED', quality_score: { score: 'UNKNOWN' } }] });
    return new Response('{}', { status: 400 });
  }) as typeof fetch;
  return { f, sends };
}

async function shop() {
  const s = await serve();
  const teder = await stubTeder();
  const meta = fakeMeta();
  Object.assign(s.app.env, META_DEMO, { META_WABA_ID: WABA, TEDER_SITE_INTERNAL: teder.base, OF_INTERNAL_TOKEN: INTERNAL_TOKEN });
  s.app.graph = meta.f;
  outreach.forgetQuality();
  const id = s.seeded.storeId;
  await s.app.db.query("UPDATE stores SET contact_whatsapp = $2, approved_at = now(), qualified = true WHERE id = $1", [id, PHONE]);
  s.login();
  setNow(NOON);
  const post = async (p: string) => s.post(p, { _csrf: await s.csrf(`/lead/${id}`) }, { 'x-tn-ajax': '1' });
  return { s, teder, meta, id, post };
}

test("the lead page asks Teder about the same store; with nothing there, Teder's demo is built from here, with the store as Teder's sync gives it", async () => {
  const { s, teder, id, post } = await shop();
  try {
    const page = await (await s.get(`/lead/${id}`)).text();
    assert.match(page, /<section class="panel" id="teder"><header><h2>תדר לאותה חנות<\/h2>/);
    assert.match(page, /לתדר עוד אין דמו לחנות הזו/);
    assert.match(page, new RegExp(`action="/lead/${id}/teder-build"`));
    const asked = teder.state.asked.find((a) => a.path === '/internal/leads/state')!;
    assert.equal(asked.auth, `Bearer ${INTERNAL_TOKEN}`);
    const r = await post(`/lead/${id}/teder-build`);
    assert.equal(r.status, 200, await r.clone().text());
    assert.match((await r.json()).message, /^תדר: בונים את הדמו/);
    const sent = teder.state.asked.find((a) => a.path === '/internal/leads/demo')!.body;
    assert.equal(sent.store.id, id);
    assert.equal(sent.store.contact.whatsapp, PHONE);
    for (const k of Object.keys(route('/internal/leads/demo').request.body.store)) assert.ok(k in sent.store, `the store has ${k}, as GET /internal/stores gives it`);
    assert.match(await (await s.get(`/lead/${id}`)).text(), /בונים את הדמו של תדר/);
  } finally {
    setNow(null);
    await teder.close();
    await s.close();
  }
});

test('both demos up and neither sent: one message with both is the main action; it goes once, as openfrequency_pitch, and both are marked', async () => {
  const { s, teder, meta, id, post } = await shop();
  try {
    teder.state.lead = route('/internal/leads/state').answers[0].body.lead;
    const page = await (await s.get(`/lead/${id}`)).text();
    assert.match(page, /שני הדמואים מוכנים: תורן ותדר/);
    assert.match(page, new RegExp(`action="/lead/${id}/both-send"[^]*לשלוח את שניהם בהודעה אחת[^]*רק את תורן[^]*רק את תדר`));
    const r = await post(`/lead/${id}/both-send`);
    assert.equal(r.status, 200, await r.clone().text());
    assert.match((await r.json()).message, /הודעה אחת עם שני הדמואים[^]*גם תדר סימן/);
    assert.equal(meta.sends.length, 1);
    assert.equal(meta.sends[0].template.name, 'openfrequency_pitch');
    assert.deepEqual(meta.sends[0].template.components.filter((c: any) => c.sub_type === 'url').map((c: any) => c.parameters[0].text), [(await s.app.db.one<any>('SELECT slug FROM stores WHERE id = $1', [id])).slug, 'nurit-ceramics-a1b2c3']);
    assert.ok((await s.app.db.one<any>('SELECT sent_at FROM stores WHERE id = $1', [id])).sent_at, "Toran's lead marked sent");
    assert.deepEqual(teder.state.marked, [{ toran: String(id), domain: (await s.app.db.one<any>('SELECT domain FROM stores WHERE id = $1', [id])).domain, stage: 'first', by: 'operator' }]);
    // Again: refused before Meta, nothing marked twice.
    teder.state.lead = { ...teder.state.lead, stage: 'sent' };
    const again = await post(`/lead/${id}/both-send`);
    assert.equal(again.status, 400);
    assert.equal(meta.sends.length, 1);
  } finally {
    setNow(null);
    await teder.close();
    await s.close();
  }
});

test("Teder's message alone, after Toran's went: from our number as teder_pitch, Teder marked; Teder down says so and sends nothing", async () => {
  const { s, teder, meta, id, post } = await shop();
  try {
    await s.app.db.query("UPDATE stores SET sent_at = now(), status = 'sent', followup_due_at = now() + interval '4 days' WHERE id = $1", [id]);
    teder.state.lead = route('/internal/leads/state').answers[0].body.lead;
    const page = await (await s.get(`/lead/${id}`)).text();
    assert.doesNotMatch(page, /both-send/, 'Toran went already: no message with both');
    assert.match(page, new RegExp(`action="/lead/${id}/teder-send"[^]*לשלוח את תדר בוואטסאפ מהמספר שלנו`));
    const r = await post(`/lead/${id}/teder-send`);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(meta.sends.at(-1).template.name, 'teder_pitch');
    assert.equal(teder.state.marked.at(-1).stage, 'first');
    await teder.close();
    const down = await post(`/lead/${id}/teder-send`);
    assert.equal(down.status, 400);
    assert.match((await down.json()).message, /תדר לא ענה/);
    assert.equal(meta.sends.length, 1);
    assert.match(await (await s.get(`/lead/${id}`)).text(), /תדר לא ענה כרגע/, 'the page says it, and the rest of it works');
  } finally {
    setNow(null);
    await s.close();
  }
});
