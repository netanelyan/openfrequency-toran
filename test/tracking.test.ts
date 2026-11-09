import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTrackingPage, link17, linkFor, pageFor, track17, TrackingPageError, trackNumber } from '../src/tracking.ts';
import { wooShipments } from '../src/orders.ts';
import { testApp } from './helpers.ts';

// Where a package is (src/tracking.ts): the website's tracking page, the link, and 17track's Tracking API, which is a
// stand-in here (no network). Its shapes are the docs' (api.17track.net/en/doc, v2.4).

const KEY = 'test-17track-key';
type Call = { url: string; headers: Record<string, string>; body: any };

/** 17track: `answer` gets the endpoint (register, gettrackinfo) and the numbers, and gives the data object. */
function fake17(answer: (path: string, numbers: string[]) => any) {
  const calls: Call[] = [];
  const api = (async (input: any, init: any = {}) => {
    const c: Call = { url: String(input), headers: init.headers || {}, body: JSON.parse(init.body || 'null') };
    calls.push(c);
    const data = answer(c.url.split('/').pop()!, (c.body || []).map((x: any) => x.number));
    if (data instanceof Error) throw data;
    return new Response(JSON.stringify(data === null ? { code: 500, data: null } : { code: 0, data }), { status: data === null ? 500 : 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { api, calls };
}

const info = (number: string, status = 'InTransit') => ({ number, carrier: 3011, track_info: { latest_status: { status, sub_status: `${status}_Other` }, latest_event: { time_utc: '2026-11-09T08:30:00Z', description: 'Arrived at the sorting centre', location: null, address: { country: 'IL', city: 'MODIIN' } } } });
const rejected = (number: string, code: number) => ({ number, error: { code, message: String(code) } });

test('the website\'s tracking page: https only, {number} and {order} filled in, kept as the owner typed it', () => {
  assert.equal(cleanTrackingPage(''), null);
  assert.equal(cleanTrackingPage('  https://my-store.co.il/track?n={number}  '), 'https://my-store.co.il/track?n={number}');
  assert.equal(cleanTrackingPage('https://my-store.co.il/orders/{order}'), 'https://my-store.co.il/orders/{order}');
  for (const bad of ['http://my-store.co.il/track', 'javascript:alert(1)', 'my-store.co.il/track', 'https://localhost/track', 'https://a:b@my-store.co.il/', `https://my-store.co.il/${'x'.repeat(300)}`]) {
    assert.throws(() => cleanTrackingPage(bad), (e: any) => e instanceof TrackingPageError && e.he.length > 0, bad);
  }
  assert.equal(pageFor('https://my-store.co.il/track?n={number}&o={order}', 'RR 1', '#1042'), 'https://my-store.co.il/track?n=RR%201&o=1042');
  assert.equal(pageFor('https://my-store.co.il/track?n={number}', null, '1042'), null, 'no number to put in it');
  assert.equal(pageFor('https://my-store.co.il/track', null, '1042'), 'https://my-store.co.il/track');

  // The link: the website's page, then the store's own, then 17track's page for the number.
  const ship = { status: null, company: 'HFD', number: 'HFD000000', url: 'https://track.example/HFD000000' };
  assert.equal(linkFor('https://my-store.co.il/t/{number}', ship, '1042'), 'https://my-store.co.il/t/HFD000000');
  assert.equal(linkFor(null, ship, '1042'), 'https://track.example/HFD000000');
  assert.equal(linkFor(null, { ...ship, url: null }, '1042'), 'https://t.17track.net/en#nums=HFD000000');
  assert.equal(linkFor(null, { ...ship, url: null, number: '12' }, '1042'), null, '17track takes 5 to 50 letters, digits or dashes');
  assert.equal(link17('LX000000000CN'), 'https://t.17track.net/en#nums=LX000000000CN');
  assert.equal(trackNumber(' rr 000 000 000 il '), 'RR000000000IL');
});

test('WooCommerce: the tracking plugins\' meta, with only a web address taken as a link', () => {
  const ships = wooShipments({ meta_data: [{ key: '_wc_shipment_tracking_items', value: [
    { tracking_provider: 'israel-post', tracking_number: 'RR000000000IL', custom_tracking_link: '', date_shipped: '1762646400' },
    { custom_tracking_provider: 'שליח עד הבית', tracking_number: 'SH000001', custom_tracking_link: 'https://track.example/SH000001' },
    { tracking_provider: 'x', tracking_number: 'X00001', custom_tracking_link: 'javascript:alert(1)' },
    null,
  ] }] });
  assert.deepEqual(ships, [
    { status: null, company: 'israel-post', number: 'RR000000000IL', url: null },
    { status: null, company: 'שליח עד הבית', number: 'SH000001', url: 'https://track.example/SH000001' },
    { status: null, company: 'x', number: 'X00001', url: null },
  ]);
});

test('17track: registered once, read, cached; a number it refuses is not asked again for hours; down or slow is no status, never an error', async () => {
  const app = await testApp();
  try {
    const registered = new Set<string>();
    let refuse = new Set<string>();
    let down = false;
    const { api, calls } = fake17((path, numbers) => {
      if (down) return new Error('network down');
      if (path === 'register') {
        const take = numbers.filter((n) => !registered.has(n) && !refuse.has(n));
        for (const n of take) registered.add(n);
        return { accepted: take.map((n) => ({ origin: 1, number: n, carrier: 3011 })), rejected: numbers.filter((n) => refuse.has(n)).map((n) => rejected(n, -18019903)) };
      }
      return { accepted: numbers.filter((n) => registered.has(n)).map((n) => info(n)), rejected: numbers.filter((n) => !registered.has(n)).map((n) => rejected(n, -18019902)) };
    });
    const c = { db: app.db, env: {} as Record<string, string>, api };

    assert.equal(await track17(c, 'RR000000000IL'), null, 'no key: nothing asked');
    assert.equal(calls.length, 0);

    c.env.TORAN_17TRACK_KEY = KEY;
    const t = await track17(c, 'rr000000000il');
    assert.deepEqual({ ...t, checked: undefined }, { status: 'InTransit', sub: 'InTransit_Other', event: { text: 'Arrived at the sorting centre', place: 'MODIIN', at: '2026-11-09T08:30:00Z' }, checked: undefined });
    assert.deepEqual(calls.map((x) => [x.url, x.headers['17token'], x.body]), [
      ['https://api.17track.net/track/v2.4/register', KEY, [{ number: 'RR000000000IL' }]],
      ['https://api.17track.net/track/v2.4/gettrackinfo', KEY, [{ number: 'RR000000000IL' }]],
    ]);
    assert.equal((await track17(c, 'RR000000000IL'))?.status, 'InTransit');
    assert.equal(calls.length, 2, 'within the hour: the cache');

    // An hour later: read again, not registered again (no quota spent twice).
    await app.db.query("UPDATE tracking_cache SET checked_at = now() - interval '2 hours'");
    await track17(c, 'RR000000000IL');
    assert.deepEqual(calls.slice(2).map((x) => x.url.split('/').pop()), ['gettrackinfo']);

    // Registered here but not there any more: once more from the register.
    registered.delete('RR000000000IL');
    await app.db.query("UPDATE tracking_cache SET checked_at = now() - interval '2 hours'");
    assert.equal((await track17(c, 'RR000000000IL'))?.status, 'InTransit');
    assert.deepEqual(calls.slice(3).map((x) => x.url.split('/').pop()), ['gettrackinfo', 'register', 'gettrackinfo']);

    // A number it will not take (no carrier detected): kept as refused, not asked again.
    refuse = new Set(['ZZ0000000']);
    const n = calls.length;
    assert.equal(await track17(c, 'ZZ0000000'), null);
    assert.equal(await track17(c, 'ZZ0000000'), null);
    assert.equal(calls.length, n + 1);
    assert.equal((await app.db.one<any>("SELECT refused FROM tracking_cache WHERE number = 'ZZ0000000'")).refused, '-18019903');

    // Down: null, nothing kept, nothing thrown; and a number 17track would refuse by its format is not sent.
    down = true;
    assert.equal(await track17(c, 'LX000000000CN'), null);
    assert.equal(await app.db.one("SELECT 1 FROM tracking_cache WHERE number = 'LX000000000CN'"), null);
    const m = calls.length;
    assert.equal(await track17(c, '12'), null);
    assert.equal(calls.length, m);

    // A 500 with no data is the same.
    down = false;
    const broken = fake17(() => null);
    assert.equal(await track17({ ...c, api: broken.api }, 'LX000000001CN'), null);
  } finally {
    await app.db.close();
  }
});

test('17track: a number already registered elsewhere is read as it is; a status not there yet is asked again in minutes', async () => {
  const app = await testApp();
  try {
    let status: string | null = null;
    const { api, calls } = fake17((path, numbers) => {
      if (path === 'register') return { accepted: [], rejected: numbers.map((n) => rejected(n, -18019901)) };
      return status ? { accepted: numbers.map((n) => info(n, status!)), rejected: [] } : { accepted: [], rejected: numbers.map((n) => rejected(n, -18019909)) };
    });
    const c = { db: app.db, env: { TORAN_17TRACK_KEY: KEY }, api };
    assert.equal(await track17(c, 'CP000000000IL'), null, 'nothing yet');
    assert.equal(await track17(c, 'CP000000000IL'), null);
    assert.equal(calls.length, 2, 'a few minutes before asking again');
    status = 'Delivered';
    await app.db.query("UPDATE tracking_cache SET checked_at = now() - interval '6 minutes'");
    assert.equal((await track17(c, 'CP000000000IL'))?.status, 'Delivered');
    assert.deepEqual(calls.slice(2).map((x) => x.url.split('/').pop()), ['gettrackinfo'], 'registered already: read only');
  } finally {
    await app.db.close();
  }
});
