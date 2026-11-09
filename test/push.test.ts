import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { latestNotification, notify, pushHostOk, subscribe, vapid, vapidAuth } from '../src/owners/push.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// The owner's browser notifications (src/owners/push.ts, TORAN-READINESS.md P1-11), as Teder's: an empty push signed
// with the server's VAPID key to the browsers of the store's workspace and the operator's, the words kept here for the
// service worker to ask for behind the session; only the browsers' own push services are written to.

const FCM = 'https://fcm.googleapis.com/fcm/send/abc123';

test('only the push services browsers use; the VAPID header is a JWT for the service\'s origin, signed with the kept key', async () => {
  for (const ok of [FCM, 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/Q', 'https://db5p.notify.windows.com/w/?token=x']) assert.ok(pushHostOk(ok), ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://127.0.0.1/x', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.example/x', 'nope']) assert.ok(!pushHostOk(bad), bad);
  const s = await serve();
  try {
    const k1 = await vapid(s.app.db);
    assert.equal((await vapid(s.app.db)).publicKey, k1.publicKey, 'made once and kept');
    const h = await vapidAuth(s.app.db, FCM, {});
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
    assert.equal(k, k1.publicKey);
    const [head, claims, sig] = jwt.split('.');
    assert.equal(JSON.parse(Buffer.from(claims, 'base64url').toString()).aud, 'https://fcm.googleapis.com');
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: k1.jwk.x, y: k1.jwk.y }, format: 'jwk' });
    assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  } finally {
    await s.close();
  }
});

test('notify: kept, pushed to the store\'s workspace and the operator, never another workspace; a gone browser is forgotten', async () => {
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 21 WHERE id = $1', [id]);
    assert.deepEqual(await subscribe(s.app.db, 'https://evil.example/x', { userId: 1, workspaceId: 21 }), { problem: 'not a push endpoint' });
    await subscribe(s.app.db, FCM, { userId: 1, workspaceId: 21 });
    await subscribe(s.app.db, 'https://web.push.apple.com/gone', { userId: 1, workspaceId: 21 });
    await subscribe(s.app.db, 'https://updates.push.services.mozilla.com/wpush/v2/op', { userId: 9, workspaceId: null });
    await subscribe(s.app.db, 'https://fcm.googleapis.com/fcm/send/other', { userId: 2, workspaceId: 22 });
    const sent: string[] = [];
    const n = await notify(s.app, { storeId: id, kind: 'waiting', title: 'לקוח מחכה', body: 'יש ספל ירוק?', url: '/chat/1' }, async (endpoint, headers) => {
      sent.push(endpoint);
      assert.equal(headers['content-length'], '0', 'no words in the push');
      return { status: endpoint.includes('/gone') ? 410 : 201 };
    });
    assert.deepEqual(sent.sort(), [FCM, 'https://updates.push.services.mozilla.com/wpush/v2/op', 'https://web.push.apple.com/gone'].sort());
    assert.equal((await s.app.db.one<any>("SELECT COUNT(*)::int AS n FROM push_subs WHERE endpoint LIKE '%/gone'")).n, 0, 'forgotten');
    assert.equal((await s.app.db.one<any>('SELECT pushed FROM notifications WHERE id = $1', [n])).pushed, 2);
    assert.equal((await latestNotification(s.app.db, 21))!.title, 'לקוח מחכה');
    assert.equal(await latestNotification(s.app.db, 22), null, 'another workspace sees nothing');
  } finally {
    await s.close();
  }
});

test('the routes: the key, a subscription in the session\'s workspace, the newest for its service worker; /sw.js at the root; the Settings panel', async () => {
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 23 WHERE id = $1', [id]);
    const sw = await s.get('/sw.js');
    assert.equal(sw.status, 200);
    assert.match(String(sw.headers.get('content-type')), /javascript/);
    s.as(s.accounts.session(customer(23)).cookie);
    const settings = await (await s.get('/settings')).text();
    assert.match(settings, /<section class="panel" id="push">[^]*data-push="[A-Za-z0-9_-]{80,}"/);
    assert.match(settings, /הוספה למסך הבית/);
    const key = (await (await s.get('/push/key')).json()).key;
    assert.equal(key, (await vapid(s.app.db)).publicKey);
    const token = await s.csrf('/settings');
    assert.equal((await s.post('/push/subscribe', { _csrf: token, endpoint: 'https://127.0.0.1/x' }, { 'x-tn-ajax': '1' })).status, 400);
    assert.equal((await s.post('/push/subscribe', { _csrf: token, endpoint: FCM }, { 'x-tn-ajax': '1' })).status, 200);
    assert.equal((await s.app.db.one<any>('SELECT workspace_id FROM push_subs WHERE endpoint = $1', [FCM])).workspace_id, 23);
    await notify(s.app, { storeId: id, kind: 'waiting', title: 'לקוח מחכה', body: 'שאלה', url: '/chat/2' }, async () => ({ status: 201 }));
    assert.equal((await (await s.get('/notifications/latest.json')).json()).url, '/chat/2');
    s.as(s.accounts.session(customer(24)).cookie);
    assert.equal(await (await s.get('/notifications/latest.json')).json(), null, 'another workspace');
  } finally {
    await s.close();
  }
});
