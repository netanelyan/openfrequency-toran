import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { customer, INTERNAL_TOKEN } from './helpers.ts';
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

test("on Toran's own name the operator is sent to /admin; a customer stays; without the header nothing changes", async () => {
  const s = await serve();
  const port = Number(new URL(s.base).port);
  Object.assign(s.app.env, { PUBLIC_HOST: 'toran.test' });
  try {
    // The handler read PUBLIC_HOST when it was made: a fresh one for this name.
    const { createHandler } = await import('../src/web/server.ts');
    const server = http.createServer(createHandler(s.app, { port }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const p2 = (server.address() as any).port;
    try {
      const op = s.login();
      const toOp = await raw(p2, '/leads?x=1', { host: 'toran.test', cookie: op.cookie.replace('of_session', '__Secure-of_session'), 'x-forwarded-proto': 'https' });
      assert.equal(toOp.status, 303);
      assert.equal(toOp.headers.location, 'https://accounts.test/admin/toran/leads?x=1');
      const cust = s.accounts.session(customer(5));
      const toCust = await raw(p2, '/', { host: 'toran.test', cookie: cust.cookie.replace('of_session', '__Secure-of_session'), 'x-forwarded-proto': 'https' });
      assert.equal(toCust.status, 200, 'the product, for a customer');
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
