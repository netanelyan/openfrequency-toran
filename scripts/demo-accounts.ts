// A stand-in for openfrequency-accounts, for `npm run demo` and `npm run screenshots` only: the demo has no accounts
// service to sign in with. Never imported by src/, so the real site can never answer with it. Teder's, for Toran.
//
// One server on 127.0.0.1 (a free port):
//   GET /login?next=        sets the demo session cookie (of_session, as accounts does on a laptop) and goes back to next
//   GET /logout             clears it
//   GET /internal/session   what accounts would say: the operator (the superadmin outside view-as), Toran on
// Open the demo at http://localhost:<port>, not 127.0.0.1: the cookie belongs to the host name, and accounts and
// Toran share it only under the same one.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export async function startDemoAccounts() {
  const token = randomBytes(24).toString('hex');
  const sid = randomBytes(32).toString('base64url');
  const answer = {
    user: { id: 1, email: 'demo@example.com', name: 'Demo', superadmin: true },
    workspace: null,
    role: 'superadmin',
    products: ['teder', 'toran'],
    readOnly: false,
    viewAs: null,
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/internal/session') {
      if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'bad_token' });
      return req.headers['x-of-session'] === sid ? json(200, answer) : json(401, { error: 'no_session' });
    }
    const next = url.searchParams.get('next') || '';
    const back = /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(next) ? next : 'about:blank';
    if (url.pathname === '/login') {
      res.writeHead(303, { location: back, 'set-cookie': `of_session=${sid}; Path=/; HttpOnly; SameSite=Lax` });
      return res.end();
    }
    if (url.pathname === '/logout') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'set-cookie': 'of_session=; Path=/; Max-Age=0' });
      return res.end('signed out of the demo');
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    env: { OF_INTERNAL_TOKEN: token, OF_ACCOUNTS_INTERNAL: `http://127.0.0.1:${port}`, OF_ACCOUNTS_URL: `http://localhost:${port}` },
  };
}
