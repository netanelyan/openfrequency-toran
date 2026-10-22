import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../src/web/server.ts';
import { DEMO_PHONE, seedDemo } from '../src/demoSeed.ts';
import { fakeAccounts, operator, testApp } from './helpers.ts';

/** The tests' own offer: a made-up price, only ever on a page inside a test. */
export const TEST_OFFER = { monthly: 199, vat: 'excluded' as const, setup: 0, city: 'אשדוד' };

// The website on a free port, with the fictional store seeded and a stand-in for openfrequency-accounts. `login()`
// signs the requests in as the operator; `as(cookie)` makes them carry another session's cookie.

export async function serve() {
  const app = await testApp();
  app.env.DEMO_WA_NUMBER = '972500000999';
  app.env.TORAN_OWNER_WHATSAPP = DEMO_PHONE; // the demo's own chat is the owner testing: it moves no lead
  const accounts = await fakeAccounts();
  Object.assign(app.env, accounts.env);
  const seeded = await seedDemo(app, { conversation: true });
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  server.on('request', createHandler(app, { port }));
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const get = (p: string, headers: Record<string, string> = {}) => fetch(base + p, { headers: { cookie, ...headers }, redirect: 'manual' });
  const post = (p: string, form: Record<string, string>, headers: Record<string, string> = {}) => fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: base, ...headers }, body: new URLSearchParams(form), redirect: 'manual' });
  const as = (c: string) => {
    cookie = c;
  };
  const login = () => {
    const s = accounts.session(operator());
    as(s.cookie);
    return s;
  };
  const csrf = async (p = '/') => /name="_csrf" value="([^"]+)"/.exec(await (await get(p)).text())?.[1] || '';
  return {
    app, seeded, server, base, accounts, get, post, login, as, csrf,
    close: async () => {
      server.close();
      await accounts.close();
      await app.db.close();
    },
  };
}
