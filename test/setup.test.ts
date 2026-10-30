import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drain } from '../src/jobs/worker.ts';
import { queue } from '../src/ops/queue.ts';
import { startUrl } from '../src/web/pages/start.ts';
import { proofDeps } from '../src/domainProof.ts';
import { customer, INTERNAL_TOKEN, viewingAs } from './helpers.ts';
import { serve } from './serve.ts';

// A new customer's setup (src/setup.ts, docs/operator.md): GET /internal/setup for accounts' /setup checklist, and
// /start, where the customer adds their store's site (src/web/pages/start.ts). The fictional internet has
// beit-hasabon.example (a WooCommerce store nobody has found yet), tavlinim-ba-shuk.example (an operator's lead in the
// seed) and wood-and-thread.example (a site that is not a store).

const BASE = 'https://toran.test';
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
    assert.deepEqual(d.steps.map((x: any) => x.key), ['store', 'knowledge', 'whatsapp', 'orders', 'auto']);
    assert.deepEqual(d.by.store, { key: 'store', title: 'מוסיפים את החנות', status: 'todo', detail: d.by.store.detail, href: `${BASE}/start`, required: true });
    assert.match(d.by.store.detail, /כותבים את הכתובת/);
    for (const x of d.steps.slice(1)) assert.deepEqual([x.status, x.detail, x.href], ['todo', 'אחרי שהחנות מוכנה', null], x.key);
    assert.deepEqual(d.steps.filter((x: any) => x.required).map((x: any) => x.key), ['store', 'whatsapp']);
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

    // The owner looks at what Toran knows: done. View-as looking would not have counted.
    s.as(s.accounts.session(viewingAs(7)).cookie);
    assert.equal((await s.get(`/lead/${store.id}/knowledge`)).status, 200);
    assert.equal((await steps(s, 7)).by.knowledge.status, 'todo', 'view-as is not the owner looking');
    s.as(s.accounts.session(customer(7)).cookie);
    assert.equal((await s.get(`/lead/${store.id}/knowledge`)).status, 200);
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

    // Every Meta setting and the sealing key: the store connects its number from its WhatsApp page.
    Object.assign(s.app.env, { META_APP_ID: '1', META_APP_SECRET: 'x', META_WA_CONFIG_ID: '2', META_WEBHOOK_VERIFY_TOKEN: 'v', TORAN_SECRETS_KEY: 'k'.repeat(40) });
    d = await steps(s, 21);
    assert.deepEqual([d.by.whatsapp.status, d.by.whatsapp.href], ['todo', `${BASE}/lead/${id}/whatsapp`]);
    const wa = (await s.app.db.one<{ id: number }>("INSERT INTO channel_accounts (store_id, channel, kind, external_id, status) VALUES ($1, 'whatsapp', 'meta', 'pn-1', 'pending') RETURNING id", [id]))!.id;
    assert.equal((await steps(s, 21)).by.whatsapp.status, 'working');
    for (const [status, want] of [['error', 'attention'], ['reconnect', 'attention'], ['active', 'done']]) {
      await s.app.db.query('UPDATE channel_accounts SET status = $2 WHERE id = $1', [wa, status]);
      assert.equal((await steps(s, 21)).by.whatsapp.status, want, status);
    }
    d = await steps(s, 21);
    assert.equal(d.ready, true, 'the store read and WhatsApp on: every required step is done');

    // The order key and the automatic messages.
    await s.app.db.query("INSERT INTO order_access (store_id, platform, secret, status) VALUES ($1, 'shopify', 'sealed', 'error')", [id]);
    assert.equal((await steps(s, 21)).by.orders.status, 'attention');
    await s.app.db.query("UPDATE order_access SET status = 'active' WHERE store_id = $1", [id]);
    assert.equal((await steps(s, 21)).by.orders.status, 'done');
    await s.app.db.query("INSERT INTO auto_settings (store_id, kind, whatsapp) VALUES ($1, 'cart', true)", [id]);
    assert.equal((await steps(s, 21)).by.auto.status, 'done');

    // Email, Messenger and Instagram are steps only where TORAN_CHANNELS lists them, and soon until they can connect.
    s.app.env.TORAN_CHANNELS = 'whatsapp,email,messenger';
    d = await steps(s, 21);
    assert.deepEqual(d.steps.map((x: any) => x.key), ['store', 'knowledge', 'whatsapp', 'email', 'messenger', 'orders', 'auto']);
    assert.deepEqual([d.by.email.status, d.by.email.href], ['soon', null], 'no mail provider here');
    assert.deepEqual([d.by.messenger.status, d.by.messenger.href], ['todo', `${BASE}/lead/${id}/messenger`], 'the Meta app is set up and PUBLIC_BASE_URL is https');
    assert.equal(d.by.email.required || d.by.messenger.required, false);
    assert.equal(d.ready, true, 'optional steps never hold it back');
    delete s.app.env.META_APP_SECRET;
    d = await steps(s, 21);
    assert.deepEqual([d.by.messenger.status, d.by.messenger.href], ['soon', null], 'not socialReady');
    assert.equal(d.by.whatsapp.status, 'done', 'a number already connected stays done');
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
    assert.ok(page.includes(`toran-verify=${claim.token}`), 'the TXT value');
    assert.ok(page.includes(`&lt;meta name=&quot;toran-verify&quot; content=&quot;${claim.token}&quot;&gt;`), 'the meta tag');
    const st = await steps(s, 21);
    assert.deepEqual([st.by.store.status, st.by.store.href], ['attention', `${BASE}/start`]);
    // Nothing there yet: refused, and the page says it looked.
    const was = proofDeps.resolveTxt;
    proofDeps.resolveTxt = async () => [['v=spf1 -all']];
    const no = await s.post('/start/verify', { _csrf: token }, ajax);
    assert.equal(no.status, 422);
    assert.match(await (await s.get('/start')).text(), /עוד לא מצאנו את הקוד/);
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
