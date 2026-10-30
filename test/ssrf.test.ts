import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FetchError, hostAllowed, isBlockedAddress, liveFetcher } from '../src/core/http.ts';

// The address rule (src/core/http.ts, PRA-SEC-001 and PRA-QA-005): a page that redirects to our own machine, a private
// network or the cloud metadata address is refused with a typed 'blocked', and the target never sees a request.

async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { server, port: (server.address() as AddressInfo).port };
}

// Every hostile address: loopback, RFC 1918, link-local and metadata, CGNAT, IPv6 loopback, unique-local and link-local,
// an IPv4 address mapped into IPv6, the unspecified addresses, and the decimal and hex spellings of 127.0.0.1.
const HOSTILE = (victimPort: number) => [
  `http://127.0.0.1:${victimPort}/`,
  'http://169.254.169.254/latest/meta-data/',
  'http://10.0.0.1/',
  'http://172.16.5.4/',
  'http://192.168.1.1/',
  'http://100.64.0.1/',
  'http://0.0.0.0/',
  'http://[::1]/',
  'http://[::]/',
  'http://[fd00::1]/',
  'http://[fe80::1]/',
  `http://[::ffff:127.0.0.1]:${victimPort}/`,
  'http://[64:ff9b::7f00:1]/',
  `http://2130706433:${victimPort}/`,
  `http://0x7f.0.0.1:${victimPort}/`,
  `http://evil.example:${victimPort}/`,
];

test('a redirect to a private, loopback or reserved address is refused, and the target gets no request', async () => {
  let reached = 0;
  const victim = await serve((_req, res) => {
    reached++;
    res.end('secret');
  });
  let to = '';
  const attacker = await serve((req, res) => {
    if (req.url === '/robots.txt') return res.end('User-agent: *\nAllow: /');
    if (req.url === '/same') return res.end('<html>ok</html>');
    if (req.url === '/hop') {
      res.writeHead(302, { location: '/same' });
      return res.end();
    }
    res.writeHead(302, { location: to });
    res.end();
  });
  // A name the resolver maps to 127.0.0.1: refused at the connection, whatever the check saw before.
  const resolve = (host: string, _o: any, cb: any) => (host === 'evil.example' ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []));
  const get = liveFetcher({ gapMs: 0, resolve, trusted: new Set([`127.0.0.1:${attacker.port}`]) });
  try {
    const ok = await get(`http://127.0.0.1:${attacker.port}/hop`);
    assert.equal(ok.text, '<html>ok</html>', 'a redirect on the same site is followed');
    assert.equal(ok.url, `http://127.0.0.1:${attacker.port}/same`);
    for (const target of HOSTILE(victim.port)) {
      to = target;
      await assert.rejects(get(`http://127.0.0.1:${attacker.port}/shipping`), (e: any) => e instanceof FetchError && e.code === 'blocked', target);
      // Asked for directly, as typed, the same.
      await assert.rejects(get(target), (e: any) => e instanceof FetchError && e.code === 'blocked', `direct ${target}`);
    }
    to = 'file:///etc/passwd';
    await assert.rejects(get(`http://127.0.0.1:${attacker.port}/x`), (e: any) => e instanceof FetchError && e.code === 'blocked');
    assert.equal(reached, 0, 'the target never saw a request');
  } finally {
    victim.server.close();
    attacker.server.close();
  }
});

test('the address rule by address: public ones pass, every reserved range and mapped form is blocked', async () => {
  for (const a of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) assert.equal(isBlockedAddress(a), false, a);
  for (const a of ['127.0.0.1', '127.8.9.10', '10.1.2.3', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.127.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fdff::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', 'ff02::1', 'not an address']) assert.equal(isBlockedAddress(a), true, a);
  // The headless browser asks the same question of each request its page makes.
  const resolve = (host: string, _o: any, cb: any) => cb(null, [{ address: host === 'inside.example' ? '10.0.0.5' : '93.184.216.34', family: 4 }]);
  assert.equal(await hostAllowed('https://shop.example/a', resolve), true);
  assert.equal(await hostAllowed('https://inside.example/a', resolve), false);
  assert.equal(await hostAllowed('http://169.254.169.254/', resolve), false);
  assert.equal(await hostAllowed('data:text/html,hi', resolve), true);
});
