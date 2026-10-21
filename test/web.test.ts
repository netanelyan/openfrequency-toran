import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../src/web/server.ts';
import { DEMO_PHONE, seedDemo } from '../src/demoSeed.ts';
import { followupDue } from '../src/outreach.ts';
import { israelWeekdayHour } from '../src/core/clock.ts';
import { toranMark, ofMark } from '../src/brand.ts';
import { testApp } from './helpers.ts';

async function serve() {
  const app = await testApp();
  app.env.DEMO_WA_NUMBER = '972500000999';
  app.env.TORAN_OWNER_WHATSAPP = DEMO_PHONE; // the demo's own chat is the owner testing: it moves no lead
  const seeded = await seedDemo(app, { conversation: true });
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const handler = createHandler(app, { port, failDelayMs: 0 });
  server.on('request', handler);
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const get = (p: string, headers: Record<string, string> = {}) => fetch(base + p, { headers: { cookie, ...headers }, redirect: 'manual' });
  const post = (p: string, form: Record<string, string>, headers: Record<string, string> = {}) => fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: base, ...headers }, body: new URLSearchParams(form), redirect: 'manual' });
  const login = async () => {
    const r = await post('/login', { user: 'demo', password: 'demo-password-123' });
    cookie = String(r.headers.get('set-cookie')).split(';')[0];
    return r;
  };
  const csrf = async (p = '/') => /name="_csrf" value="([^"]+)"/.exec(await (await get(p)).text())?.[1] || '';
  return { app, seeded, server, base, get, post, login, csrf, close: async () => { server.close(); await app.db.close(); } };
}

test('the marks come from the brand module, square and in their colours; OpenFrequency is the small halftone at 48px and below', () => {
  const t = toranMark(32);
  assert.match(t, /width="32" height="32"/);
  assert.match(t, /fill="#0F7A54"/);
  assert.equal((ofMark(48).match(/<circle/g) || []).length, 21);
  assert.equal((ofMark(64).match(/<circle/g) || []).length, 37);
});

test('the dashboard: login, every page, CSRF on every action, noindex everywhere', async () => {
  const s = await serve();
  try {
    assert.equal((await s.get('/')).status, 303, 'no session: to the login');
    assert.equal((await s.login()).status, 303);
    for (const p of ['/', '/leads', '/leads?all=1', '/lead/1', '/review', '/lead/1/review', '/chats', '/chat/1', '/followups', '/settings', '/brand']) {
      const r = await s.get(p);
      assert.equal(r.status, 200, p);
      const html = await r.text();
      assert.match(html, /<html lang="he" dir="rtl"/);
      assert.match(html, /noindex/);
      assert.ok(!/style="/.test(html), `${p}: no inline style (the CSP forbids them)`);
    }
    assert.match(await (await s.get('/brand')).text(), /OpenFrequency/);
    assert.equal((await s.post('/lead/1/approve', {})).status, 403, 'no CSRF token: refused');
    assert.equal((await s.post('/lead/1/approve', { _csrf: await s.csrf() }, { origin: 'https://evil.example' })).status, 403, 'a foreign origin: refused');
    assert.equal((await s.get('/static/manifest.webmanifest')).status, 200);
    const m = await (await s.get('/static/manifest.webmanifest')).json();
    assert.deepEqual([m.name, m.lang, m.dir], ['תורן', 'he', 'rtl']);
  } finally {
    await s.close();
  }
});

test('the funnel: review, approve, send by hand, the one reminder (never on Shabbat), and no second one', async () => {
  const s = await serve();
  try {
    await s.login();
    const id = s.seeded.storeId;
    assert.match(await (await s.get('/review')).text(), /כלי חרס של נורית/);
    const token = await s.csrf();
    const ap = await s.post(`/lead/${id}/approve`, { _csrf: token }, { 'x-tn-ajax': '1' });
    assert.deepEqual((await ap.json()).ok, true);
    const lead = await (await s.get(`/lead/${id}`)).text();
    assert.match(lead, /id="first-msg"/);
    assert.match(lead, /אם זה לא רלוונטי, אפשר לענות &quot;לא&quot; ולא אכתוב שוב/);
    await s.post(`/lead/${id}/sent`, { _csrf: token });
    const st = await s.app.db.one<any>('SELECT status, sent_at, followup_due_at FROM stores WHERE id = $1', [id]);
    assert.equal(st.status, 'sent');
    const due = new Date(st.followup_due_at).getTime();
    const { weekday, hour } = israelWeekdayHour(due);
    assert.ok(!(weekday === 6 || (weekday === 5 && hour >= 13)), 'the reminder is not due on Shabbat');
    await s.app.db.query("UPDATE stores SET followup_due_at = now() - interval '1 hour' WHERE id = $1", [id]);
    assert.match(await (await s.get('/followups')).text(), /זו ההודעה האחרונה שלי בנושא/);
    await s.post(`/lead/${id}/followup-sent`, { _csrf: token });
    const again = await s.post(`/lead/${id}/followup-sent`, { _csrf: token }, { 'x-tn-ajax': '1' });
    assert.equal((await again.json()).ok, false, 'one reminder, then stop');
  } finally {
    await s.close();
  }
});

test('the pitch page: noindex, the store\'s colours, the demo link with its code; opens count, the owner\'s do not', async () => {
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    await s.app.db.query("UPDATE stores SET status = 'sent' WHERE id = $1", [id]);
    const r = await s.get(`/s/${s.seeded.slug}`);
    assert.equal(r.status, 200);
    assert.match(String(r.headers.get('x-robots-tag')), /noindex/);
    const html = await r.text();
    assert.match(html, new RegExp(`wa\\.me/972500000999\\?text=${s.seeded.code}`));
    assert.match(html, /בניתי עוזר לוואטסאפ של כלי חרס של נורית/);
    assert.ok(!/[—–]/.test(html.replace(/<title>[\s\S]*?<\/title>/, '')), 'no em or en dashes in the copy');
    assert.match(await (await s.get(`/s/${s.seeded.slug}/theme.css`)).text(), /--store:#b4532a/);
    const st = await s.app.db.one<any>('SELECT status, opened_at FROM stores WHERE id = $1', [id]);
    assert.equal(st.status, 'opened');
    const visitor = String(r.headers.get('set-cookie')).split(';')[0];
    assert.equal((await fetch(`${s.base}/t`, { method: 'POST', headers: { cookie: visitor, 'content-type': 'application/json' }, body: JSON.stringify({ slug: s.seeded.slug, kind: 'scroll', depth: 75 }) })).status, 204);
    const ev = await s.app.db.one<any>("SELECT COUNT(*)::int AS n FROM events WHERE store_id = $1 AND kind = 'scroll'", [id]);
    assert.equal(ev.n, 1);
    await s.login();
    const opens = async () => (await s.app.db.one<any>("SELECT COUNT(*)::int AS n FROM events WHERE store_id = $1 AND kind = 'page_open'", [id])).n;
    const before = await opens();
    await s.get(`/s/${s.seeded.slug}?preview=1`);
    await s.get(`/s/${s.seeded.slug}`);
    assert.equal(await opens(), before, 'the owner\'s own visits are not opens');
    assert.equal((await s.get('/s/no-such-page')).status, 404);
  } finally {
    await s.close();
  }
});

test('the WhatsApp webhook answers the simulator in development and refuses another provider\'s path', async () => {
  const s = await serve();
  try {
    assert.equal((await fetch(`${s.base}/wa/twilio`, { method: 'POST', body: 'x' })).status, 404);
    const r = await fetch(`${s.base}/wa/sim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '972500000555', text: s.seeded.code, id: 'sim-1' }) });
    assert.equal(r.status, 200);
    const job = await s.app.db.one<any>("SELECT kind, status FROM jobs WHERE kind = 'wa_inbound' ORDER BY id DESC LIMIT 1");
    assert.equal(job.status, 'queued');
  } finally {
    await s.close();
  }
});
