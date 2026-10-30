import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simEmail } from '../src/channels/email.ts';
import { drain } from '../src/jobs/worker.ts';
import { GraphError } from '../src/channels/meta.ts';
import { sendFailedHe } from '../src/web/pages/home.ts';
import { refusalPage } from '../src/web/pages/basic.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// What a person sees when something does not go (the audit's PRA-FE-002, -003 and -005): every public page links to
// the accessibility statement and the product strip can be stopped; a reply the channel refuses keeps the owner's text
// and says why in Hebrew; an error is Toran's own page, in Hebrew, with the way back, never an exception's words.

const A11Y = 'href="https://openfrequency.co.il/accessibility"';

test('the pitch page\'s strip stops on a button, on hover and on focus, and goes round once without the script; every public page links to the accessibility statement', async () => {
  const s = await serve();
  try {
    s.login();
    const slug = (await s.app.db.one<{ slug: string }>('SELECT slug FROM stores WHERE id = $1', [s.seeded.storeId]))!.slug;
    const page = await (await s.get(`/s/${slug}`)).text();
    assert.ok(page.includes(A11Y), 'the pitch page');
    if (page.includes('class="shelf"')) assert.match(page, /<button class="shelf-pause" type="button" aria-pressed="false" hidden>לעצור את התנועה<\/button>/);
    const css = await (await s.get('/static/pitch.css')).text();
    assert.match(css, /\.shelf-track \{ animation-iteration-count: 1; \}/);
    assert.match(css, /\.shelf:hover \.shelf-track, \.shelf-wrap:focus-within \.shelf-track, \.shelf\.paused \.shelf-track \{ animation-play-state: paused; \}/);
    assert.ok((await (await s.get('/s/no-such-page')).text()).includes(A11Y), 'a page that is not there');
    assert.ok((await (await s.get('/u/not-a-real-token-at-all')).text()).includes(A11Y), 'the stop page of an automatic message');
    assert.ok(refusalPage('closed', '/').includes(A11Y), 'the pages that refuse a session');
  } finally {
    await s.close();
  }
});

test('a reply the channel refuses: a Hebrew reason inside the reply box, the text kept, nothing written as sent (PRA-FE-003)', async () => {
  const s = await serve();
  try {
    s.app.env.TORAN_CHANNELS = 'whatsapp,email';
    s.app.mail = simEmail({ domain: 'in.toran.test' });
    s.login();
    const id = s.seeded.storeId;
    assert.equal((await s.post(`/lead/${id}/channels/email`, { _csrf: await s.csrf(), on: '1' })).status, 303);
    const address = (await s.app.db.one<any>("SELECT external_id FROM channel_accounts WHERE store_id = $1 AND status = 'active' AND channel = 'email'", [id])).external_id;
    await fetch(`${s.base}/mail/sim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'Dana <dana@example.test>', to: [address], subject: 'שאלה', text: 'יש לכם קערה?', message_id: '<fe3-1@example.test>' }) });
    await drain(s.app, { kinds: ['mail_inbound'] });
    const conv = (await s.app.db.one<any>("SELECT id FROM conversations WHERE channel = 'email'")).id;
    const page = await (await s.get(`/chat/${conv}`)).text();
    assert.match(page, new RegExp(`<form method="post" action="/chat/${conv}/reply" data-ajax="reply"`));
    assert.match(page, /<p class="small bad mt8 m0" data-error role="alert" hidden><\/p>/);
    const owners = async () => (await s.app.db.one<any>("SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND role = 'owner'", [conv])).n;
    s.app.mail.send = async () => {
      throw new Error('fetch failed: ECONNRESET');
    };
    const r = await s.post(`/chat/${conv}/reply`, { _csrf: await s.csrf(`/chat/${conv}`), text: 'כן, יש.' }, { 'x-tn-ajax': '1' });
    assert.equal(r.status, 502);
    const out = await r.json();
    assert.equal(out.ok, false);
    assert.match(out.message, /^לא הצלחנו להגיע למייל כרגע, ולא נשלח כלום\. התשובה נשארה כאן/);
    assert.doesNotMatch(out.message, /ECONNRESET/, 'the provider\'s words go to the log');
    assert.equal(await owners(), 0, 'nothing written as sent');
    assert.match(sendFailedHe(new GraphError('Meta refused', 400, 190), 'וואטסאפ'), /החיבור של הוואטסאפ לתורן הסתיים/);
    assert.match(sendFailedHe(new GraphError('Meta refused', 400, 131000), 'וואטסאפ'), /^וואטסאפ לא קיבל את ההודעה \(קוד 131000\)\. התשובה נשארה כאן/);
  } finally {
    await s.close();
  }
});

test('an error is Toran\'s own page in Hebrew with the way back, never an exception\'s words (PRA-FE-005)', async () => {
  const s = await serve();
  try {
    s.as(s.accounts.session(customer(1)).cookie);
    await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [s.seeded.storeId]);
    const stale = await s.post(`/lead/${s.seeded.storeId}/faq`, { _csrf: 'stale', question: 'q?', answer: 'a' }, { referer: `${s.base}/lead/${s.seeded.storeId}/knowledge` });
    assert.equal(stale.status, 403);
    const html = await stale.text();
    assert.match(html, /data-error-status="403"/);
    assert.match(html, /הדף ישן\. רעננו אותו ונסו שוב\./);
    assert.ok(html.includes(`href="/lead/${s.seeded.storeId}/knowledge">חזרה לדף הקודם`), 'back to the page before');
    assert.ok(html.includes('href="/">להיום'));
    assert.ok(html.includes(A11Y));
    const missing = await s.get('/chat/999999');
    assert.equal(missing.status, 404);
    // An exception that is not ours: the generic Hebrew line, its message in the log only.
    const logged: string[] = [];
    const log = s.app.log;
    s.app.log = (line: string) => logged.push(line);
    s.app.db.query = (async () => {
      throw new Error('relation "secret_table" does not exist');
    }) as any;
    const boom = await s.get('/');
    s.app.log = log;
    assert.equal(boom.status, 500);
    const body = await boom.text();
    assert.match(body, /משהו השתבש אצלנו\. הפרטים נשמרו ביומן/);
    assert.doesNotMatch(body, /secret_table/);
    assert.ok(logged.some((l) => /secret_table/.test(l)));
  } finally {
    s.server.close();
    await s.accounts.close();
  }
});
