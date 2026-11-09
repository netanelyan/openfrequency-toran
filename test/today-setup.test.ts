import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// Today before the store answers anyone (TORAN-READINESS.md P0-3, P0-5; the owner, 2026-11-08: Toran ready for
// customers like Teder, whose home says what is left): "תורן עוד לא עונה ללקוחות" in place of the month's zeros, what is
// left with one next step, and a way to talk to the store's own Toran on our demo number. Once one channel answers,
// Today is the inbox's numbers again.

test('Today before any channel: not answering yet, what is left with one next step, and trying Toran; then the numbers once a channel answers', async () => {
  const s = await serve();
  try {
    s.app.env.PUBLIC_BASE_URL = 'https://toran.example';
    const id = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 5 WHERE id = $1', [id]);
    await s.app.db.query("DELETE FROM channel_accounts WHERE store_id = $1", [id]);
    const store = (await s.app.db.one<{ demo_code: string }>('SELECT demo_code FROM stores WHERE id = $1', [id]))!;
    assert.ok(store.demo_code, 'the seeded store has its demo code');
    s.as(s.accounts.session(customer(5)).cookie);

    let page = await (await s.get('/')).text();
    assert.match(page, /תורן עוד לא עונה ללקוחות/);
    assert.match(page, /<section class="panel setupbox" id="setup"><header><h2>מה נשאר<\/h2><span class="end chip">\d+ מתוך \d+<\/span>/);
    assert.match(page, /<b>מחברים ערוץ אחד לפחות<\/b>/, 'the next step is the one required step left');
    assert.match(page, /<a class="btn primary" href="\/settings#channels">/, 'one main button, to it');
    assert.ok(page.includes(`https://wa.me/${s.app.env.DEMO_WA_NUMBER}?text=`) && page.includes(encodeURIComponent(store.demo_code)), 'the try button opens our demo number with the store\'s code');
    assert.match(page, /השיחה מסומנת דמו ולא נספרת בחבילה/);
    assert.doesNotMatch(page, /class="kpis"/, 'no month of zeros');
    assert.match(page, /<dt>צ׳אט באתר<\/dt><dd>לא מופעל/, 'the web chat is among the channels');

    // The chat switched on but not yet on the site is not answering anyone.
    await s.app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, status, meta) VALUES ($1, 'web', 'web', 'w00112233445566778899', 'active', '{}'::jsonb)", [id]);
    page = await (await s.get('/')).text();
    assert.match(page, /תורן עוד לא עונה ללקוחות/);
    assert.match(page, /<dt>צ׳אט באתר<\/dt><dd>מופעל, ונשאר להוסיף אותו לאתר/);

    // It opened on the store's site: a channel answers, Today has its numbers, and the block is gone.
    await s.app.db.query("UPDATE channel_accounts SET meta = jsonb_build_object('first_seen_at', '2026-11-08T10:00:00Z') WHERE store_id = $1 AND channel = 'web'", [id]);
    page = await (await s.get('/')).text();
    assert.doesNotMatch(page, /תורן עוד לא עונה ללקוחות|id="setup"/);
    assert.match(page, /class="kpis"/);
    assert.match(page, /<dt>צ׳אט באתר<\/dt><dd>פועל באתר/);
  } finally {
    await s.close();
  }
});

test('the web chat\'s first opening on the store\'s own site is kept; a page elsewhere is not', async () => {
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    await s.app.db.query("UPDATE stores SET domain = 'shop.example' WHERE id = $1", [id]);
    await s.app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, status, meta) VALUES ($1, 'web', 'web', 'w0123456789abcdef0123', 'active', $2::jsonb)", [id, JSON.stringify({ domains: ['https://shop.example', 'https://www.shop.example'] })]);
    const seen = async () => (await s.app.db.one<{ meta: any }>("SELECT meta FROM channel_accounts WHERE external_id = 'w0123456789abcdef0123'"))!.meta.first_seen_at;
    await s.get('/w/w0123456789abcdef0123/frame', { referer: 'https://elsewhere.example/page' });
    assert.equal(await seen(), undefined, 'another site');
    await s.get('/w/w0123456789abcdef0123/frame');
    assert.equal(await seen(), undefined, 'no referer');
    assert.equal((await s.get('/w/w0123456789abcdef0123/frame', { referer: 'https://www.shop.example/products/mug' })).status, 200);
    assert.match(String(await seen()), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await s.close();
  }
});
