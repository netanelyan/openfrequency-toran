import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drain } from '../src/jobs/worker.ts';
import { counted, monthOf } from '../src/plans.ts';
import { defaultDomains, siteOrigin } from '../src/channels/web.ts';
import { ratingOf } from '../src/reviews.ts';
import { customer } from './helpers.ts';
import { HELD_WEB } from '../src/channels/store.ts';
import { setLive } from '../src/golive.ts';
import { WAITING_SQL } from '../src/web/inbox.ts';
import { serve } from './serve.ts';

// The chat on the store's own site (the owner, 2026-11-06, docs/todo.md), and the reviews Toran collects and shows
// there: turned on by the owner, one line on the site, framed only by the store's domains, a visitor's message
// answered by the same agent into the same inbox, the owner answering when they take over, one visitor never reading
// another's, and the reviews shown only with both the customer's yes and the owner's.

const V1 = 'AAAAAAAAAAAAAAAAAAAAAA';
const V2 = 'BBBBBBBBBBBBBBBBBBBBBB';

async function chatOn() {
  const s = await serve();
  const id = s.seeded.storeId;
  await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [id]);
  s.as(s.accounts.session(customer(1)).cookie);
  const res = await s.post(`/lead/${id}/web`, { _csrf: await s.csrf('/settings'), do: 'on' });
  assert.equal(res.status, 303);
  const key = (await s.app.db.one<{ external_id: string }>("SELECT external_id FROM channel_accounts WHERE store_id = $1 AND channel = 'web'", [id]))!.external_id;
  return { s, id, key };
}

const say = (s: Awaited<ReturnType<typeof serve>>, key: string, v: string, text: string) => s.post(`/w/${key}/say`, { v, text });
const lines = async (s: Awaited<ReturnType<typeof serve>>, key: string, v: string, after = 0) => (await (await s.get(`/w/${key}/lines?v=${v}&after=${after}`)).json()) as any;

test('the sites the chat may show on: the store\'s own and its www, https only, nothing else read as one', () => {
  assert.deepEqual(defaultDomains('kli-cheres.example'), ['https://kli-cheres.example', 'https://www.kli-cheres.example']);
  assert.deepEqual(defaultDomains('www.shop.co.il'), ['https://www.shop.co.il', 'https://shop.co.il']);
  assert.equal(siteOrigin('http://Shop.co.il/path'), 'https://shop.co.il');
  for (const bad of ['', 'javascript:alert(1)', 'shop', "https://a.co.il' 'unsafe-inline'", '*.co.il']) assert.equal(siteOrigin(bad), null, bad);
});

test('the owner turns the chat on: one line to add, a loader for the key, a frame only the store\'s sites may show', async () => {
  const { s, id, key } = await chatOn();
  try {
    assert.match(key, /^w[0-9a-f]{20}$/);
    const settings = await (await s.get('/settings')).text();
    assert.ok(settings.includes(`&lt;script src=&quot;http://localhost:4710/w/${key}.js&quot; async&gt;&lt;/script&gt;`) || settings.includes(`/w/${key}.js`), 'the line to add');
    // The main button sends whoever runs the site a ready message with the line (the owner, 2026-11-09: no code for
    // the owner to read); the steps for the store's own platform, and the copy, are folded under "להוסיף בעצמי".
    assert.match(settings, /href="https:\/\/wa\.me\/\?text=[^"]*%3Cscript[^"]*"[^>]*>[^]*לשלוח למי שמנהל לכם את האתר/);
    assert.match(settings, /<summary class="small">להוסיף בעצמי<\/summary>[^]*(theme\.liquid|WPCode|Custom Code)/);
    assert.match(settings, /data-copy="#snippet-\d+"/);

    const js = await s.get(`/w/${key}.js`);
    assert.match(String(js.headers.get('content-type')), /javascript/);
    const loader = await js.text();
    assert.ok(loader.includes(JSON.stringify(key)) && loader.includes('data-toran-reviews'));
    assert.doesNotMatch(loader, /document\.cookie|localStorage/, 'the loader keeps nothing on the store\'s page');
    assert.match(await (await s.get('/w/w00000000000000000000.js')).text(), /this chat is off/, 'a key that is not a chat loads nothing');

    const frame = await s.get(`/w/${key}/frame`);
    assert.equal(frame.status, 200);
    const csp = String(frame.headers.get('content-security-policy'));
    assert.match(csp, /frame-ancestors https:\/\/kli-cheres\.example https:\/\/www\.kli-cheres\.example;/);
    assert.match(csp, /connect-src 'self'/);
    assert.equal(frame.headers.get('x-frame-options'), null, 'framed by the store\'s site, said by the CSP alone');
    const html = await frame.text();
    assert.match(html, /<html lang="he" dir="rtl" class="side-left">/);
    assert.match(html, /aria-controls="c-panel"/);
    assert.match(html, /<script src="\/static\/chat\.js\?v=\w+" defer><\/script>/, 'the chat script, versioned by the deploy');
    assert.match(await (await s.get('/static/chat.js')).text(), /toran:open/);

    // Off: the frame and the loader answer nothing at once.
    await s.post(`/lead/${id}/web`, { _csrf: await s.csrf('/settings'), do: 'off' });
    assert.equal((await s.get(`/w/${key}/frame`)).status, 404);
    assert.match(await (await s.get(`/w/${key}.js`)).text(), /this chat is off/);
  } finally {
    await s.close();
  }
});

test('a visitor writes: answered by the agent into the inbox, counted in the plan; the owner answers when they take over; another visitor reads nothing', async () => {
  const { s, id, key } = await chatOn();
  try {
    assert.equal((await say(s, key, 'bad', 'שלום')).status, 404, 'a visitor id that is not one');
    assert.equal((await say(s, key, V1, '   ')).status, 400);
    assert.equal((await say(s, key, V1, 'יש לכם ספל ירוק?')).status, 200);
    await drain(s.app, { kinds: ['web_inbound'] });
    let got = await lines(s, key, V1);
    assert.equal(got.ok, true);
    assert.deepEqual(got.lines.map((l: any) => l.who), ['me', 'store']);
    assert.equal(got.lines[0].text, 'יש לכם ספל ירוק?');
    assert.ok(got.lines[1].text.length > 0, 'the agent\'s answer');
    // Read on from the last id: nothing new.
    assert.deepEqual((await lines(s, key, V1, got.lines[1].id)).lines, []);
    // Another visitor, the same store: nothing of the first one's.
    assert.deepEqual((await lines(s, key, V2)).lines, []);

    const conv = (await s.app.db.one<{ id: number; account_id: number }>("SELECT id, account_id FROM conversations WHERE channel = 'web' AND peer = $1", [V1]))!;
    assert.ok(conv.account_id, 'one of the store\'s own channels');
    assert.equal((await counted(s.app.db, [id])).get(id)!.get(monthOf()), 1, 'counted in the plan');
    const inbox = await (await s.get('/chats')).text();
    assert.ok(inbox.includes(`/chat/${conv.id}`) && inbox.includes('צ׳אט באתר'), 'in the inbox, with its channel');

    // The owner answers from the inbox: the visitor reads it.
    const res = await s.post(`/chat/${conv.id}/reply`, { _csrf: await s.csrf(`/chat/${conv.id}`), text: 'כן, יש בשני גדלים.' });
    assert.equal(res.status, 303);
    got = await lines(s, key, V1);
    // The bot answered here before, so a person taking over says so first (agent/intro.ts), as on every channel.
    assert.equal(got.lines.at(-1).text, 'מכאן עונה לך בן אדם מהצוות של כלי חרס של נורית.\n\nכן, יש בשני גדלים.');
    assert.equal(got.lines.at(-1).who, 'store');
  } finally {
    await s.close();
  }
});

test('a visitor may say twelve things a minute', async () => {
  const { s, key } = await chatOn();
  try {
    const codes: number[] = [];
    for (let i = 0; i < 13; i++) codes.push((await say(s, key, V2, `שאלה ${i}`)).status);
    assert.deepEqual([codes.slice(0, 12).every((c) => c === 200), codes[12]], [true, 429]);
  } finally {
    await s.close();
  }
});

test('reviews: the rating in a reply, kept with the customer\'s words', () => {
  const cases: [string, ReturnType<typeof ratingOf>][] = [
    ['5', { rating: 5, text: '' }],
    ['5 כוכבים, הכל הגיע מהר', { rating: 5, text: 'הכל הגיע מהר' }],
    ['⭐⭐⭐⭐ יפה מאוד', { rating: 4, text: 'יפה מאוד' }],
    ['3 מתוך 5. בסדר', { rating: 3, text: 'בסדר' }],
    ['נותנת 4/5 כי האריזה נקרעה', { rating: 4, text: 'נותנת 4/5 כי האריזה נקרעה' }],
    ['מעולה', null],
    ['שילמתי 3 פעמים', null],
    ['הזמנה 1042 הגיעה', null],
  ];
  for (const [t, want] of cases) assert.deepEqual(ratingOf(t), want, t);
});

test('reviews: a rating answering the request is kept, the customer is asked once, and the site shows it only with both yeses', async () => {
  const { s, id, key } = await chatOn();
  try {
    // The visitor is in a conversation where the store's review request went out.
    await say(s, key, V1, 'היי');
    await drain(s.app, { kinds: ['web_inbound'] });
    const conv = (await s.app.db.one<{ id: number }>("SELECT id FROM conversations WHERE channel = 'web' AND peer = $1", [V1]))!.id;
    await s.app.db.query("INSERT INTO auto_events (store_id, key, kind, message, ref, contact, vars, source, happened_at, due_at, status, channel, conversation_id, sent_at) VALUES ($1, 'test:review:1', 'review', 'review', '#1042', '{\"name\": \"דנה כהן\"}'::jsonb, '{}'::jsonb, 'poll', now(), now(), 'sent', 'web', $2, now())", [id, conv]);

    await say(s, key, V1, '5 כוכבים, הכל הגיע מהר');
    await drain(s.app, { kinds: ['web_inbound'] });
    let got = await lines(s, key, V1);
    assert.match(got.lines.at(-1).text, /אפשר להציג אותה באתר של .+ עם השם הפרטי שלכם\?/);
    let row = await s.app.db.one<any>('SELECT rating, text, name, step, publish, status FROM reviews WHERE store_id = $1', [id]);
    assert.deepEqual({ ...row }, { rating: 5, text: 'הכל הגיע מהר', name: 'דנה', step: 'asked', publish: 'unknown', status: 'pending' });
    // Not shown before the customer's yes, and the owner cannot show it.
    const rid = (await s.app.db.one<{ id: number }>('SELECT id FROM reviews WHERE store_id = $1', [id]))!.id;
    assert.equal((await s.post(`/lead/${id}/reviews/${rid}`, { _csrf: await s.csrf('/settings'), do: 'approve' })).status, 303);
    assert.equal((await s.app.db.one<any>('SELECT status FROM reviews WHERE id = $1', [rid]))!.status, 'pending', 'refused');

    await say(s, key, V1, 'כן');
    await drain(s.app, { kinds: ['web_inbound'] });
    got = await lines(s, key, V1);
    assert.equal(got.lines.at(-1).text, 'תודה! הביקורת תופיע באתר אחרי שהחנות תעבור עליה.');
    row = await s.app.db.one<any>('SELECT step, publish FROM reviews WHERE id = $1', [rid]);
    assert.deepEqual({ ...row }, { step: 'done', publish: 'yes' });
    assert.doesNotMatch(await (await s.get(`/w/${key}/reviews`)).text(), /הכל הגיע מהר/, 'the owner has not approved it yet');
    const settings = await (await s.get('/settings')).text();
    assert.match(settings, /ביקורות שנאספו[^]*הכל הגיע מהר[^]*מחכה לאישור שלכם/);

    assert.equal((await s.post(`/lead/${id}/reviews/${rid}`, { _csrf: await s.csrf('/settings'), do: 'approve' })).status, 303);
    const block = await s.get(`/w/${key}/reviews`);
    const html = await block.text();
    assert.match(html, /הכל הגיע מהר/);
    assert.match(html, /<bdi>דנה<\/bdi>/);
    assert.match(String(block.headers.get('content-security-policy')), /frame-ancestors https:\/\/kli-cheres\.example/);
    // A second rating in the same conversation is the agent's: one review a request.
    await say(s, key, V1, '4');
    await drain(s.app, { kinds: ['web_inbound'] });
    assert.equal((await s.app.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM reviews WHERE store_id = $1', [id]))!.n, 1);
    // Hidden: off the site.
    await s.post(`/lead/${id}/reviews/${rid}`, { _csrf: await s.csrf('/settings'), do: 'hide' });
    assert.doesNotMatch(await (await s.get(`/w/${key}/reviews`)).text(), /הכל הגיע מהר/);
  } finally {
    await s.close();
  }
});

// The audit of 2026-11-12, P0-5: while Toran is not switched on, is paused, or is off on the chat, the chat on the
// store's site took the visitor's message and showed typing dots for 90 seconds, then nothing.
test('while Toran does not answer on the site chat, the visitor reads once that the store got the message, with no model call, and the owner is told', async () => {
  const { s, id, key } = await chatOn();
  try {
    await s.app.db.query("UPDATE channel_accounts SET meta = meta || '{\"first_seen_at\":\"2026-11-01T00:00:00Z\"}'::jsonb WHERE store_id = $1 AND channel = 'web'", [id]);
    let calls = 0;
    const inner = s.app.llm;
    s.app.llm = { backend: inner.backend, turn: (req) => (calls++, inner.turn(req)) };
    const states: [string, string, () => Promise<unknown>][] = [
      ['not switched on', 'CCCCCCCCCCCCCCCCCCCCCC', () => s.app.db.query('UPDATE stores SET agent_live_at = NULL, agent_paused_at = NULL WHERE id = $1', [id])],
      ['paused', 'DDDDDDDDDDDDDDDDDDDDDD', async () => (await setLive(s.app, id, true), setLive(s.app, id, false))],
      ['off on the chat', 'EEEEEEEEEEEEEEEEEEEEEE', async () => (await setLive(s.app, id, true), s.app.db.query("UPDATE stores SET agent_off = '{web}' WHERE id = $1", [id]))],
    ];
    for (const [why, v, set] of states) {
      await set();
      assert.equal((await say(s, key, v, 'היי, אתם פתוחים היום?')).status, 200);
      await drain(s.app, { kinds: ['web_inbound'] });
      assert.deepEqual((await lines(s, key, v)).lines.map((l: any) => [l.who, l.text]), [['me', 'היי, אתם פתוחים היום?'], ['store', HELD_WEB]], why);
      await say(s, key, v, 'יש מישהו?');
      await drain(s.app, { kinds: ['web_inbound'] });
      assert.deepEqual((await lines(s, key, v)).lines.map((l: any) => l.who), ['me', 'store', 'me'], `${why}: said once a conversation`);
      const conv = (await s.app.db.one<{ id: number }>("SELECT id FROM conversations WHERE channel = 'web' AND peer = $1", [v]))!.id;
      assert.ok(await s.app.db.one(`SELECT 1 FROM conversations c WHERE c.id = $1 AND ${WAITING_SQL}`, [conv]), `${why}: the conversation waits for the owner`);
      assert.ok(await s.app.db.one("SELECT 1 FROM jobs WHERE kind = 'owner_waiting'"), `${why}: the owner is told`);
    }
    assert.equal(calls, 0, 'no model call');
    // The owner's inbox row is what the customer wrote, not the line the chat said.
    const today = await (await s.get('/chats?state=waiting')).text();
    assert.match(today, /יש מישהו\?/);
    // Answering again: no such line.
    await s.app.db.query("UPDATE stores SET agent_off = '{}' WHERE id = $1", [id]);
    await say(s, key, 'FFFFFFFFFFFFFFFFFFFFFF', 'יש ספל ירוק?');
    await drain(s.app, { kinds: ['web_inbound'] });
    assert.ok(calls > 0);
    assert.ok(!(await lines(s, key, 'FFFFFFFFFFFFFFFFFFFFFF')).lines.some((l: any) => l.text === HELD_WEB));
  } finally {
    await s.close();
  }
});
