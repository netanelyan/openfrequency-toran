import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTrackingPage, linkFor, pageFor, TrackingPageError } from '../src/tracking.ts';
import { wooShipments } from '../src/orders.ts';

// Where a package is (src/tracking.ts): the website's tracking page, and the link.

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

  // The link: the website's page when the store has one, else the store's own; nothing else.
  const ship = { status: null, company: 'HFD', number: 'HFD000000', url: 'https://track.example/HFD000000' };
  assert.equal(linkFor('https://my-store.co.il/t/{number}', ship, '1042'), 'https://my-store.co.il/t/HFD000000');
  assert.equal(linkFor(null, ship, '1042'), 'https://track.example/HFD000000');
  assert.equal(linkFor(null, { ...ship, url: null }, '1042'), null, 'no page and no link from the store: no link');
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

test('the tracking page\'s "https only" reads right to left: no address part at the end of the line to turn into "//:https"', () => {
  assert.throws(() => cleanTrackingPage('http://my-store.co.il/track'), (e: any) => e instanceof TrackingPageError && e.he === 'הכתובת צריכה להתחיל ב־https, למשל https://my-store.co.il/track');
});
