import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// Going live from the dashboard (TORAN-READINESS.md P1-7, golive.ts): a store with a channel and Toran switched off
// gets one press on Today; the setup step says it; Settings pauses and switches it on again; a team member cannot.

const member = (ws: number) => ({ ...customer(ws), role: 'client_member' as const });

test('one press to go live on Today, a step in setup, and a pause in Settings', async () => {
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 15, agent_live_at = NULL, agent_paused_at = NULL WHERE id = $1', [id]);
    const live = async () => (await s.app.db.one<any>('SELECT agent_live_at, agent_paused_at FROM stores WHERE id = $1', [id]))!;
    await s.app.db.query("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', 'sim', 'shop@in.golive.test', 'x')", [id]);
    s.as(s.accounts.session(customer(15)).cookie);

    // A channel connected, Toran never switched on: the one press, and no month of numbers yet.
    let page = await (await s.get('/')).text();
    assert.match(page, /<div class="banner info" id="golive">[^]*נשאר צעד אחד: להפעיל את תורן[^]*action="\/lead\/\d+\/live"/);
    assert.doesNotMatch(page, /class="kpis"/);
    const token = await s.csrf('/');
    let r = await s.post(`/lead/${id}/live`, { _csrf: token, on: '1' });
    assert.equal(r.status, 303);
    assert.ok((await live()).agent_live_at, 'switched on');
    page = await (await s.get('/')).text();
    assert.doesNotMatch(page, /id="golive"/);
    assert.match(page, /class="kpis"/, 'answering: the month\'s numbers');

    // Settings: pause, and on again.
    let settings = await (await s.get('/settings')).text();
    assert.match(settings, /<section class="panel" id="golive">[^]*עונה ללקוחות[^]*להשהות את תורן/);
    r = await s.post(`/lead/${id}/live`, { _csrf: token, on: '0' });
    assert.equal(r.headers.get('location'), '/settings#golive');
    assert.ok((await live()).agent_paused_at, 'paused');
    page = await (await s.get('/')).text();
    assert.match(page, /<div class="banner warn" id="golive">[^]*תורן מושהה/);
    settings = await (await s.get('/settings')).text();
    assert.match(settings, /מושהה[^]*להפעיל שוב/);
    await s.post(`/lead/${id}/live`, { _csrf: token, on: '1' });
    assert.equal((await live()).agent_paused_at, null);

    // A team member sees where it stands but cannot switch it.
    s.as(s.accounts.session(member(15)).cookie);
    const t2 = await s.csrf('/settings');
    const refused = await s.post(`/lead/${id}/live`, { _csrf: t2, on: '0' });
    assert.ok([303, 403].includes(refused.status), 'refused (as a page with the reason, or a 403)');
    if (refused.status === 303) assert.match(decodeURIComponent(String(refused.headers.get('set-cookie'))), /רק מי שפתח את החשבון/);
    assert.equal((await live()).agent_paused_at, null, 'still answering');
  } finally {
    await s.close();
  }
});

test('/internal/setup: "מפעילים את תורן" is required, done once Toran is live, attention while paused', async () => {
  const { INTERNAL_TOKEN } = await import('./helpers.ts');
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 16, agent_live_at = NULL, agent_paused_at = NULL WHERE id = $1', [id]);
    const step = async () => {
      const d = await (await fetch(`${s.base}/internal/setup?workspace=16`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } })).json();
      return d.steps.find((x: any) => x.key === 'live');
    };
    let x = await step();
    assert.deepEqual([x.required, x.status], [true, 'todo']);
    await s.app.db.query('UPDATE stores SET agent_live_at = now() WHERE id = $1', [id]);
    assert.equal((await step()).status, 'done');
    await s.app.db.query('UPDATE stores SET agent_paused_at = now() WHERE id = $1', [id]);
    x = await step();
    assert.equal(x.status, 'attention');
  } finally {
    await s.close();
  }
});

test('the operator sets the big plan\'s price beside the store plan\'s; empty keeps it off; an older form leaves it as it was', async () => {
  const { getOffer } = await import('../src/offer.ts');
  const s = await serve();
  try {
    s.login();
    const page = await (await s.get('/settings')).text();
    assert.match(page, /name="bigMonthly"/);
    const token = await s.csrf('/settings');
    const base = { _csrf: token, monthly: '590', vat: 'excluded', setup: '990', city: 'אשדוד' };
    assert.equal((await s.post('/settings/offer', { ...base, bigMonthly: '1190' })).status, 303);
    assert.equal((await getOffer(s.app.db)).bigMonthly, 1190);
    await s.post('/settings/offer', base);
    assert.equal((await getOffer(s.app.db)).bigMonthly, 1190, 'a form without the field leaves it');
    await s.post('/settings/offer', { ...base, bigMonthly: '' });
    assert.equal((await getOffer(s.app.db)).bigMonthly, null, 'emptied: off');
  } finally {
    await s.close();
  }
});

test('Settings links to accounts\' email choices', async () => {
  const s = await serve();
  try {
    await s.app.db.query('UPDATE stores SET workspace_id = 17 WHERE id = $1', [s.seeded.storeId]);
    s.as(s.accounts.session(customer(17)).cookie);
    assert.match(await (await s.get('/settings')).text(), /<section class="panel" id="mails">[^]*href="https:\/\/accounts\.test\/notifications"/);
  } finally {
    await s.close();
  }
});

test('"ככה תורן עונה": the sample chat on what Toran knows, "נראה טוב" closes the review step; opening the page alone does not', async () => {
  const { INTERNAL_TOKEN } = await import('./helpers.ts');
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 18 WHERE id = $1', [id]);
    await s.app.db.query("DELETE FROM faqs WHERE store_id = $1 AND answer IS NOT NULL", [id]);
    await s.app.db.query("INSERT INTO pitches (store_id, sample_chat) VALUES ($1, $2::jsonb) ON CONFLICT (store_id) DO UPDATE SET sample_chat = EXCLUDED.sample_chat", [id, JSON.stringify([{ role: 'customer', text: 'יש ספל ירוק?' }, { role: 'agent', text: 'כן, יש במלאי. 89 ₪.' }])]);
    const step = async () => (await (await fetch(`${s.base}/internal/setup?workspace=18`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } })).json()).steps.find((x: any) => x.key === 'knowledge');
    s.as(s.accounts.session(customer(18)).cookie);
    const page = await (await s.get(`/lead/${id}/knowledge`)).text();
    assert.match(page, /<section class="panel" id="sample"><header><h2>ככה תורן עונה<\/h2>[^]*יש ספל ירוק\?[^]*כן, יש במלאי/);
    assert.match(page, /action="\/lead\/\d+\/answers-ok"[^]*נראה טוב[^]*href="#answers"[^]*לתקן/);
    assert.equal((await step()).status, 'todo', 'opening the page is not a review');
    const r = await s.post(`/lead/${id}/answers-ok`, { _csrf: await s.csrf(`/lead/${id}/knowledge`) });
    assert.equal(r.headers.get('location'), `/lead/${id}/knowledge#sample`);
    assert.equal((await step()).status, 'done');
    assert.match(await (await s.get(`/lead/${id}/knowledge`)).text(), /אישרתם שככה תורן עונה/);
  } finally {
    await s.close();
  }
});
