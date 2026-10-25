import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_PHONE } from '../src/demoSeed.ts';
import { israelWeekdayHour } from '../src/core/clock.ts';
import { toranMark, ofMark } from '../src/brand.ts';
import { setOffer } from '../src/offer.ts';
import { handleInbound } from '../src/wa/router.ts';
import { serve, TEST_OFFER } from './serve.ts';

test('the marks come from the brand module, square and in their colours; OpenFrequency is the small halftone at 48px and below', () => {
  const t = toranMark(32);
  assert.match(t, /width="32" height="32"/);
  assert.match(t, /fill="#0F7A54"/);
  assert.equal((ofMark(48).match(/<circle/g) || []).length, 21);
  assert.equal((ofMark(64).match(/<circle/g) || []).length, 37);
});

test('the dashboard: the accounts login, every page, CSRF on every action, noindex everywhere', async () => {
  const s = await serve();
  try {
    const out = await s.get('/leads?all=1');
    assert.equal(out.status, 303, 'no session: to the accounts login');
    assert.equal(out.headers.get('location'), `https://accounts.test/login?next=${encodeURIComponent(`${s.base}/leads?all=1`)}`);
    s.login();
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
    const held = await s.post(`/lead/${id}/approve`, { _csrf: token }, { 'x-tn-ajax': '1' });
    assert.equal((await held.json()).ok, false, 'no price yet: the page cannot be approved');
    assert.match(await (await s.get('/review')).text(), /המחיר עוד לא נקבע/);
    await setOffer(s.app.db, TEST_OFFER);
    const ap = await s.post(`/lead/${id}/approve`, { _csrf: token }, { 'x-tn-ajax': '1' });
    assert.deepEqual((await ap.json()).ok, true);
    const lead = await (await s.get(`/lead/${id}`)).text();
    assert.match(lead, /id="first-msg"/);
    assert.match(lead, /היי, כאן OpenFrequency\. בנינו לכלי חרס של נורית תורן שעונה ללקוחות שלכם/);
    assert.match(lead, /אם זה לא רלוונטי, אפשר לענות &quot;לא&quot; ולא נכתוב שוב/);
    await s.post(`/lead/${id}/sent`, { _csrf: token });
    const st = await s.app.db.one<any>('SELECT status, sent_at, followup_due_at FROM stores WHERE id = $1', [id]);
    assert.equal(st.status, 'sent');
    const due = new Date(st.followup_due_at).getTime();
    const { weekday, hour } = israelWeekdayHour(due);
    assert.ok(!(weekday === 6 || (weekday === 5 && hour >= 13)), 'the reminder is not due on Shabbat');
    await s.app.db.query("UPDATE stores SET followup_due_at = now() - interval '1 hour' WHERE id = $1", [id]);
    assert.match(await (await s.get('/followups')).text(), /זו ההודעה האחרונה שלנו בנושא/);
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
    assert.equal((await s.get(`/s/${s.seeded.slug}`)).status, 404, 'not approved yet: nobody outside sees it');
    await setOffer(s.app.db, TEST_OFFER);
    await s.app.db.query("UPDATE stores SET status = 'sent', approved_at = now() WHERE id = $1", [id]);
    const r = await s.get(`/s/${s.seeded.slug}`);
    assert.equal(r.status, 200);
    assert.match(String(r.headers.get('x-robots-tag')), /noindex/);
    const html = await r.text();
    assert.match(html, new RegExp(`wa\\.me/972500000999\\?text=${s.seeded.code}`));
    assert.match(html, /<h1>בנינו ל<span class="hl"><bdi>כלי חרס של נורית<\/bdi><\/span> תורן שעונה ללקוחות שלכם<\/h1>/);
    assert.match(html, /<dt>מוצרים<\/dt><dd>14<\/dd><\/div><div><dt>תמונות מוצרים<\/dt><dd>14<\/dd><\/div><div><dt>עמודי מידע<\/dt><dd>4<\/dd>/, 'the numbers come from the ingested store');
    assert.match(html, /עברנו על האתר שלכם, על 14 המוצרים ועל עמודי המשלוחים וההחזרות\./);
    assert.match(html, /<span class="num">199<\/span><span class="cur">₪<\/span><span class="per">לחודש<\/span>/);
    assert.match(html, /<p class="price-notes">לא כולל מע״מ\./);
    assert.equal((html.match(/class="msg /g) || []).length, 4, 'two questions and two answers');
    assert.ok(!/class="ph"|class="held"/.test(html), 'a public page has no placeholder and no owner note');
    assert.ok(!/ניסיון|חינם|ימי ניסיון/.test(html.replace(/<div class="msgs">[\s\S]*?<\/section>/, '')), 'no trial, no free period');
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

test('take this page down: the click flags it, the owner confirms, then the page is gone, its demo code dead, no reminder', async () => {
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    const slug = s.seeded.slug;
    await setOffer(s.app.db, TEST_OFFER);
    await s.app.db.query("UPDATE stores SET status = 'sent', approved_at = now(), sent_at = now(), followup_due_at = now() + interval '4 days' WHERE id = $1", [id]);
    const html = await (await s.get(`/s/${slug}`)).text();
    assert.match(html, new RegExp(`href="https://wa\\.me/${DEMO_PHONE}\\?text=[^"]+" data-takedown`), 'the link writes to our number, not the demo number');
    const beacon = (kind: string) => fetch(`${s.base}/t`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug, kind }) });
    assert.equal((await beacon('takedown_click')).status, 204);
    const asked = await s.app.db.one<any>('SELECT takedown_asked_at, taken_down_at FROM stores WHERE id = $1', [id]);
    assert.ok(asked.takedown_asked_at);
    assert.equal(asked.taken_down_at, null);
    assert.equal((await s.get(`/s/${slug}`)).status, 200, 'the click alone does not take it down');
    await s.login();
    assert.match(await (await s.get('/')).text(), /ביקשו להוריד את העמוד/);
    await s.post(`/lead/${id}/takedown`, { _csrf: await s.csrf() });
    const st = await s.app.db.one<any>('SELECT status, taken_down_at, followup_due_at FROM stores WHERE id = $1', [id]);
    assert.equal(st.status, 'skipped');
    assert.ok(st.taken_down_at);
    assert.equal(st.followup_due_at, null, 'a takedown is an opt-out: no reminder');
    assert.equal((await fetch(`${s.base}/s/${slug}`)).status, 410);
    assert.match(await (await fetch(`${s.base}/s/${slug}`)).text(), /העמוד הזה הוסר/);
    assert.equal((await handleInbound(s.app, { from: '972500000555', text: s.seeded.code, id: 'td-1' })).action, 'bad_code', 'the demo code no longer binds');
    await s.app.db.query("UPDATE stores SET status = 'sent' WHERE id = $1", [id]);
    assert.equal((await fetch(`${s.base}/s/${slug}`)).status, 410, 'changing the status back does not bring the page back');
  } finally {
    await s.close();
  }
});

test('the edit screen: 40 products a page past 40, the search kept from page to page, and on a phone the preview first, behind a tap', async () => {
  const s = await serve();
  try {
    await s.login();
    const id = s.seeded.storeId;
    // 14 products from the fictional store, and 50 more: 64, two pages.
    for (let i = 1; i <= 50; i++) await s.app.db.query("INSERT INTO products (store_id, ext_id, title, search_text, price_min, price_max) VALUES ($1, $2, $3, $3, 10, 10)", [id, `x-${i}`, `פריט לבדיקה ${String(i).padStart(2, '0')}`]);
    const titles = (html: string) => [...html.matchAll(/<td data-k="מוצר"><a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    const one = await (await s.get(`/lead/${id}/review`)).text();
    assert.equal(titles(one).length, 40);
    assert.match(one, /עמוד 1 מתוך 2/);
    assert.match(one, new RegExp(`href="/lead/${id}/review\\?page=2#products" rel="next"`));
    const two = await (await s.get(`/lead/${id}/review?page=2`)).text();
    assert.equal(titles(two).length, 24);
    assert.equal(new Set([...titles(one), ...titles(two)]).size, 64, 'no product on both pages, none left out');
    const q = new URLSearchParams({ q: 'פריט לבדיקה' }).toString();
    const found = await (await s.get(`/lead/${id}/review?${q}&page=2`)).text();
    assert.deepEqual([titles(found).length, /50 מתאימים לחיפוש/.test(found)], [10, true]);
    assert.ok(found.includes(`href="/lead/${id}/review?${q}#products" rel="prev"`), 'the way back keeps the search');
    assert.match(await (await s.get(`/lead/${id}/review?page=99`)).text(), /עמוד 2 מתוך 2/, 'past the last page: the last page');
    assert.match(one, /<div class="cols edit">/);
    assert.match(one, /class="btn pvtoggle" type="button" data-toggle="#pv" aria-expanded="false"/);
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
