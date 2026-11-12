import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drain } from '../src/jobs/worker.ts';
import { queue } from '../src/ops/queue.ts';
import { startUrl } from '../src/web/pages/start.ts';
import { claimFor, hostedDns, mask, platformOf, proofDeps } from '../src/domainProof.ts';
import { simEmail } from '../src/channels/email.ts';
import type { Fetcher } from '../src/core/http.ts';
import { customer, INTERNAL_TOKEN, testApp, viewingAs } from './helpers.ts';
import { serve } from './serve.ts';

// A new customer's setup (src/setup.ts, docs/operator.md): GET /internal/setup for accounts' /setup checklist, and
// /start, where the customer adds their store's site (src/web/pages/start.ts). The fictional internet has
// beit-hasabon.example (a WooCommerce store nobody has found yet), tavlinim-ba-shuk.example (an operator's lead in the
// seed) and wood-and-thread.example (a site that is not a store).

const BASE = 'https://toran.test';
/** A server that connects WhatsApp numbers through Zernio (channels/zernio.ts zernioWaReady): its key, its webhook's secret. */
const ZERNIO_ENV = { TORAN_WA_PROVIDER: 'zernio', ZERNIO_API_KEY: 'sk_zernio_test_key', ZERNIO_WEBHOOK_SECRET: 'zernio-webhook-secret-0123456789' };
type S = Awaited<ReturnType<typeof serve>>;

async function setup(s: S, ws: number | string, headers: Record<string, string> = { authorization: `Bearer ${INTERNAL_TOKEN}` }) {
  return fetch(`${s.base}/internal/setup?workspace=${ws}`, { headers });
}
const steps = async (s: S, ws: number) => {
  const r = await setup(s, ws);
  assert.equal(r.status, 200);
  const d = await r.json();
  return { ...d, by: Object.fromEntries(d.steps.map((x: any) => [x.key, x])) };
};
/** One customer of workspace `ws`, signed in, with a CSRF token from /start (or Today). */
async function asCustomer(s: S, ws: number) {
  s.as(s.accounts.session(customer(ws)).cookie);
  return (await s.csrf('/start')) || (await s.csrf('/'));
}
const ajax = { 'x-tn-ajax': '1' };
/**
 * A site added the way a customer adds it now (src/domainProof.ts): POST /start keeps a claim, the customer puts its
 * token in a TXT record, and POST /start/verify finds it and adds the store. Returns the answer that added it (or the
 * first answer, when /start refused before any claim).
 */
async function addSite(s: S, token: string, url: string, headers: Record<string, string> = {}) {
  const first = await s.post('/start', { _csrf: token, url }, headers);
  const claim = await s.app.db.one<any>('SELECT * FROM domain_claims WHERE proven_at IS NULL ORDER BY id DESC LIMIT 1');
  if (!claim || ![200, 303].includes(first.status)) return first;
  const was = proofDeps.resolveTxt;
  proofDeps.resolveTxt = async (host: string) => (host === claim.domain ? [[`toran-verify=${claim.token}`]] : []);
  try {
    await s.app.db.query("UPDATE audit SET at = now() - interval '1 minute' WHERE action = 'verify_domain'");
    return await s.post('/start/verify', { _csrf: token }, headers);
  } finally {
    proofDeps.resolveTxt = was;
  }
}
const addJobs = async (s: S) => (await s.app.db.query<any>("SELECT id, payload, dedupe_key, status FROM jobs WHERE kind = 'add_store' ORDER BY id")).map((j) => ({ ...j, id: Number(j.id) }));

test('a store address as a customer types it: a website, never an IP, localhost or a local name', () => {
  assert.deepEqual(startUrl('store.co.il'), { url: 'https://store.co.il/', domain: 'store.co.il' });
  assert.deepEqual(startUrl(' https://www.Store.co.il/shop/sale?x=1 '), { url: 'https://www.store.co.il/', domain: 'store.co.il' });
  assert.equal(startUrl('http://store.co.il')?.domain, 'store.co.il');
  for (const bad of ['', 'store', 'localhost', 'http://localhost:4710', 'shop.localhost', '127.0.0.1', 'http://10.0.0.8/', 'http://0x7f.1/', '[::1]', 'http://[::1]:80/', 'ftp://store.co.il', 'javascript:alert(1)', 'mailto:a@store.co.il', 'https://user:pw@store.co.il', 'my store.co.il', 'printer.local', 'nas.internal']) {
    assert.equal(startUrl(bad), null, bad);
  }
});

test('GET /internal/setup: from this machine with the token only; a brand-new workspace is the whole list, every step after the store waiting for it', async () => {
  const s = await serve();
  try {
    s.app.env.PUBLIC_BASE_URL = BASE;
    assert.equal((await setup(s, 1, {})).status, 401, 'no token: 401 bad_token, as the contract says');
    assert.equal((await setup(s, 1, { authorization: 'Bearer not-the-token-not-the-token-not-the' })).status, 401, 'a wrong token: 401 bad_token');
    assert.equal((await setup(s, 1, { authorization: `Bearer ${INTERNAL_TOKEN}`, 'x-forwarded-for': '203.0.113.9' })).status, 403, 'never through Caddy');
    for (const bad of ['', 'abc', '0', '-3', '1.5']) assert.equal((await setup(s, bad)).status, 400, bad);

    const d = await steps(s, 41);
    assert.equal(d.product, 'toran');
    assert.equal(d.ready, false);
    // Channels whose code is off here (TORAN_CHANNELS lists none) are not steps at all.
    assert.deepEqual(d.steps.map((x: any) => x.key), ['store', 'whatsapp', 'knowledge', 'test', 'channels', 'live', 'web', 'orders', 'auto']);
    assert.deepEqual(d.by.store, { key: 'store', title: 'מוסיפים את החנות', status: 'todo', detail: d.by.store.detail, href: `${BASE}/start`, required: true });
    assert.match(d.by.store.detail, /כותבים את הכתובת/);
    // The business's WhatsApp is never "after the store" (the owner, 2026-11-09): here this server cannot connect a
    // number, so it says so; every other step waits for the store.
    assert.deepEqual([d.by.whatsapp.status, d.by.whatsapp.href, d.by.whatsapp.title], ['soon', null, 'מחברים את הוואטסאפ של העסק']);
    for (const x of d.steps.slice(2)) assert.deepEqual([x.status, x.detail, x.href], ['todo', 'אחרי שהחנות מוכנה', null], x.key);
    // Any one channel is required, not WhatsApp itself (the owner, 2026-11-08: ready for customers like Teder).
    assert.deepEqual(d.steps.filter((x: any) => x.required).map((x: any) => x.key), ['store', 'channels', 'live']);
    for (const x of d.steps) {
      assert.deepEqual(Object.keys(x).sort(), ['detail', 'href', 'key', 'required', 'status', 'title']);
      assert.ok(['todo', 'working', 'done', 'attention', 'soon'].includes(x.status));
      assert.doesNotMatch(`${x.title} ${x.detail}`, /—|\//, 'no em dash, no slash');
    }
  } finally {
    await s.close();
  }
});

test('/start: a customer adds their store; it is born in their workspace, read, and listed step by step; the operator never sees it as a lead', async () => {
  const s = await serve();
  try {
    s.app.env.PUBLIC_BASE_URL = BASE;
    // The operator has no /start: they add stores from /leads.
    s.login();
    assert.equal((await s.get('/start')).status, 404);

    // The empty state offers the way in.
    const token = await asCustomer(s, 7);
    const empty = await (await s.get('/')).text();
    assert.match(empty, /החנות שלכם עוד בהקמה/);
    assert.match(empty, /href="\/start"[^>]*>.*להוסיף את החנות/);
    const form = await (await s.get('/start')).text();
    assert.match(form, /<form class="panel" method="post" action="\/start">/);
    assert.match(form, /name="url"/);

    // Not a website: refused, nothing queued.
    for (const url of ['localhost', '192.168.1.20', 'http://[::1]/', 'ftp://beit-hasabon.example', 'סתם טקסט']) {
      const r = await s.post('/start', { _csrf: token, url }, ajax);
      assert.equal(r.status, 400, url);
      assert.match((await r.json()).message, /זו לא כתובת של אתר/);
    }
    assert.equal((await addJobs(s)).length, 0);

    // A new site: add_store with the workspace in its payload, and Today says the site is being read.
    const r = await addSite(s, token, 'https://www.beit-hasabon.example/shop');
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/');
    const [job] = await addJobs(s);
    assert.deepEqual(job.payload, { url: 'https://www.beit-hasabon.example/', by: 'owner', workspaceId: 7 });
    assert.equal(job.dedupe_key, 'add:beit-hasabon.example');
    const reading = await (await s.get('/')).text();
    assert.match(reading, new RegExp(`data-wait-job="${job.id}"`));
    assert.match(reading, /קוראים את האתר שלכם/);
    assert.equal((await s.get(`/jobs/${job.id}.json`)).status, 200, 'their own add, before there is a store, is theirs to watch');
    s.as(s.accounts.session(customer(8)).cookie);
    assert.equal((await s.get(`/jobs/${job.id}.json`)).status, 404, "another workspace's is not");
    s.as(s.accounts.session(customer(7)).cookie);
    assert.equal((await s.get('/start')).headers.get('location'), '/', 'while it is read, /start sends to Today');
    let d = await steps(s, 7);
    assert.equal(d.by.store.status, 'working');

    await drain(s.app);
    const store = (await s.app.db.one<any>("SELECT id, workspace_id, source, ingested_at, status, approved_at FROM stores WHERE domain = 'beit-hasabon.example'"))!;
    assert.equal(store.workspace_id, 7, 'born in the workspace');
    assert.equal(store.source, 'signup');
    assert.ok(store.ingested_at);
    d = await steps(s, 7);
    assert.deepEqual([d.by.store.status, d.by.store.href], ['done', `${BASE}/lead/${store.id}/knowledge`]);
    assert.deepEqual([d.by.knowledge.status, d.by.knowledge.href], ['todo', `${BASE}/lead/${store.id}/knowledge`]);
    assert.deepEqual([d.by.whatsapp.status, d.by.whatsapp.href], ['soon', null], 'this server cannot connect a number yet');
    assert.deepEqual([d.by.orders.status, d.by.orders.href], ['todo', `${BASE}/lead/${store.id}/knowledge#orders`], 'WooCommerce orders can be read');
    assert.deepEqual([d.by.auto.status, d.by.auto.href], ['todo', `${BASE}/settings#auto`]);
    assert.equal(d.ready, false);

    // The review (TORAN-READINESS.md P1-8): looking is not it while there is a sample chat to read; "נראה טוב" is.
    // View-as can do neither.
    s.as(s.accounts.session(viewingAs(7)).cookie);
    assert.equal((await s.get(`/lead/${store.id}/knowledge`)).status, 200);
    assert.equal((await steps(s, 7)).by.knowledge.status, 'todo', 'view-as is not the owner looking');
    s.as(s.accounts.session(customer(7)).cookie);
    assert.equal((await s.get(`/lead/${store.id}/knowledge`)).status, 200);
    const hasSample = Boolean((await s.app.db.one<any>("SELECT 1 FROM pitches WHERE store_id = $1 AND jsonb_array_length(sample_chat) >= 2", [store.id])));
    assert.equal((await steps(s, 7)).by.knowledge.status, hasSample ? 'todo' : 'done', 'looking counts only where there is no sample to read');
    await s.post(`/lead/${store.id}/answers-ok`, { _csrf: await s.csrf(`/lead/${store.id}/knowledge`) });
    assert.equal((await steps(s, 7)).by.knowledge.status, 'done');

    // A second store: a workspace has one, so it is sent to the one it has, and nothing is queued.
    const again = await s.post('/start', { _csrf: await s.csrf(`/lead/${store.id}/knowledge`), url: 'tavlinim-ba-shuk.example' }, ajax);
    assert.equal(again.status, 200);
    assert.match((await again.json()).message, /כבר מחוברת/);
    assert.equal((await s.get('/start')).headers.get('location'), '/');
    assert.equal((await addJobs(s)).length, 1);
    assert.equal((await s.app.db.one<any>("SELECT workspace_id FROM stores WHERE domain = 'tavlinim-ba-shuk.example'")).workspace_id, null);

    // Another workspace asking for the same site: refused politely.
    const other = await asCustomer(s, 8);
    const taken = await s.post('/start', { _csrf: other, url: 'https://beit-hasabon.example' }, ajax);
    assert.equal(taken.status, 409);
    assert.match((await taken.json()).message, /כבר מחוברת לחשבון אחר\. כתבו לנו/);
    assert.equal((await s.app.db.one<any>("SELECT workspace_id FROM stores WHERE domain = 'beit-hasabon.example'")).workspace_id, 7);

    // The operator's queues: a lead in the same state as the customer's store is there, the customer's store never.
    const lead = (await s.app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'shaked-jewelry.example'"))!.id;
    for (const id of [store.id, lead]) await s.app.db.query("UPDATE stores SET status = 'page_ready', approved_at = NULL, page_built_at = now(), contact_email = 'hello@example.test' WHERE id = $1", [id]);
    s.login();
    const review = await (await s.get('/review')).text();
    assert.match(review, /shaked-jewelry\.example/);
    assert.doesNotMatch(review, /beit-hasabon\.example/, 'not in the review queue');
    assert.doesNotMatch(await (await s.get('/')).text(), /beit-hasabon\.example/, "not on the operator's Today");
    assert.match(await (await s.get('/leads?all=1')).text(), /beit-hasabon\.example/, 'still in the list of every store');
    for (const id of [store.id, lead]) await s.app.db.query("UPDATE stores SET approved_at = now(), sent_at = NULL WHERE id = $1", [id]);
    const keys = (await queue(s.app)).items.map((i) => i.key);
    assert.ok(keys.includes(`toran:${lead}`));
    assert.ok(!keys.includes(`toran:${store.id}`), 'not someone to write to');
    await s.app.db.query("UPDATE stores SET sent_at = now() - interval '9 days', followup_due_at = now() - interval '1 day', status = 'sent' WHERE id = $1", [store.id]);
    assert.ok(!(await queue(s.app)).items.some((i) => i.key === `toran:${store.id}`), 'nor a reminder');
    assert.doesNotMatch(await (await s.get('/followups')).text(), /beit-hasabon\.example/);
  } finally {
    await s.close();
  }
});

test("/start with an operator's lead: it becomes the workspace's and is read again; a site that cannot be read is attention, and one add a minute", async () => {
  const s = await serve();
  try {
    s.app.env.PUBLIC_BASE_URL = BASE;
    const lead = (await s.app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'tavlinim-ba-shuk.example'"))!.id;
    let token = await asCustomer(s, 11);
    const r = await addSite(s, token, 'http://tavlinim-ba-shuk.example/');
    assert.equal(r.status, 303);
    assert.equal((await s.app.db.one<any>('SELECT workspace_id FROM stores WHERE id = $1', [lead])).workspace_id, 11);
    assert.equal((await addJobs(s)).length, 0, 'no new store');
    assert.deepEqual((await s.app.db.one<any>("SELECT payload FROM jobs WHERE dedupe_key = $1 AND status = 'queued'", [`ingest:${lead}`])).payload, { storeId: lead });
    assert.equal((await steps(s, 11)).by.store.status, 'working');
    await drain(s.app);
    assert.equal((await steps(s, 11)).by.store.status, 'done');

    // A site that is not a store: the add fails, the step says so and links back to /start, Today offers to try again.
    token = await asCustomer(s, 12);
    assert.equal((await addSite(s, token, 'wood-and-thread.example')).status, 303);
    assert.equal((await addJobs(s)).at(-1)!.payload.workspaceId, 12);
    await drain(s.app);
    const d = await steps(s, 12);
    assert.deepEqual([d.by.store.status, d.by.store.href], ['attention', `${BASE}/start`]);
    assert.match(d.by.store.detail, /לא הצלחנו לקרוא את האתר/);
    const today = await (await s.get('/')).text();
    assert.match(today, /לא הצלחנו לקרוא את האתר/);
    assert.match(today, /href="\/start"/);
    assert.match(await (await s.get('/start')).text(), /לא הצלחנו לקרוא את האתר הקודם/);
    // One add a minute per workspace.
    const soon = await addSite(s, token, 'beit-hasabon.example', ajax);
    assert.equal(soon.status, 429);
    assert.match((await soon.json()).message, /בעוד דקה/);
    await s.app.db.query("UPDATE audit SET at = now() - interval '2 minutes' WHERE action = 'start_store'");
    assert.equal((await addSite(s, token, 'beit-hasabon.example', ajax)).status, 200);

    // A store on a platform Toran cannot read: attention, with the platforms it can.
    await s.app.db.query("INSERT INTO stores (domain, url, name, platform, slug, source, workspace_id) VALUES ('other-platform.example', 'https://other-platform.example/', 'אחר', 'unknown', 'other-xxxx', 'signup', 13)");
    const o = await steps(s, 13);
    assert.equal(o.by.store.status, 'attention');
    assert.match(o.by.store.detail, /Shopify/);

    // View-as sees the empty state without the button, and /start sends it home.
    s.as(s.accounts.session(viewingAs(14)).cookie);
    assert.equal((await s.get('/start')).headers.get('location'), '/');
    assert.doesNotMatch(await (await s.get('/')).text(), /href="\/start"/);
  } finally {
    await s.close();
  }
});

test('/internal/setup follows the channels: WhatsApp pending, active and stopped; the channels turned on here; soon while the server cannot connect them', async () => {
  const s = await serve();
  try {
    s.app.env.PUBLIC_BASE_URL = BASE;
    const id = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 21 WHERE id = $1', [id]);
    let d = await steps(s, 21);
    assert.equal(d.by.store.status, 'done');
    assert.equal(d.by.whatsapp.status, 'soon');
    assert.deepEqual([d.by.channels.status, d.by.channels.required, d.by.channels.href], ['todo', true, `${BASE}/settings#channels`]);
    assert.equal(d.by.test.status, 'done', 'the seeded store\'s demo chat counts');
    await s.app.db.query("DELETE FROM events WHERE store_id = $1 AND kind = 'demo_bound'", [id]);
    assert.equal((await steps(s, 21)).by.test.status, 'todo', 'nobody tried the demo yet');

    // Every Meta setting and the sealing key: the store connects its number from its WhatsApp page.
    Object.assign(s.app.env, { META_APP_ID: '1', META_APP_SECRET: 'x', META_WA_CONFIG_ID: '2', META_WEBHOOK_VERIFY_TOKEN: 'v', TORAN_SECRETS_KEY: 'k'.repeat(40) });
    d = await steps(s, 21);
    assert.deepEqual([d.by.whatsapp.status, d.by.whatsapp.href], ['todo', `${BASE}/lead/${id}/whatsapp`]);
    const wa = (await s.app.db.one<{ id: number }>("INSERT INTO channel_accounts (store_id, channel, kind, external_id, status) VALUES ($1, 'whatsapp', 'meta', 'pn-1', 'pending') RETURNING id", [id]))!.id;
    assert.equal((await steps(s, 21)).by.whatsapp.status, 'working');
    assert.equal((await steps(s, 21)).by.channels.status, 'working', 'a number waiting on Meta');
    for (const [status, want] of [['error', 'attention'], ['reconnect', 'attention'], ['active', 'done']]) {
      await s.app.db.query('UPDATE channel_accounts SET status = $2 WHERE id = $1', [wa, status]);
      assert.equal((await steps(s, 21)).by.whatsapp.status, want, status);
    }
    d = await steps(s, 21);
    assert.equal(d.by.channels.status, 'done');
    assert.equal(d.ready, true, 'the store read and WhatsApp on: every required step is done');

    // The order key and the automatic messages.
    await s.app.db.query("INSERT INTO order_access (store_id, platform, secret, status) VALUES ($1, 'shopify', 'sealed', 'error')", [id]);
    assert.equal((await steps(s, 21)).by.orders.status, 'attention');
    await s.app.db.query("UPDATE order_access SET status = 'active' WHERE store_id = $1", [id]);
    assert.equal((await steps(s, 21)).by.orders.status, 'done');
    await s.app.db.query("INSERT INTO auto_settings (store_id, kind, whatsapp) VALUES ($1, 'cart', true)", [id]);
    assert.equal((await steps(s, 21)).by.auto.status, 'done');

    // Email, Messenger and Instagram are steps only where TORAN_CHANNELS lists them and this server can connect them:
    // never "בקרוב" for what is on sale (the audit of 2026-11-12, P2-14; accounts' audit P1-8).
    s.app.env.TORAN_CHANNELS = 'whatsapp,email,messenger';
    d = await steps(s, 21);
    assert.deepEqual(d.steps.map((x: any) => x.key), ['store', 'whatsapp', 'knowledge', 'test', 'channels', 'live', 'web', 'messenger', 'orders', 'auto']);
    assert.equal(d.by.email, undefined, 'no mail provider here: not offered');
    assert.deepEqual([d.by.messenger.status, d.by.messenger.href], ['todo', `${BASE}/lead/${id}/messenger`], 'the Meta app is set up and PUBLIC_BASE_URL is https');
    assert.equal(d.by.messenger.required, false);
    assert.equal(d.ready, true, 'optional steps never hold it back');
    delete s.app.env.META_APP_SECRET;
    d = await steps(s, 21);
    assert.equal(d.by.messenger, undefined, 'not socialReady: not offered');
    assert.equal(d.by.whatsapp.status, 'done', 'a number already connected stays done');

    // The web chat alone is a channel too, once it opened on the store's own site; switched on is not yet installed.
    await s.app.db.query("UPDATE channel_accounts SET status = 'off' WHERE id = $1", [wa]);
    assert.equal((await steps(s, 21)).by.channels.status, 'todo');
    const web = (await s.app.db.one<{ id: number }>("INSERT INTO channel_accounts (store_id, channel, kind, external_id, status, meta) VALUES ($1, 'web', 'web', 'k1setupweb', 'active', '{}'::jsonb) RETURNING id", [id]))!.id;
    d = await steps(s, 21);
    assert.deepEqual([d.by.channels.status, d.by.web.status, d.ready], ['working', 'working', false]);
    await s.app.db.query("UPDATE channel_accounts SET meta = jsonb_build_object('first_seen_at', '2026-11-08T10:00:00Z') WHERE id = $1", [web]);
    d = await steps(s, 21);
    assert.deepEqual([d.by.channels.status, d.by.web.status, d.ready], ['done', 'done', true]);
    // The demo tried from the owner's phone closes the test step.
    await s.app.db.query("INSERT INTO events (store_id, kind, data) VALUES ($1, 'demo_bound', '{}'::jsonb)", [id]);
    assert.equal((await steps(s, 21)).by.test.status, 'done');
  } finally {
    await s.close();
  }
});

test('a site is proven the workspace\'s before it is read or a lead moves: a TXT record or a meta tag; the operator releases a disputed one (PRA-SEC-003)', async () => {
  const s = await serve();
  try {
    s.app.env.PUBLIC_BASE_URL = BASE;
    const lead = (await s.app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'tavlinim-ba-shuk.example'"))!.id;
    const token = await asCustomer(s, 21);
    const first = await s.post('/start', { _csrf: token, url: 'tavlinim-ba-shuk.example' });
    assert.equal(first.headers.get('location'), '/start');
    assert.equal((await s.app.db.one<any>('SELECT workspace_id FROM stores WHERE id = $1', [lead])).workspace_id, null, 'the lead does not move before the proof');
    const claim = await s.app.db.one<any>('SELECT * FROM domain_claims WHERE workspace_id = 21');
    const page = await (await s.get('/start')).text();
    // The TXT value is in the ready message for whoever manages the domain, not on the page (the audit's P1-14).
    assert.ok(messagesOf(page).some((m) => m.includes(`toran-verify=${claim.token}`)), 'the TXT value, in the message');
    assert.ok(!page.includes(`toran-verify=${claim.token}`), 'and nowhere else on the page');
    assert.ok(page.includes(`&lt;meta name=&quot;toran-verify&quot; content=&quot;${claim.token}&quot;&gt;`), 'the meta tag');
    const st = await steps(s, 21);
    assert.deepEqual([st.by.store.status, st.by.store.href], ['attention', `${BASE}/start`]);
    // Waiting for the proof, the business's WhatsApp is already reachable: its guide, which opens the proof first. No
    // store row exists for the site yet (PRA-SEC-003), so nothing is connected or read before the proof.
    Object.assign(s.app.env, ZERNIO_ENV);
    const waiting = await steps(s, 21);
    assert.deepEqual([waiting.by.whatsapp.status, waiting.by.whatsapp.href], ['todo', `${BASE}/whatsapp`]);
    assert.match(waiting.by.whatsapp.detail, /מיד אחרי שמאמתים את האתר/);
    const guide = await (await s.get('/whatsapp')).text();
    assert.match(guide, /החיבור נפתח מיד אחרי שמאמתים את האתר[^]*<a class="btn sm primary" href="\/start">[^]*לאמת את האתר/);
    assert.match(guide, /מחברים את הוואטסאפ של העסק[^]*מה צריך לפני[^]*מאשרים בטלפון/);
    assert.doesNotMatch(guide, /coexistence|WABA|phone number id|תבניות/i);
    const today = await (await s.get('/')).text();
    assert.match(today, /<section class="panel setupbox mt16" id="setup">[^]*<a href="\/whatsapp">[^]*מחברים את הוואטסאפ של העסק/, 'Today lists every step, WhatsApp linked');
    for (const k of Object.keys(ZERNIO_ENV)) delete s.app.env[k];
    // Nothing there yet: refused, and the page says it looked.
    const was = proofDeps.resolveTxt;
    proofDeps.resolveTxt = async () => [['v=spf1 -all']];
    const no = await s.post('/start/verify', { _csrf: token }, ajax);
    assert.equal(no.status, 422);
    assert.match(await (await s.get('/start')).text(), /עוד לא מצאנו את השורה/);
    assert.equal((await s.app.db.one<any>('SELECT workspace_id FROM stores WHERE id = $1', [lead])).workspace_id, null);
    // Asked again at once: one look every few seconds.
    assert.equal((await s.post('/start/verify', { _csrf: token }, ajax)).status, 429);
    // The meta tag on the home page, read through the store fetcher.
    const fetcher = s.app.fetcher;
    s.app.fetcher = async (url, opts) => (url === claim.url ? { url, status: 200, contentType: 'text/html', headers: {}, text: `<html><head><meta content="${claim.token}" name="toran-verify"></head></html>` } : fetcher(url, opts));
    await s.app.db.query("UPDATE audit SET at = now() - interval '1 minute' WHERE action = 'verify_domain'");
    const yes = await s.post('/start/verify', { _csrf: token });
    assert.equal(yes.headers.get('location'), '/');
    assert.equal((await s.app.db.one<any>('SELECT how FROM domain_claims WHERE id = $1', [claim.id])).how, 'meta');
    assert.equal((await s.app.db.one<any>('SELECT workspace_id FROM stores WHERE id = $1', [lead])).workspace_id, 21, 'proven: the lead is theirs');
    // Proven: the button is open at once, while the site is still being read, and /whatsapp is the store's page.
    Object.assign(s.app.env, ZERNIO_ENV);
    const proven = await steps(s, 21);
    assert.equal(proven.steps[1].key, 'whatsapp');
    assert.deepEqual([proven.by.whatsapp.status, proven.by.whatsapp.href], ['todo', `${BASE}/lead/${lead}/whatsapp`]);
    assert.equal((await s.get('/whatsapp')).headers.get('location'), `/lead/${lead}/whatsapp`);
    const wa = await (await s.get(`/lead/${lead}/whatsapp`)).text();
    assert.match(wa, /action="\/lead\/\d+\/whatsapp\/zernio\/start"[^]*לחבר את הוואטסאפ של העסק/);
    for (const k of Object.keys(ZERNIO_ENV)) delete s.app.env[k];
    s.app.fetcher = fetcher;
    proofDeps.resolveTxt = was;

    // A customer cannot release; the operator can, and the claims on the domain go with it.
    assert.equal((await s.post(`/lead/${lead}/release`, { _csrf: await s.csrf(`/lead/${lead}/knowledge`) })).status, 403);
    s.login();
    const op = await s.csrf(`/lead/${lead}`);
    assert.equal((await s.post(`/lead/${lead}/release`, { _csrf: op })).status, 303);
    assert.equal((await s.app.db.one<any>('SELECT workspace_id FROM stores WHERE id = $1', [lead])).workspace_id, null);
    assert.equal((await s.app.db.one<any>("SELECT COUNT(*)::int AS n FROM domain_claims WHERE domain = 'tavlinim-ba-shuk.example'")).n, 0);
  } finally {
    await s.close();
  }
});

// ---- Easier ways to prove a site (the owner, 2026-11-09: "any easier way to do that? many business owners dont know
// how to do that"): the store's own key on Shopify or WooCommerce, a code to an address on the site, or the tag with a
// builder's steps; the TXT record only where the DNS is the owner's.

const SECRETS = { TORAN_SECRETS_KEY: 's'.repeat(40) };
// Shaped like each platform's own, and not like a real one (check:public refuses those).
const SHOPIFY_TOKEN = `shpat_${'TEST'.repeat(6)}`;
const WOO_KEY = { key: `ck_${'test'.repeat(6)}`, secret: `cs_${'test'.repeat(6)}` };
/** The fixture fetcher, with a WordPress REST API index that lists WooCommerce's namespaces on these hosts. */
const withWpJson = (fetcher: Fetcher, hosts: string[]): Fetcher => async (url, opts) => {
  const u = new URL(url);
  if (hosts.includes(u.hostname.replace(/^www\./, '')) && u.pathname === '/wp-json/') return { url, status: 200, contentType: 'application/json', headers: {}, text: JSON.stringify({ name: 'x', namespaces: ['oembed/1.0', 'wc/store/v1', 'wc/v3', 'wp/v2'] }) };
  return fetcher(url, opts);
};
/** Shopify's Admin API: one token works on every shop here, and shop.json says each shop's own addresses. */
const shopifyApi = (): typeof fetch => (async (input: any, init: any = {}) => {
  const u = new URL(String(input));
  const out = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (!u.hostname.endsWith('.myshopify.com') || init.headers?.['x-shopify-access-token'] !== SHOPIFY_TOKEN) return out(401, { errors: 'Invalid API key or access token' });
  if (u.pathname.endsWith('/orders.json')) return out(200, { orders: [] });
  if (u.pathname.endsWith('/shop.json')) return out(200, { shop: { myshopify_domain: u.hostname, domain: u.hostname === 'kli-cheres-example.myshopify.com' ? 'kli-cheres.example' : 'another-shop.example' } });
  return out(404, {});
}) as typeof fetch;
const page = async (s: S) => (await s.get('/start')).text();
/** The ready messages a page offers to send on WhatsApp (wa.me/?text=), as the person who gets one reads it. */
const messagesOf = (html: string) => [...html.matchAll(/href="https:\/\/wa\.me\/\?text=([^"]+)"/g)].map((m) => decodeURIComponent(m[1].replace(/&amp;/g, '&')));
const ago = (s: S) => s.app.db.query("UPDATE audit SET at = now() - interval '1 minute' WHERE action = 'verify_domain'");

test('what a claimed site is built on: Shopify from /meta.json or its address, WooCommerce from the REST index, anything else; TXT hidden on a shared host', async () => {
  const app = await testApp();
  try {
    app.fetcher = withWpJson(app.fetcher, ['tavlinim-ba-shuk.example']);
    const claim = (domain: string, url: string) => claimFor(app, 1, domain, url);
    assert.equal(await platformOf(app, await claim('kli-cheres.example', 'https://kli-cheres.example/')), 'shopify');
    assert.equal(await platformOf(app, await claim('tavlinim-ba-shuk.example', 'https://tavlinim-ba-shuk.example/')), 'woocommerce');
    assert.equal(await platformOf(app, await claim('beit-hasabon.example', 'https://www.beit-hasabon.example/')), 'wordpress', 'WordPress whose REST API is closed: the tag, with WordPress\'s steps');
    assert.equal(await platformOf(app, await claim('wood-and-thread.example', 'https://wood-and-thread.example/')), 'other');
    assert.equal(await platformOf(app, await claim('my-shop.myshopify.com', 'https://my-shop.myshopify.com/')), 'shopify', 'a myshopify.com address, even when it does not answer');
    assert.equal(hostedDns({ domain: 'my-shop.myshopify.com', url: 'https://my-shop.myshopify.com/' }), true);
    assert.equal(hostedDns({ domain: 'noa-example.wixsite.com', url: 'https://noa-example.wixsite.com/shop' }), true);
    assert.equal(hostedDns({ domain: 'store.co.il', url: 'https://www.store.co.il/' }), false);
    assert.deepEqual(['shalom@store.co.il', 'ab@store.co.il', 'a@store.co.il'].map(mask), ['sh***@store.co.il', 'a***@store.co.il', 'a***@store.co.il']);
  } finally {
    await app.db.close();
  }
});

test('a Shopify store proves its site with its own key: the main card, a key for another shop refused, and the key becomes the store\'s order key', async () => {
  const s = await serve();
  try {
    Object.assign(s.app.env, SECRETS);
    s.app.api = shopifyApi();
    const lead = (await s.app.db.one<{ id: number; workspace_id: number | null }>("SELECT id, workspace_id FROM stores WHERE domain = 'kli-cheres.example'"))!;
    assert.equal(lead.workspace_id, null, 'the seed\'s store is an operator\'s lead');
    let token = await asCustomer(s, 31);
    assert.equal((await s.post('/start', { _csrf: token, url: 'kli-cheres.example' })).headers.get('location'), '/start');
    const html = await page(s);
    const main = html.split('verify-more')[0];
    assert.match(main, /<h2>מחברים את החנות ב־Shopify<\/h2>/, 'the key is the main card on Shopify');
    assert.match(main, /action="\/start\/verify\/key"/);
    assert.match(main, /name="client_id"/);
    assert.equal((main.match(/class="btn primary/g) || []).length, 1, 'one main button');
    assert.match(html, /<summary><h2>עוד דרכים<\/h2><\/summary>/);
    assert.match(html, /Online Store/, 'the tag\'s steps for Shopify, under more ways');
    assert.ok(html.includes('https://wa.me/?text='), 'send it to whoever built the site');
    const claim = (await s.app.db.one<any>('SELECT * FROM domain_claims WHERE workspace_id = 31'))!;
    assert.equal(claim.platform, 'shopify', 'read once and kept');
    assert.ok(messagesOf(html).some((m) => m.includes(`toran-verify=${claim.token}`)), 'its own domain: the TXT record is offered too, in its message');

    // A member of the account holds no keys.
    s.as(s.accounts.session({ ...customer(31), role: 'client_member' }).cookie);
    assert.equal((await s.post('/start/verify/key', { _csrf: await s.csrf('/start'), token: SHOPIFY_TOKEN }, ajax)).status, 403);
    token = await asCustomer(s, 31);

    // A key that works, but on another shop: refused, nothing proven.
    const other = await s.post('/start/verify/key', { _csrf: token, token: SHOPIFY_TOKEN, shop: 'another-shop' }, ajax);
    assert.equal(other.status, 422);
    assert.match((await other.json()).message, /של חנות Shopify אחרת/);
    assert.equal((await s.app.db.one<any>('SELECT proven_at FROM domain_claims WHERE id = $1', [claim.id])).proven_at, null);
    assert.equal((await s.post('/start/verify/key', { _csrf: token, token: SHOPIFY_TOKEN }, ajax)).status, 429, 'one look every few seconds');
    await ago(s);
    const bad = await s.post('/start/verify/key', { _csrf: token, token: `shpat_${'WRONG'.repeat(5)}` }, ajax);
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).message, /לא קיבלה את המפתח/);

    // The shop's own key: proven, the lead is theirs, and its orders are connected with the same key.
    await ago(s);
    const yes = await s.post('/start/verify/key', { _csrf: token, token: SHOPIFY_TOKEN });
    assert.equal(yes.headers.get('location'), '/');
    const done = await s.app.db.one<any>('SELECT how, proven_at, order_creds FROM domain_claims WHERE id = $1', [claim.id]);
    assert.deepEqual([done.how, Boolean(done.proven_at), done.order_creds], ['shopify', true, null], 'the key moved to the store');
    await drain(s.app);
    assert.equal((await s.app.db.one<any>('SELECT workspace_id FROM stores WHERE id = $1', [lead.id])).workspace_id, 31);
    const access = await s.app.db.one<any>('SELECT platform, status, secret, meta FROM order_access WHERE store_id = $1', [lead.id]);
    assert.deepEqual([access.platform, access.status, access.meta.shop], ['shopify', 'active', 'kli-cheres-example.myshopify.com']);
    assert.ok(!access.secret.includes(SHOPIFY_TOKEN), 'sealed');
  } finally {
    await s.close();
  }
});

test('a myshopify.com address: the key first and no TXT record, since nobody can add one there', async () => {
  const s = await serve();
  try {
    const token = await asCustomer(s, 32);
    assert.equal((await s.post('/start', { _csrf: token, url: 'https://my-shop.myshopify.com/' })).headers.get('location'), '/start');
    const claim = (await s.app.db.one<any>('SELECT * FROM domain_claims WHERE workspace_id = 32'))!;
    const html = await page(s);
    assert.match(html.split('verify-more')[0], /<h2>מחברים את החנות ב־Shopify<\/h2>/);
    assert.ok(!html.includes(`toran-verify=${claim.token}`) && !messagesOf(html).some((m) => m.includes(`toran-verify=${claim.token}`)), 'no TXT value');
    assert.doesNotMatch(html, /רשומת TXT/);
    assert.ok(html.includes(`content=&quot;${claim.token}&quot;`), 'the tag is still there, under more ways');
  } finally {
    await s.close();
  }
});

test('a WooCommerce store proves its site with a REST key the site itself takes, and the new store has its orders connected after add_store', async () => {
  const s = await serve();
  const was = proofDeps.hostAllowed;
  try {
    Object.assign(s.app.env, SECRETS);
    s.app.fetcher = withWpJson(s.app.fetcher, ['beit-hasabon.example']);
    proofDeps.hostAllowed = async () => true;
    const calls: string[] = [];
    s.app.api = (async (input: any, init: any = {}) => {
      const u = new URL(String(input));
      calls.push(u.host);
      const ok = init.headers?.authorization === `Basic ${Buffer.from(`${WOO_KEY.key}:${WOO_KEY.secret}`).toString('base64')}`;
      if (u.host !== 'www.beit-hasabon.example' || !ok) return new Response('{"code":"woocommerce_rest_cannot_view"}', { status: 401 });
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const token = await asCustomer(s, 33);
    await s.post('/start', { _csrf: token, url: 'https://www.beit-hasabon.example/' });
    assert.match((await page(s)).split('verify-more')[0], /<h2>מחברים את החנות ב־WooCommerce<\/h2>/);
    assert.match(await page(s), /name="key"/);
    const yes = await s.post('/start/verify/key', { _csrf: token, ...WOO_KEY });
    assert.equal(yes.headers.get('location'), '/');
    assert.ok(calls.every((h) => h === 'www.beit-hasabon.example'), 'the key is tried on the claimed site only');
    const claim = await s.app.db.one<any>('SELECT how, order_creds FROM domain_claims WHERE workspace_id = 33');
    assert.equal(claim.how, 'woo');
    assert.ok(claim.order_creds && !claim.order_creds.includes(WOO_KEY.secret), 'kept sealed until the store exists');
    await drain(s.app);
    const store = (await s.app.db.one<any>("SELECT id, platform, workspace_id FROM stores WHERE domain = 'beit-hasabon.example'"))!;
    assert.deepEqual([store.platform, store.workspace_id], ['woocommerce', 33]);
    assert.equal((await s.app.db.one<any>('SELECT platform FROM order_access WHERE store_id = $1', [store.id]))?.platform, 'woocommerce');
    assert.equal((await s.app.db.one<any>('SELECT order_creds FROM domain_claims WHERE workspace_id = 33')).order_creds, null);
  } finally {
    proofDeps.hostAllowed = was;
    await s.close();
  }
});

test('a code to the address on the site: masked on the page, 5 tries, 30 minutes, 3 codes an hour; the right one proves the site', async () => {
  const s = await serve();
  try {
    const mail = simEmail();
    s.app.mail = mail;
    const token = await asCustomer(s, 34);
    await s.post('/start', { _csrf: token, url: 'tavlinim-ba-shuk.example' });
    const html = await page(s);
    const main = html.split('verify-more')[0];
    assert.match(main, /<h2>שולחים קוד למייל שמופיע באתר<\/h2>/, 'not Shopify or WooCommerce here (no REST index): the code is first');
    assert.ok(main.includes('sh***@tavlinim-ba-shuk.example'));
    assert.ok(!html.includes('shalom@tavlinim-ba-shuk.example'), 'the address itself is not on the page');
    const claim = (await s.app.db.one<any>('SELECT * FROM domain_claims WHERE workspace_id = 34'))!;
    const lead = (await s.app.db.one<any>("SELECT id FROM stores WHERE domain = 'tavlinim-ba-shuk.example'"))!.id;
    const send = () => s.post('/start/verify/email', { _csrf: token, to: '0' }, ajax);
    const codeOf = () => /: (\d{6})$/.exec(String(mail.outbox!.at(-1)!.subject))![1];
    const typed = (code: string) => s.post('/start/verify/code', { _csrf: token, code }, ajax);
    const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

    // The first code: five wrong tries, and the sixth is refused even when it is right.
    const sent = await send();
    assert.equal(sent.status, 200);
    assert.match((await sent.json()).message, /שלחנו קוד ל־sh\*\*\*@tavlinim-ba-shuk\.example/);
    assert.equal(mail.outbox!.at(-1)!.to, 'shalom@tavlinim-ba-shuk.example');
    assert.match(String(mail.outbox!.at(-1)!.text), /tavlinim-ba-shuk\.example/);
    const first = codeOf();
    assert.match(await page(s), /<h2>מקלידים את הקוד מהמייל<\/h2>/, 'a code sent: typing it is the main card');
    const db = await s.app.db.one<any>('SELECT code_hash, code_to FROM domain_claims WHERE id = $1', [claim.id]);
    assert.ok(db.code_hash && !db.code_hash.includes(first), 'only its hash');
    for (let i = 1; i <= 5; i++) {
      const r = await typed(wrong(first));
      assert.equal(r.status, 422, `try ${i}`);
      assert.match((await r.json()).message, /הקוד לא נכון/);
    }
    assert.equal((await typed(first)).status, 429, 'the sixth try is refused');

    // The second code expires.
    await send();
    const second = codeOf();
    await s.app.db.query("UPDATE domain_claims SET code_sent_at = now() - interval '31 minutes' WHERE id = $1", [claim.id]);
    const late = await typed(second);
    assert.equal(late.status, 422);
    assert.match((await late.json()).message, /לא בתוקף/);

    // A third code, and no fourth in the same hour.
    await send();
    const third = codeOf();
    const fourth = await send();
    assert.equal(fourth.status, 429);
    assert.equal(mail.outbox!.length, 3);
    assert.equal((await s.app.db.one<any>('SELECT workspace_id FROM stores WHERE id = $1', [lead])).workspace_id, null, 'nothing moves before the proof');

    const yes = await s.post('/start/verify/code', { _csrf: token, code: ` ${third.slice(0, 3)} ${third.slice(3)} ` });
    assert.equal(yes.headers.get('location'), '/');
    assert.equal((await s.app.db.one<any>('SELECT how FROM domain_claims WHERE id = $1', [claim.id])).how, 'email');
    assert.equal((await s.app.db.one<any>('SELECT workspace_id FROM stores WHERE id = $1', [lead])).workspace_id, 34);
  } finally {
    await s.close();
  }
});

test('a site with no address and no store: the tag is the main card, its ready message to whoever built the site first, every builder\'s steps folded below', async () => {
  const s = await serve();
  try {
    s.app.mail = simEmail();
    const token = await asCustomer(s, 35);
    await s.post('/start', { _csrf: token, url: 'wood-and-thread.example' });
    const html = await page(s);
    const main = html.split('verify-more')[0];
    assert.match(main, /<h2>מוסיפים שורה קטנה לאתר<\/h2>/);
    assert.match(main, /data-copy="#verify-tag"/);
    // Nobody can tell what this site is built on: whoever built it adds the line, so their ready message leads, as the
    // main button, and every builder's steps fold below it, none open, code last (the audit's P2-7).
    const builder = main.indexOf('מי שבנה לכם את האתר יכול להוסיף אותה');
    assert.ok(builder > 0 && builder < main.indexOf('data-copy="#verify-tag"'), 'the builder first');
    assert.match(main, /<a class="btn primary" href="https:\/\/wa\.me\/\?text=[^"]+"[^>]*>[^]*?לשלוח בוואטסאפ<\/a>/);
    assert.equal((main.match(/class="btn primary/g) || []).length, 1, 'one main button');
    assert.doesNotMatch(main, /<details class="mt8" open>/, "no builder's steps open");
    assert.ok(main.indexOf('<b>אתר שנבנה בקוד</b>') > main.indexOf('<b>Webflow</b>'), 'code last');
    for (const b of ['WordPress', 'Wix', 'Shopify', 'Webflow']) assert.match(main, new RegExp(`<summary><b>${b}</b>`), b);
    assert.match(main, /action="\/start\/verify"/);
    assert.doesNotMatch(html, /שולחים קוד למייל/, 'no address on the site: no code');
    assert.doesNotMatch(html, /verify\/key/, 'no store: no key');
  } finally {
    await s.close();
  }
});
