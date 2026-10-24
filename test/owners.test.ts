import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleInbound } from '../src/channels/route.ts';
import { createHandler } from '../src/web/server.ts';
import { drain } from '../src/jobs/worker.ts';
import { J } from '../src/db/index.ts';
import { handleTederEvent } from '../src/owners/events.ts';
import { DISCLOSURE, PUSHES_PER_DAY } from '../src/owners/notify.ts';
import { signature, signedHeaders, verify } from '../src/owners/teder.ts';
import { FOOTER, TEMPLATES, templatesDoc } from '../src/owners/templates.ts';
import { OWNER_PER_10_MIN } from '../src/owners/line.ts';
import type { Block, TurnReq } from '../src/agent/llm/types.ts';
import { scriptedClient, type Script } from '../src/agent/llm/scripted.ts';
import { fakeOwnerAccounts, fakeTeder, SECRET } from './owner-fakes.ts';
import { testApp } from './helpers.ts';

// The owner line (src/owners/, docs/owner-line.md): who a number is, Teder's news as messages, the owner's replies
// acted on, and WhatsApp's rules in code (the 24 hours, the templates, the opt-out, quiet time, the limits). Accounts
// and Teder are stand-ins that check the token and the signatures (owner-fakes.ts); the model is a script.

const LINE = '972500000888';
const OWNER = '972500000123';
const OTHER = '972500000124';
const WS = 7;
const SIDS = Object.keys(TEMPLATES).map((n, i) => `${n}=HX${String(i).repeat(32)}`).join(',');
let seq = 0;

const toolUse = (name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id: `t${seq++}`, name, input }];
const say = (text: string): Block[] => [{ type: 'text', text }];
const lastResult = (req: TurnReq) => {
  const last = req.messages[req.messages.length - 1];
  return Array.isArray(last.content) ? String((last.content.find((b: any) => b.type === 'tool_result') as any)?.content || '') : '';
};

async function setup(script?: Script) {
  const app = await testApp({ script });
  const accounts = await fakeOwnerAccounts();
  const teder = await fakeTeder();
  Object.assign(app.env, accounts.env, teder.env, { TORAN_ASSISTANT_WA: LINE, TWILIO_TEMPLATES: SIDS });
  const outbox = app.wa.outbox!;
  const write = (text: string, from = OWNER, id = `o${seq++}`) => handleInbound(app, { channel: 'whatsapp', from, text, id, at: Date.now(), to: LINE });
  const event = async (type: string, data: unknown, id = `evt_${seq++}`) => {
    await app.db.query('INSERT INTO teder_events (id, type, workspace_id, data) VALUES ($1, $2, $3, $4::jsonb)', [id, type, WS, J(data)]);
    return { id, result: await handleTederEvent(app, id) };
  };
  const toOwner = () => outbox.filter((m) => m.to === OWNER);
  const notes = () => app.db.query<any>('SELECT kind, status, mode, template, reason FROM owner_notifications ORDER BY id');
  const three = () => {
    teder.add({ id: 11, workspace: WS, hook: '5 טעויות בבחירת נעלי ריצה' });
    teder.add({ id: 12, workspace: WS, hook: 'איך לשמור על הגב בריצה' });
    teder.add({ id: 13, workspace: WS, hook: 'מה לאכול לפני מרתון' });
    return [11, 12, 13].map((id) => ({ id, hook: teder.posts.get(id)!.hook, cover: { url: `https://teder.test/m/${id}-1.jpg` } }));
  };
  return {
    app, accounts, teder, outbox, write, event, toOwner, notes, three,
    close: async () => {
      await accounts.close();
      await teder.close();
      await app.db.close();
    },
  };
}

test('the signature: one HMAC over the method, the path, the body and the time; stale or changed is refused', () => {
  const body = '{"a":1}';
  const want = `v1=${createHmac('sha256', SECRET).update(`v1\n1700000000\nPOST\n/internal/teder/events\n${createHash('sha256').update(body).digest('hex')}`).digest('hex')}`;
  assert.equal(signature(SECRET, 1700000000, 'POST', '/internal/teder/events', body), want, 'the string docs/owner-line.md gives');
  const h = signedHeaders(SECRET, 'POST', '/x', body, 1700000000);
  assert.equal(verify(SECRET, h, 'POST', '/x', body, 1700000100), null);
  assert.equal(verify(SECRET, h, 'POST', '/x', body, 1700000400), 'stale');
  assert.equal(verify(SECRET, h, 'POST', '/x', '{"a":2}', 1700000100), 'bad_signature');
  assert.equal(verify(SECRET, h, 'GET', '/x', body, 1700000100), 'bad_signature');
  assert.equal(verify(null, h, 'POST', '/x', body, 1700000100), 'not_configured');
});

test('identity: an unknown number is told it is not linked (once an hour); a link code links it; accounts down acts for nobody', async () => {
  const s = await setup();
  try {
    const r = await s.write('אשר את 1', OTHER);
    assert.equal(r.action, 'owner_line');
    assert.match(s.outbox.at(-1)!.text, /המספר הזה לא מחובר לחשבון ב-OpenFrequency/);
    assert.match(s.outbox.at(-1)!.text, /https:\/\/accounts\.test/);
    await s.write('שוב', OTHER);
    assert.equal(s.outbox.filter((m) => m.to === OTHER).length, 1, 'said once, not to every message');
    assert.equal(s.teder.calls.length, 0, 'nothing reached Teder for a number nobody vouched for');

    // The number proves itself by sending accounts' code from itself.
    s.accounts.code('LINK-ABCDEF', { workspace: WS, products: ['teder'], optIn: true });
    const linked = await s.write('היי, LINK-abcdef', OTHER);
    assert.equal(linked.action, 'owner_line');
    assert.deepEqual(s.accounts.calls.find((c) => c.path === '/internal/owner-phone/claim')!.body, { code: 'LINK-ABCDEF', phone: OTHER });
    const text = s.outbox.at(-1)!.text;
    assert.ok(text.startsWith(DISCLOSURE), 'the first message to the number says it is a digital assistant');
    assert.match(text, /המספר הזה מחובר עכשיו/);
    await s.write('LINK-ABCDEF', OTHER);
    assert.match(s.outbox.at(-1)!.text, /הקוד הזה כבר שימש/);

    // Accounts not answering: nobody is an owner, and the line says to try later.
    s.accounts.down = true;
    s.teder.add({ id: 11, workspace: WS, hook: 'x' });
    const down = await s.write('אשר את 1', OTHER);
    assert.equal(s.teder.calls.length, 0);
    assert.match(s.outbox.at(-1)!.text, /משהו אצלנו לא עובד כרגע/);
    assert.ok(down);

    // A closed workspace is not linked.
    s.accounts.down = false;
    s.accounts.link({ phone: OWNER, workspace: WS, disabled: true });
    await s.write('מה המצב?');
    assert.match(s.outbox.at(-1)!.text, /לא מחובר/);
  } finally {
    await s.close();
  }
});

test('a duplicate delivery of the same message is acted on once', async () => {
  const s = await setup();
  try {
    s.accounts.link({ phone: OWNER, workspace: WS });
    const posts = s.three();
    await s.event('post.ready', { posts });
    await s.write('אשר את 1', OWNER, 'SM-dup');
    const again = await s.write('אשר את 1', OWNER, 'SM-dup');
    assert.equal(again.action, 'duplicate');
    assert.equal(s.teder.calls.filter((c) => c.path.endsWith('/approve')).length, 1);
  } finally {
    await s.close();
  }
});

test('post.ready inside the 24 hours: the covers numbered, then "אשר את 1 ו-3, את 2 תעשה קצר יותר" acted on and said back', async () => {
  const s = await setup();
  try {
    s.accounts.link({ phone: OWNER, workspace: WS });
    await s.write('היי'); // the owner wrote: the window is open (the model is not needed for a greeting with no list)
    const before = s.toOwner().length;
    assert.ok(s.toOwner()[0].text.startsWith(DISCLOSURE), 'the first answer opens with the disclosure');
    const posts = s.three();
    const { result } = await s.event('post.ready', { posts });
    assert.equal(result.sent, 1);
    const sent = s.toOwner().slice(before);
    assert.equal(sent[0].text, '3 מצגות חדשות מוכנות לאישור:');
    assert.deepEqual(sent.slice(1, 4).map((m) => [m.mediaUrl, m.text]), posts.map((p, i) => [p.cover.url, `${i + 1}. ${p.hook}`]));
    assert.match(sent[4].text, /אשר את 1 ו-3/);
    assert.ok(!sent.some((m) => m.text.includes(DISCLOSURE)), 'disclosed once per number, not per message');
    assert.ok(sent.every((m) => m.from === LINE), 'from the owner line');
    assert.deepEqual((await s.notes()).map((n) => [n.kind, n.status, n.mode]), [['post.ready', 'sent', 'session']]);

    const r = await s.write('אשר את 1 ו-3, את 2 תעשה קצר יותר');
    assert.equal(r.action, 'assistant');
    assert.deepEqual(s.teder.calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body.reason ?? null, c.body.note ?? null, c.body.actor]), [
      ['/internal/assistant/posts/11/approve', null, null, `wa:${OWNER}`],
      ['/internal/assistant/posts/12/reject', 'shorter', 'תעשה קצר יותר', `wa:${OWNER}`],
      ['/internal/assistant/posts/13/approve', null, null, `wa:${OWNER}`],
    ]);
    const reply = s.outbox.at(-1)!.text;
    assert.match(reply, /^אישרתי את 1 ו-3\./);
    assert.match(reply, /את 2 החזרתי לכתיבה מחדש עם ההערה "תעשה קצר יותר"/);
    const audit = await s.app.db.query<any>("SELECT action, actor, detail FROM audit WHERE action LIKE 'teder_%' ORDER BY id");
    assert.deepEqual(audit.map((a) => [a.action, a.actor, a.detail.post]), [['teder_approve', `wa:${OWNER}`, 11], ['teder_reject', `wa:${OWNER}`, 12], ['teder_approve', `wa:${OWNER}`, 13]]);

    // A number past the list is answered in code, and nothing is done.
    await s.write('אשר את 4');
    assert.match(s.outbox.at(-1)!.text, /יש 3 מצגות, אז אין 4/);
    // Approving again: Teder says it is no longer waiting, and the owner hears that.
    await s.write('אשר את 1');
    assert.match(s.outbox.at(-1)!.text, /את 1 כבר אי אפשר לאשר/);
  } finally {
    await s.close();
  }
});

test('outside the 24 hours only the approved template goes out, and without its SID nothing does', async () => {
  const s = await setup();
  try {
    s.accounts.link({ phone: OWNER, workspace: WS });
    const posts = s.three();
    // Never wrote: no window.
    await s.event('post.ready', { posts });
    const t = s.toOwner();
    assert.equal(t.length, 1);
    assert.equal(t[0].template, 'teder_posts_ready');
    assert.deepEqual(t[0].vars, ['3 מצגות חדשות']);
    assert.equal(t[0].mediaUrl, undefined, 'no covers outside the window');
    const n = (await s.notes()).at(-1);
    assert.deepEqual([n.status, n.mode, n.template], ['sent', 'template', 'teder_posts_ready']);

    // The owner answers the template's button: the window opens, and the covers go as an answer.
    await s.write('הצג');
    const shown = s.toOwner().slice(1);
    assert.ok(!shown[0].text.startsWith(DISCLOSURE), "the template's footer was the disclosure");
    assert.match(shown[0].text, /3 מצגות מחכות לאישור:/);
    assert.equal(shown.filter((m) => m.mediaUrl).length, 3);

    // 25 hours later the window is shut again; a template with no SID set is not sent.
    await s.app.db.query("UPDATE owner_numbers SET last_inbound_at = now() - interval '25 hours'");
    s.app.env.TWILIO_TEMPLATES = '';
    const count = s.toOwner().length;
    await s.event('quota.low', { kind: 'suggested', used: 32, limit: 40, month: '2026-10' });
    assert.equal(s.toOwner().length, count);
    assert.deepEqual([(await s.notes()).at(-1).status, (await s.notes()).at(-1).reason], ['skipped', 'no_template']);

    // Every template is a utility one with the disclosure and the way out in its footer.
    assert.ok(FOOTER.length <= 60 && /הפסק/.test(FOOTER) && /דיגיטלי/.test(FOOTER));
    for (const tp of Object.values(TEMPLATES)) assert.doesNotMatch(tp.body, /^\{\{|\}\}[.\s]*$/, `${tp.name}: Meta refuses a variable at the start or the end`);
    assert.ok(readFileSync(path.join(import.meta.dirname, '..', 'docs', 'whatsapp-templates.md'), 'utf8').endsWith(templatesDoc()), 'docs/whatsapp-templates.md is the templates as sent (node scripts/templates-doc.ts)');
  } finally {
    await s.close();
  }
});

test('"הפסק" stops every Teder message (here and in accounts); "התחל" brings them back; no opt-in, no messages', async () => {
  const s = await setup();
  try {
    s.accounts.link({ phone: OWNER, workspace: WS, optIn: null });
    s.teder.add({ id: 11, workspace: WS, hook: 'a' });
    await s.event('post.ready', { posts: [{ id: 11, hook: 'a', cover: null }] });
    assert.equal(s.toOwner().length, 0);
    assert.equal((await s.notes()).at(-1).reason, 'no_opt_in');

    s.accounts.link({ phone: OWNER, workspace: WS });
    await s.write('הפסק');
    assert.match(s.outbox.at(-1)!.text, /הפסקתי\. לא אשלח לכם יותר הודעות מטדר/);
    assert.deepEqual(s.accounts.calls.filter((c) => c.path.endsWith('/consent')).map((c) => c.body), [{ phone: OWNER, optIn: false, source: 'whatsapp' }]);
    const sentBefore = s.toOwner().length;
    await s.event('weekly.summary', { from: '2026-10-18', to: '2026-10-24', made: 9, approved: 7, rejected: 2, published: 6, pending: 1 });
    await s.event('quota.low', { kind: 'redos', used: 8, limit: 10, month: '2026-10' });
    assert.equal(s.toOwner().length, sentBefore, 'nothing after "הפסק"');
    assert.deepEqual((await s.notes()).slice(-2).map((n) => n.reason), ['opted_out', 'opted_out']);

    // Kept here too: accounts forgetting the stop (an older opt-in) still sends nothing.
    s.accounts.owners.get(OWNER)!.optOut = null;
    await s.event('quota.low', { kind: 'redos', used: 9, limit: 10, month: '2026-10' });
    assert.equal(s.toOwner().length, sentBefore);

    await s.write('התחל');
    assert.match(s.outbox.at(-1)!.text, /מעכשיו ההודעות מטדר יגיעו לכאן/);
    const { result } = await s.event('weekly.summary', { from: '2026-10-18', to: '2026-10-24', made: 9, approved: 7, rejected: 2, published: 6, pending: 1 });
    assert.equal(result.sent, 1);
    assert.equal(s.outbox.at(-1)!.text, 'הסיכום השבועי מטדר, 18.10 עד 24.10:\nנוצרו 9 פוסטים. אישרתם 7 ודחיתם 2.\nעלו 6. מצגת אחת מחכה לאישור.');
  } finally {
    await s.close();
  }
});

test("Teder's quiet time puts the event off to its end, and it goes out once", async () => {
  const s = await setup();
  try {
    s.accounts.link({ phone: OWNER, workspace: WS });
    await s.write('היי');
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
    s.teder.quiet = { now: true, until, reason: 'shabbat' };
    const posts = s.three();
    const before = s.toOwner().length;
    const { id, result } = await s.event('post.ready', { posts });
    assert.equal(result.deferred, until);
    assert.equal(s.toOwner().length, before, 'nothing during Shabbat');
    assert.deepEqual([(await s.notes()).at(-1).status, (await s.notes()).at(-1).reason], ['deferred', 'shabbat']);
    const job = await s.app.db.one<any>("SELECT run_at, payload FROM jobs WHERE kind = 'teder_event' ORDER BY id DESC LIMIT 1");
    assert.equal(job.payload.id, id);
    assert.ok(new Date(job.run_at).getTime() > new Date(until).getTime(), 'queued again for after the quiet time');

    s.teder.quiet = { now: false, until: null, reason: null };
    await handleTederEvent(s.app, id);
    await handleTederEvent(s.app, id);
    assert.equal(s.toOwner().length - before, 5, 'sent once: the head, three covers, the hint');
  } finally {
    await s.close();
  }
});

test('the limits: messages started to one number a day, and messages from one number in ten minutes', async () => {
  const s = await setup((_req, call) => say(`תשובה ${call}`));
  try {
    s.accounts.link({ phone: OWNER, workspace: WS });
    for (let i = 0; i < PUSHES_PER_DAY + 1; i++) await s.event('quota.low', { kind: 'redos', used: 8, limit: 10, month: '2026-10' });
    const n = await s.notes();
    assert.equal(n.filter((x) => x.status === 'sent').length, PUSHES_PER_DAY);
    assert.equal(n.at(-1).reason, 'rate_limited');

    for (let i = 0; i < OWNER_PER_10_MIN + 3; i++) await s.write(`שאלה ${i}`);
    const limitLines = s.toOwner().filter((m) => /קיבלתי הרבה הודעות ברצף/.test(m.text));
    assert.equal(limitLines.length, 1, 'said once, then silence');
  } finally {
    await s.close();
  }
});

test('post.unposted inside the window: every image in order and the caption alone to copy; post.reminder asks first', async () => {
  const s = await setup();
  try {
    s.accounts.link({ phone: OWNER, workspace: WS });
    await s.write('היי');
    s.teder.add({ id: 21, workspace: WS, hook: 'מה לאכול לפני מרתון', status: 'approved', slides: [['a'], ['b'], ['c']], caption: 'הכיתוב להעתקה #ריצה' });
    const before = s.toOwner().length;
    await s.event('post.unposted', { post: { id: 21, hook: 'מה לאכול לפני מרתון' }, platform: 'instagram' });
    const sent = s.toOwner().slice(before);
    assert.equal(sent[0].text, '"מה לאכול לפני מרתון" עוד לא עלה לאינסטגרם. הנה הכול, מוכן להעלאה.');
    assert.deepEqual(sent.slice(1, 4).map((m) => m.mediaUrl), ['https://teder.test/m/21-1.jpg', 'https://teder.test/m/21-2.jpg', 'https://teder.test/m/21-3.jpg']);
    assert.equal(sent.at(-1)!.text, 'הכיתוב להעתקה #ריצה', 'the caption as Teder wrote it, nothing added');

    await s.event('post.reminder', { post: { id: 21, hook: 'מה לאכול לפני מרתון' }, platform: 'tiktok' });
    assert.equal(s.outbox.at(-1)!.text, 'הגיע הזמן להעלות את "מה לאכול לפני מרתון" לטיקטוק. כתבו "שלח" ואשלח לכאן את התמונות ואת הכיתוב.');
    const n = s.toOwner().length;
    await s.write('שלח');
    assert.equal(s.toOwner().filter((m) => m.mediaUrl).length, 6, 'the reminded post, from its one-item list');
    assert.equal(s.toOwner().at(-1)!.text, 'הכיתוב להעתקה #ריצה');
    assert.ok(s.toOwner().length > n);
  } finally {
    await s.close();
  }
});

test("the model's actions on posts: only numbers the owner's message names, and an edit only in the owner's words", async () => {
  const seen: string[] = [];
  const script: Script = (req, call) => {
    if (lastResult(req)) seen.push(lastResult(req));
    if (call === 0) return toolUse('teder_approve', { numbers: [1, 2] });
    if (call === 1) return toolUse('teder_approve', { numbers: [1] });
    if (call === 2) return say('אישרתי את הראשונה.');
    if (call === 3) return toolUse('teder_edit', { number: 2, slide: 1, line: 1, text: 'כותרת שהמודל המציא' });
    if (call === 4) return toolUse('teder_edit', { number: 2, slide: 1, line: 1, text: 'גב חזק בריצה' });
    return say('שיניתי.');
  };
  const s = await setup(script);
  try {
    s.accounts.link({ phone: OWNER, workspace: WS, products: ['teder'] });
    await s.event('post.ready', { posts: s.three() });
    await s.write('את הראשונה תאשר, היא מעולה. למה היא לא עלתה אתמול?');
    assert.match(seen[0], /does not name post 2/);
    assert.deepEqual(s.teder.calls.filter((c) => c.method === 'POST').map((c) => c.path), ['/internal/assistant/posts/11/approve'], 'only 1, after the refusal');

    await s.write('בשנייה, תשנה את הכותרת של הפתיחה ל"גב חזק בריצה", בסדר?');
    assert.match(seen[2], /owner's exact words/);
    const edit = s.teder.calls.find((c) => c.path.endsWith('/edit'))!;
    assert.deepEqual([edit.body.slide, edit.body.line, edit.body.text], [1, 1, 'גב חזק בריצה']);
    assert.ok(s.toOwner().some((m) => m.mediaUrl === 'https://teder.test/m/12-1-v2.jpg'), 'the slide as Teder drew it again');
    // A Teder-only owner's chat is kept by number, with no store.
    const kept = await s.app.db.query<any>('SELECT store_id, workspace_id, phone FROM assistant_messages');
    assert.ok(kept.length && kept.every((k) => k.store_id === null && k.workspace_id === WS && k.phone === OWNER));
  } finally {
    await s.close();
  }
});

test("Teder's events come in signed, from this machine only, once each", async () => {
  const s = await setup();
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  server.on('request', createHandler(s.app, { port }));
  const path = '/internal/teder/events';
  const post = (raw: string, headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });
  try {
    s.accounts.link({ phone: OWNER, workspace: WS });
    const ev = JSON.stringify({ id: 'evt_signed_1', type: 'quota.low', workspace: WS, at: '2026-10-24T09:00:00.000Z', data: { kind: 'suggested', used: 32, limit: 40, month: '2026-10' } });
    assert.equal((await post(ev, signedHeaders('wrong-secret-000000000000000000000000', 'POST', path, ev))).status, 401);
    assert.equal((await post(ev, signedHeaders(SECRET, 'POST', path, ev, Math.floor(Date.now() / 1000) - 600))).status, 401, 'stale');
    assert.equal((await post(ev, { ...signedHeaders(SECRET, 'POST', path, ev), 'x-forwarded-for': '1.2.3.4' })).status, 403, 'never through Caddy');
    const ok = await post(ev, signedHeaders(SECRET, 'POST', path, ev));
    assert.equal(ok.status, 200);
    assert.equal((await post(ev, signedHeaders(SECRET, 'POST', path, ev))).status, 200, 'again: acknowledged');
    assert.equal((await s.app.db.one<any>("SELECT COUNT(*)::int AS n FROM jobs WHERE kind = 'teder_event'")).n, 1, 'and kept once');
    const bad = JSON.stringify({ id: 'evt_x', type: 'post.deleted', workspace: WS, data: {} });
    assert.equal((await post(bad, signedHeaders(SECRET, 'POST', path, bad))).status, 400);
    await drain(s.app);
    assert.equal(s.toOwner().at(-1)!.template, 'teder_quota_low');
    assert.deepEqual(s.toOwner().at(-1)!.vars, ['8 מתוך 40 הצעות לפוסטים']);
    assert.ok(s.teder.refused.length === 0, 'Toran signed every request it made to Teder');
  } finally {
    server.close();
    await s.close();
  }
});

test('an owner of both: Toran\'s "כן" still answers its own offer, and Teder\'s list is read when it is the newer thing', async () => {
  const s = await setup((_req, call) => (call === 0 ? toolUse('store_overview', { days: 1 }) : say('היום לא היו שיחות.')));
  try {
    const store = (await s.app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, workspace_id) VALUES ('both.example', 'https://both.example/', 'שניהם', 'shopify', 'seed', 'both-x1', $1) RETURNING id", [WS]))!.id;
    s.accounts.link({ phone: OWNER, workspace: WS, products: ['teder', 'toran'] });
    const r = await s.write('מה קרה היום בחנות?');
    assert.equal(r.action, 'assistant');
    assert.match(s.outbox.at(-1)!.text, /היום לא היו שיחות\./);
    assert.equal((await s.app.db.one<any>("SELECT store_id FROM assistant_messages WHERE role = 'owner' ORDER BY id DESC LIMIT 1")).store_id, store);

    await s.event('post.ready', { posts: s.three() });
    await s.write('מאשר את כולן');
    assert.equal(s.teder.calls.filter((c) => c.path.endsWith('/approve')).length, 3);

    // An offer of Toran's, newer than the list: "כן" is Toran's, not Teder's.
    await s.app.db.query("INSERT INTO assistant_actions (store_id, kind, params, summary) VALUES ($1, 'resume', '{\"conversation_id\": 0}', 'להחזיר את תורן')", [store]);
    await s.write('כן');
    assert.equal((await s.app.db.one<any>('SELECT status FROM assistant_actions')).status, 'done');
    assert.equal(s.teder.calls.filter((c) => c.method === 'POST').length, 3, 'nothing more at Teder');
  } finally {
    await s.close();
  }
});

test('the owner of a Toran store reaches the assistant from the demo number too, once accounts verified the number', async () => {
  const s = await setup((_req, call) => (call === 0 ? toolUse('store_overview', { days: 1 }) : say('היום לא היו שיחות.')));
  try {
    await s.app.db.query("INSERT INTO stores (domain, url, name, platform, source, slug, workspace_id, owner_phones) VALUES ('t.example', 'https://t.example/', 'ט', 'shopify', 'seed', 't-x1', $1, '{972500000124}')", [WS]);
    s.accounts.link({ phone: OWNER, workspace: WS, products: ['toran'] });
    const r = await handleInbound(s.app, { channel: 'whatsapp', from: OWNER, text: 'מה קרה היום?', id: `d${seq++}`, at: Date.now(), to: '972500000999' });
    assert.equal(r.action, 'assistant');
    assert.match(String(r.reply), /היום לא היו שיחות/);
    // A number typed on the dashboard long ago (stores.owner_phones) is not verified: it is a customer on the demo number.
    const typed = await handleInbound(s.app, { channel: 'whatsapp', from: OTHER, text: 'מה קרה היום?', id: `d${seq++}`, at: Date.now(), to: '972500000999' });
    assert.equal(typed.action, 'no_binding');
  } finally {
    await s.close();
  }
});
