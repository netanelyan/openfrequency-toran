import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { customer, INTERNAL_TOKEN, operatorAt } from './helpers.ts';
import { serve } from './serve.ts';
import { underBase } from '../src/web/server.ts';

// The operator's Toran dashboard lives on accounts' /admin (docs/operator.md): accounts proxies /admin/toran/... here
// with X-OF-Admin-Prefix, and Toran answers under that prefix, for the operator only. On Toran's own name the operator
// is sent there; the product is what's left.

const ADMIN = { 'x-of-admin-prefix': '/admin/toran' };

/** A request as node:http sends it, so the Host header can be any name (fetch keeps Host to itself). */
function raw(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a body under the prefix: links, forms, sources, redirects in JSON and CSS fonts move under it; outside links and other text stay', () => {
  const html = '<html lang="he"><a href="/leads">x</a><form action="/lead/1/sent"></form><img src="/static/a.svg"><a href="https://wa.me/1">w</a><a href="//cdn.example/x">c</a><p>/leads in text</p>';
  const out = underBase(html, 'text/html', '/admin/toran');
  assert.match(out, /<html data-base="\/admin\/toran" lang="he">/);
  assert.match(out, /href="\/admin\/toran\/leads"/);
  assert.match(out, /action="\/admin\/toran\/lead\/1\/sent"/);
  assert.match(out, /src="\/admin\/toran\/static\/a\.svg"/);
  assert.match(out, /href="https:\/\/wa\.me\/1"/);
  assert.match(out, /href="\/\/cdn\.example\/x"/);
  assert.match(out, /<p>\/leads in text<\/p>/);
  assert.equal(underBase('{"ok":true,"redirect":"/lead/2"}', 'application/json', '/admin/toran'), '{"ok":true,"redirect":"/admin/toran/lead/2"}');
  assert.equal(underBase("src: url('/static/fonts/h.woff2')", 'text/css', '/admin/toran'), "src: url('/admin/toran/static/fonts/h.woff2')");
});

test("the operator's dashboard under /admin/toran: pages, links and redirects under the prefix, the operator only, never the internal routes", async () => {
  const s = await serve();
  try {
    s.login();
    const leads = await s.get('/admin/toran/leads', ADMIN);
    assert.equal(leads.status, 200);
    const html = await leads.text();
    assert.match(html, /href="\/admin\/toran\/lead\/\d+"/, 'its links stay under the prefix');
    assert.match(html, /href="\/admin\/toran\/static\/style\.css/);
    assert.doesNotMatch(html, /href="\/leads"/);
    assert.match(await (await s.get('/admin/toran/static/pitch.css', ADMIN)).text(), /url\('\/admin\/toran\/static\/fonts\/heebo-hebrew\.woff2'\)/);

    // An action posted from accounts' origin comes back to its page under the prefix.
    const token = /name="_csrf" value="([^"]+)"/.exec(html)![1];
    const r = await s.post('/admin/toran/settings/dev', { _csrf: token, on: '1' }, { ...ADMIN, origin: 'https://accounts.test' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/admin/toran/settings#dev');

    // Never the machine-to-machine routes under it, token or not.
    assert.equal((await s.get('/admin/toran/internal/ops', { ...ADMIN, authorization: `Bearer ${INTERNAL_TOKEN}` })).status, 404);

    // A customer's session finds nothing there.
    s.as(s.accounts.session(customer(5)).cookie);
    assert.equal((await s.get('/admin/toran/leads', ADMIN)).status, 404);
  } finally {
    await s.close();
  }
});

test("on Toran's own name the operator sees the product: their own workspace as its owner, operator addresses sent to /admin, and without a workspace a page pointing there", async () => {
  // The owner, 2026-11-10: "Make teder and toran of natikyan153@gmail.com regular, just like a customer's. Everything
  // else, leads etc should be in other places. The admin dashboard is for that" (accounts' docs/admin-split.md).
  const s = await serve();
  const port = Number(new URL(s.base).port);
  Object.assign(s.app.env, { PUBLIC_HOST: 'toran.test' });
  try {
    // The handler read PUBLIC_HOST when it was made: a fresh one for this name.
    const { createHandler } = await import('../src/web/server.ts');
    const server = http.createServer(createHandler(s.app, { port }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const p2 = (server.address() as any).port;
    const at = (path: string, session: { cookie: string }) => raw(p2, path, { host: 'toran.test', cookie: session.cookie.replace('of_session', '__Secure-of_session'), 'x-forwarded-proto': 'https' });
    try {
      // No workspace of their own: Today is a short page to /admin, any other address the same page under /admin/toran.
      const op = s.login();
      const toOp = await at('/leads?x=1', op);
      assert.equal(toOp.status, 303);
      assert.equal(toOp.headers.location, 'https://accounts.test/admin/toran/leads?x=1');
      const home = await at('/', op);
      assert.equal(home.status, 200);
      assert.match(home.body, /data-refusal="operator"/);
      assert.match(home.body, /<a class="btn primary" href="https:\/\/accounts\.test\/admin\/toran\/">ללוח הניהול<\/a>/);

      // In their own workspace: the customer's Today and nav, nothing of the operator's.
      const mine = s.accounts.session(operatorAt(5));
      const today = await at('/', mine);
      assert.equal(today.status, 200, 'the product, as its owner sees it');
      const cust = await at('/', s.accounts.session(customer(5)));
      const nav = (html: string) => /<nav class="nav" aria-label="ראשי">([^]*?)<\/nav>/.exec(html)![1];
      assert.equal(nav(today.body), nav(cust.body), 'the same nav as the workspace\'s customer');
      assert.doesNotMatch(today.body, /href="\/(leads|review|followups)"|טוקנים/);
      // An operator page, or a store outside the workspace (a lead, our support store's chat in an alert), goes to /admin.
      for (const path of ['/leads', '/review', '/followups', '/queue', `/lead/${s.seeded.storeId}`, `/lead/${s.seeded.storeId}/knowledge`]) {
        const r = await at(path, mine);
        assert.equal(r.status, 303, path);
        assert.equal(r.headers.location, `https://accounts.test/admin/toran${path}`, path);
      }
      // A customer gets what they got: their own Today for an operator page, "not found" for another's store.
      const custLeads = await at('/leads', s.accounts.session(customer(5)));
      assert.deepEqual([custLeads.status, custLeads.headers.location], [303, '/']);
      assert.equal((await at(`/lead/${s.seeded.storeId}/knowledge`, s.accounts.session(customer(5)))).status, 404);
    } finally {
      server.close();
    }
    // On a laptop (127.0.0.1) the operator still sees everything, for development.
    s.login();
    assert.equal((await s.get('/leads')).status, 200);
  } finally {
    await s.close();
  }
});
