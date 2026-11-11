import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { customer, INTERNAL_TOKEN, operatorAt } from './helpers.ts';
import { serve } from './serve.ts';
import { underBase } from '../src/web/server.ts';
import { storesOf } from '../src/web/workspace.ts';

// The operator's Toran dashboard lives on accounts' /admin (docs/operator.md): accounts proxies /admin/toran/... here
// with X-OF-Admin-Prefix, and Toran answers under that prefix, for the operator only. On Toran's own name the operator
// is sent there; the product is what's left.

const ADMIN = { 'x-of-admin-prefix': '/admin/toran' };

/** A request as node:http sends it, so the Host header can be any name (fetch keeps Host to itself). */
function raw(port: number, path: string, headers: Record<string, string>, form?: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = form ? new URLSearchParams(form).toString() : null;
    const req = http.request({ host: '127.0.0.1', port, path, method: sent === null ? 'GET' : 'POST', headers: sent === null ? headers : { ...headers, 'content-type': 'application/x-www-form-urlencoded' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end(sent ?? undefined);
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

test("on Toran's own name the operator sees the product: every customer's store on a customer's screens, or their own workspace as its owner, and operator addresses sent to /admin", async () => {
  // The owner, 2026-11-10: "Make teder and toran of natikyan153@gmail.com regular, just like a customer's. Everything
  // else, leads etc should be in other places. The admin dashboard is for that" (accounts' docs/admin-split.md), and
  // 2026-11-11: "i wanted to have the same data but just see it like a customer".
  const s = await serve();
  const port = Number(new URL(s.base).port);
  Object.assign(s.app.env, { PUBLIC_HOST: 'toran.test' });
  try {
    // The handler read PUBLIC_HOST when it was made: a fresh one for this name.
    const { createHandler } = await import('../src/web/server.ts');
    const server = http.createServer(createHandler(s.app, { port }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const p2 = (server.address() as any).port;
    const at = (path: string, session: { cookie: string }, form?: Record<string, string>) => raw(p2, path, { host: 'toran.test', cookie: session.cookie.replace('of_session', '__Secure-of_session'), 'x-forwarded-proto': 'https' }, form);
    const nav = (html: string) => /<nav class="nav" aria-label="ראשי">([^]*?)<\/nav>/.exec(html)![1];
    try {
      // No workspace: what the operator had, a customer's store among them, on the customer's screens.
      await s.app.db.query('UPDATE stores SET workspace_id = 5 WHERE id = $1', [s.seeded.storeId]);
      const op = s.login();
      const cust = await at('/', s.accounts.session(customer(5)));
      const home = await at('/', op);
      assert.equal(home.status, 200);
      assert.doesNotMatch(home.body, /data-refusal/);
      assert.equal(nav(home.body), nav(cust.body), "the same nav as a customer's");
      assert.doesNotMatch(home.body, /href="\/(leads|review|followups)"|טוקנים|מוכנים לשליחה/);
      const settings = await at('/settings', op);
      assert.equal(settings.status, 200);
      assert.equal(nav(settings.body), nav((await at('/settings', s.accounts.session(customer(5)))).body));
      assert.doesNotMatch(settings.body, /TORAN_MONTHLY_CAP_USD|ANTHROPIC_API_KEY|חיפוש לידים/);
      const knows = await at(`/lead/${s.seeded.storeId}/knowledge`, op);
      assert.equal(knows.status, 200, "a customer's store opens, as its owner's page");
      // Its Instagram connects from its page, as its owner would (the owner, 2026-11-11, on a store's Instagram page with
      // no button: "where exactly is the button for connection?").
      Object.assign(s.app.env, { TORAN_DM_PROVIDER: 'zernio', ZERNIO_API_KEY: 'sk_zernio_test_key', ZERNIO_WEBHOOK_SECRET: 'zernio-webhook-secret-0123456789', PUBLIC_BASE_URL: 'https://toran.test', TORAN_CHANNELS: 'whatsapp,email,messenger,instagram' });
      s.app.graph = (async (input: any, init: any = {}) => {
        const u = new URL(String(input));
        const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
        if (u.pathname === '/api/v1/profiles') return init.method === 'POST' ? json({ profile: { _id: 'a'.repeat(24) } }, 201) : json({ profiles: [] });
        if (u.pathname === '/api/v1/connect/instagram') return json({ authUrl: 'https://zernio.com/connect/welcome/instagram?t=abc' });
        return json({ error: 'no route' }, 404);
      }) as typeof fetch;
      const ig = await at(`/lead/${s.seeded.storeId}/instagram`, op);
      assert.equal(ig.status, 200);
      assert.match(ig.body, new RegExp(`action="/lead/${s.seeded.storeId}/instagram/connect"`), 'the button');
      assert.doesNotMatch(ig.body, /מחברת החנות מהדשבורד שלה/);
      const csrf = /name="_csrf" value="([^"]+)"/.exec(ig.body)![1];
      const go = await at(`/lead/${s.seeded.storeId}/instagram/connect`, op, { _csrf: csrf });
      assert.equal(go.status, 303);
      assert.equal(go.headers.location, 'https://zernio.com/connect/welcome/instagram?t=abc', "to Zernio's connect, and back to Toran's own name");
      // The operator's pages are on /admin.
      const toOp = await at('/leads?x=1', op);
      assert.equal(toOp.status, 303);
      assert.equal(toOp.headers.location, 'https://accounts.test/admin/toran/leads?x=1');
      for (const path of ['/review', '/followups', '/queue', `/lead/${s.seeded.storeId}`]) {
        const r = await at(path, op);
        assert.equal(r.status, 303, path);
        assert.equal(r.headers.location, `https://accounts.test/admin/toran${path}`, path);
      }
      await s.app.db.query('UPDATE stores SET workspace_id = NULL WHERE id = $1', [s.seeded.storeId]);
      // A store in no workspace (a lead, our company store) is not on a customer's screens: its pages go to /admin, and
      // no list or count has it (the owner's inbox, 2026-11-11, listed our support chat beside a badge of one).
      const lead = await at(`/lead/${s.seeded.storeId}/knowledge`, op);
      assert.equal(lead.status, 303);
      assert.equal(lead.headers.location, `https://accounts.test/admin/toran/lead/${s.seeded.storeId}/knowledge`);
      assert.equal(storesOf({ workspaceId: null, operator: true, readOnly: false, customers: true }, 's'), 's.workspace_id IS NOT NULL');
      assert.equal(storesOf({ workspaceId: null, operator: true, readOnly: false }), 'TRUE', "the operator's own pages still have every store");

      // In their own workspace: the customer's Today and nav, nothing of the operator's.
      const mine = s.accounts.session(operatorAt(5));
      const today = await at('/', mine);
      assert.equal(today.status, 200, 'the product, as its owner sees it');
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
