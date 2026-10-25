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
import { handleTederEvent, handleTederReady } from '../src/owners/events.ts';
import { DISCLOSURE, PUSHES_PER_DAY } from '../src/owners/notify.ts';
import { DIR, signature, signedHeaders, verify } from '../src/owners/teder.ts';
import { FOOTER, TEMPLATES, templatesDoc } from '../src/owners/templates.ts';
import { OWNER_PER_10_MIN } from '../src/owners/line.ts';
import type { Block, TurnReq } from '../src/agent/llm/types.ts';
import { scriptedClient, type Script } from '../src/agent/llm/scripted.ts';
import { fakeOwnerAccounts, fakeTeder, SECRET } from './owner-fakes.ts';
import { syncCompany } from '../src/company.ts';
import { accountFor } from '../src/channels/store.ts';
import { ownerReply } from '../src/channels/owner.ts';
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
    return [11, 12, 13].map((id) => ({ id: String(id), coverLine: teder.posts.get(id)!.hook, image: `https://teder.test/m/${id}/instagram/1?e=1&s=x` }));
  };
  // Teder sends one post.ready per post; Toran gathers them and sends the whole list once (handleTederReady).
  const postReady = async (posts: { id: string; coverLine: string }[]) => {
    for (const p of posts) await event('post.ready', { post: p, redoOf: null });
    return handleTederReady(app, WS);
  };
  return {
    app, accounts, teder, outbox, write, event, postReady, toOwner, notes, three,
    close: async () => {
      await accounts.close();
      await teder.close();
      await app.db.close();
    },
  };
}

test("the signature is Teder's: six lines (direction, time, nonce, method, path, body hash) under one HMAC; stale, changed, turned around or replayed is refused", () => {
  const body = '{"a":1}';
  const nonce = 'abcdefghijklmnop';
  const want = `t=1700000000,n=${nonce},s=${createHmac('sha256', SECRET).update(['toran->teder', 1700000000, nonce, 'POST', '/internal/assistant/customers/7/posts/p1/approve', createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex')}`;
  assert.equal(signature(SECRET, { dir: DIR.out, method: 'POST', path: '/internal/assistant/customers/7/posts/p1/approve', body, t: 1700000000, nonce }), want, "the string Teder's docs/assistant-api.md gives");
  const h = { 'x-of-signature': signature(SECRET, { dir: DIR.in, method: 'POST', path: '/x', body, t: 1700000000 }) };
  assert.equal(verify(SECRET, h, 'POST', '/x', body, 1700000400), 'stale');
  assert.equal(verify(SECRET, h, 'POST', '/x', '{"a":2}', 1700000100), 'bad_signature');
  assert.equal(verify(SECRET, h, 'GET', '/x', body, 1700000100), 'bad_signature');
  assert.equal(verify(SECRET, signedHeaders(SECRET, 'POST', '/x', body, 1700000000), 'POST', '/x', body, 1700000100), 'bad_signature', 'a request signed toran->teder is not an event');
  assert.equal(verify(null, h, 'POST', '/x', body, 1700000100), 'not_configured');
  assert.equal(verify(SECRET, h, 'POST', '/x', body, 1700000100), null);
  assert.equal(verify(SECRET, h, 'POST', '/x', body, 1700000100), 'replay', 'the same nonce twice');
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

test('with TORAN_SUPPORT_STORE, a number nobody linked gets our support agent on the owner line, and a reply from the inbox goes out from the line; owners still reach their assistant', async () => {
  const script: Script = (req) => (lastResult(req) ? say('תורן עולה 250 ₪ לחודש, לא כולל מע״מ.') : toolUse('get_plans', {}));
  const s = await setup(script);
  try {
    const { storeId } = await syncCompany(s.app, {
      domain: 'shirut-li.example', url: 'https://shirut-li.example/', name: 'שירות לי', status: 'מה עובד היום:\n- עונה במייל.', tone: '', contact: {},
      plans: [{ key: 'one', product: 'shirut', title: 'שירות', monthly: 250, text: '250 ₪ לחודש, לא כולל מע״מ.', url: 'https://shirut-li.example/#price' }],
      faq: [], pages: [{ kind: 'about', title: 'מי אנחנו', url: 'https://shirut-li.example/', text: 'עסק קטן מחיפה.' }],
    });
    s.app.env.TORAN_SUPPORT_STORE = 'shirut-li.example';
    const r = await s.write('כמה זה עולה?', OTHER);
    assert.equal(r.storeId, storeId);
    const out = s.outbox.filter((m) => m.to === OTHER);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'תורן עולה 250 ₪ לחודש, לא כולל מע״מ.');
    assert.equal(out[0].from, LINE, 'the answer goes out from the owner line');
    const conv = await s.app.db.one<any>('SELECT c.id, a.status, a.external_id FROM conversations c JOIN channel_accounts a ON a.id = c.account_id WHERE c.store_id = $1 AND c.peer = $2', [storeId, OTHER]);
    assert.deepEqual([conv.status, conv.external_id], ['line', LINE]);
    assert.equal(await accountFor(s.app, 'whatsapp', LINE), null, 'the line is never a store\'s own account, so owners are not answered as support');

    const d = await ownerReply(s.app, conv.id, 'אני כאן, מה הכתובת של החנות?', 'operator');
    assert.ok(d.ok);
    assert.equal(s.outbox.at(-1)!.from, LINE, 'a reply from the inbox goes out from the owner line, not the demo number');

    // An owner of a workspace still reaches the assistant, not support.
    s.accounts.link({ phone: OWNER, workspace: WS });
    s.teder.add({ id: 11, workspace: WS, hook: 'מה לאכול לפני מרתון' });
    const owner = await s.write('הצג');
    assert.equal(owner.action, 'assistant', 'the owner reached their assistant');
    assert.ok(!(await s.app.db.one('SELECT 1 FROM conversations WHERE store_id = $1 AND peer = $2', [storeId, OWNER])), 'nothing of the owner\'s went to the support store');

    // Without the setting, the line says "not linked" as before.
    delete s.app.env.TORAN_SUPPORT_STORE;
    await s.write('שוב אני', '972500000125');
    assert.match(s.outbox.at(-1)!.text, /לא מחובר לחשבון/);
  } finally {
    await s.close();
  }
});

test('a duplicate delivery of the same message is acted on once', async () => {
  const s = await setup();
  try {
    s.accounts.link({ phone: OWNER, workspace: WS });
    await s.postReady(s.three());
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
    const result = await s.postReady(posts);
    assert.equal(result.sent, 1, 'three post.ready events, one message');
    const sent = s.toOwner().slice(before);
    assert.equal(sent[0].text, '3 מצגות מוכנות לאישור:');
    assert.deepEqual(sent.slice(1, 4).map((m) => [m.mediaUrl, m.text]), posts.map((p, i) => [p.image, `${i + 1}. ${p.coverLine}`]));
    assert.match(sent[4].text, /אשר את 1 ו-3/);
    assert.ok(!sent.some((m) => m.text.includes(DISCLOSURE)), 'disclosed once per number, not per message');
    assert.ok(sent.every((m) => m.from === LINE), 'from the owner line');
    assert.deepEqual((await s.notes()).map((n) => [n.kind, n.status, n.mode]), [['post.ready', 'sent', 'session']]);

    const r = await s.write('אשר את 1 ו-3, את 2 תעשה קצר יותר');
    assert.equal(r.action, 'assistant');
    const by = { name: 'דנה', userId: 100 + WS };
    assert.deepEqual(s.teder.calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body.reason ?? null, c.body.freeText ?? null, c.body.by]), [
      [`/internal/assistant/customers/${WS}/posts/11/approve`, null, null, by],
      [`/internal/assistant/customers/${WS}/posts/12/reject`, 'shorter', 'תעשה קצר יותר', by],
      [`/internal/assistant/customers/${WS}/posts/13/approve`, null, null, by],
    ], 'Teder records the person who asked, from accounts');
    const reply = s.outbox.at(-1)!.text;
    assert.match(reply, /^אישרתי את 1 ו-3\./);
    assert.match(reply, /את 2 החזרתי לכתיבה מחדש עם ההערה "תעשה קצר יותר"/);
    const audit = await s.app.db.query<any>("SELECT action, actor, detail FROM audit WHERE action LIKE 'teder_%' ORDER BY id");
    assert.deepEqual(audit.map((a) => [a.action, a.actor, a.detail.post]), [['teder_approve', `wa:${OWNER}`, '11'], ['teder_reject', `wa:${OWNER}`, '12'], ['teder_approve', `wa:${OWNER}`, '13']]);

    // A number past the list is answered in code, and nothing is done.
    await s.write('אשר את 4');
    assert.match(s.outbox.at(-1)!.text, /יש 3 מצגות, אז אין 4/);
    // Approving again: Teder says it is no longer waiting, and the owner hears that.
    await s.write('אשר את 1');
    assert.match(s.outbox.at(-1)!.text, /את 1 כבר אי אפשר לאשר/);
    // Rejected with no replacement (no redos left): the owner hears there is no new version coming.
    s.teder.redos = 0;
    s.teder.add({ id: 14, workspace: WS, hook: 'עוד אחת' });
    await s.postReady([{ id: '14', coverLine: 'עוד אחת' }]);
    await s.write('דחה');
    assert.match(s.outbox.at(-1)!.text, /^את 1 דחיתי\. הכתיבות מחדש של החודש נגמרו/);
  } finally {
    await s.close();
  }
});

test('outside the 24 hours only the approved template goes out, and without its SID nothing does', async () => {
  const s = await setup();
  try {
    s.accounts.link({ phone: OWNER, workspace: WS });
    // Never wrote: no window.
    await s.postReady(s.three());
    const t = s.toOwner();
    assert.equal(t.length, 1);
    assert.equal(t[0].template, 'teder_posts_ready');
    assert.deepEqual(t[0].vars, ['3 מצגות']);
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
    await s.event('quota.low', { account: { id: 'acc', name: 'חשבון' }, quota: { month: '2026-10', suggestions: { used: 32, held: 0, limit: 40, left: 8 }, redos: { used: 3, held: 0, limit: 10, left: 7 } } });
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
    await s.postReady([{ id: '11', coverLine: 'a' }]);
    assert.equal(s.toOwner().length, 0);
    assert.equal((await s.notes()).at(-1).reason, 'no_opt_in');

    s.accounts.link({ phone: OWNER, workspace: WS });
    await s.write('הפסק');
    assert.match(s.outbox.at(-1)!.text, /הפסקתי\. לא אשלח לכם יותר הודעות מתדר/);
    assert.deepEqual(s.accounts.calls.filter((c) => c.path.endsWith('/consent')).map((c) => c.body), [{ phone: OWNER, optIn: false, source: 'whatsapp' }]);
    const sentBefore = s.toOwner().length;
    await s.event('weekly.summary', { from: '2026-10-18T06:00:00.000Z', to: '2026-10-25T06:00:00.000Z', accounts: [{ account: { id: 'acc', name: 'חשבון' }, week: { published: 6, views: 1500, best: { id: 'p1', coverLine: 'הכי טוב', views: 900 } }, quota: { suggestions: { left: 28, limit: 40 } } }] });
    await s.event('quota.low', { account: { id: 'acc', name: 'חשבון' }, quota: { month: '2026-10', suggestions: { used: 32, held: 0, limit: 40, left: 8 }, redos: { used: 3, held: 0, limit: 10, left: 7 } } });
    assert.equal(s.toOwner().length, sentBefore, 'nothing after "הפסק"');
    assert.deepEqual((await s.notes()).slice(-2).map((n) => n.reason), ['opted_out', 'opted_out']);

    // Kept here too: accounts forgetting the stop (an older opt-in) still sends nothing.
    s.accounts.owners.get(OWNER)!.optOut = null;
    await s.event('quota.low', { account: { id: 'acc', name: 'חשבון' }, quota: { month: '2026-10', suggestions: { used: 32, held: 0, limit: 40, left: 8 }, redos: { used: 3, held: 0, limit: 10, left: 7 } } });
    assert.equal(s.toOwner().length, sentBefore);

    await s.write('התחל');
    assert.match(s.outbox.at(-1)!.text, /מעכשיו ההודעות מתדר יגיעו לכאן/);
    const { result } = await s.event('weekly.summary', { from: '2026-10-18T06:00:00.000Z', to: '2026-10-25T06:00:00.000Z', accounts: [{ account: { id: 'acc', name: 'חשבון' }, week: { published: 6, views: 1500, best: { id: 'p1', coverLine: 'הכי טוב', views: 900 } }, quota: { suggestions: { left: 28, limit: 40 } } }] });
    assert.equal(result.sent, 1);
    assert.equal(s.outbox.at(-1)!.text, 'הסיכום השבועי מתדר, 18.10 עד 25.10:\nעלו 6 פוסטים, עם 1,500 צפיות. הכי נצפה: "הכי טוב". נשארו 28 מתוך 40 הצעות למצגות.');
  } finally {
    await s.close();
  }
});

test("Teder's post.ready events are gathered into one numbered list, sent once (Teder itself holds them through quiet hours and Shabbat)", async () => {
  const s = await setup();
  try {
    s.accounts.link({ phone: OWNER, workspace: WS });
    await s.write('היי');
    const before = s.toOwner().length;
    for (const p of s.three()) assert.deepEqual((await s.event('post.ready', { post: p, redoOf: null })).result, { gathered: true });
    assert.equal(s.toOwner().length, before, 'nothing yet: the next ones may be coming');
    const jobs = await s.app.db.query<any>("SELECT payload, run_at FROM jobs WHERE kind = 'teder_ready'");
    assert.equal(jobs.length, 1, 'one gathering per workspace');
    assert.ok(new Date(jobs[0].run_at).getTime() > Date.now() + 60_000, 'a moment later');
    await handleTederReady(s.app, WS);
    await handleTederReady(s.app, WS);
    assert.equal(s.toOwner().length - before, 5, 'sent once: the head, three covers, the hint');
  } finally {
    await s.close();
  }
});

test('the limits: messages started to one number a day, and messages from one number in ten minutes', async () => {
  const s = await setup((_req, call) => say(`תשובה ${call}`));
  try {
    s.accounts.link({ phone: OWNER, workspace: WS });
    for (let i = 0; i < PUSHES_PER_DAY + 1; i++) await s.event('quota.low', { account: { id: 'acc', name: 'חשבון' }, quota: { month: '2026-10', suggestions: { used: 32, held: 0, limit: 40, left: 8 }, redos: { used: 3, held: 0, limit: 10, left: 7 } } });
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
    s.teder.add({ id: 21, workspace: WS, hook: 'מה לאכול לפני מרתון', status: 'approved', slides: [['a', ''], ['b', ''], ['c', '']], caption: 'הכיתוב להעתקה #ריצה' });
    const before = s.toOwner().length;
    await s.event('post.unposted', { post: { id: '21', coverLine: 'מה לאכול לפני מרתון' }, delivery: 'by_hand', platforms: { instagram: 'by_hand' }, minutesLate: 61 });
    const sent = s.toOwner().slice(before);
    assert.equal(sent[0].text, '"מה לאכול לפני מרתון" עוד לא עלה לאינסטגרם. הנה הכול, מוכן להעלאה.');
    assert.deepEqual(sent.slice(1, 4).map((m) => m.mediaUrl), [1, 2, 3].map((n) => `https://teder.test/m/21/instagram/${n}?e=1&s=x`));
    assert.equal(sent.at(-1)!.text, 'הכיתוב להעתקה #ריצה', 'the caption as Teder wrote it, nothing added');

    await s.event('post.reminder', { post: { id: '21', coverLine: 'מה לאכול לפני מרתון' }, delivery: 'by_hand', platforms: { tiktok: 'by_hand' }, sound: null });
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
    await s.postReady(s.three());
    await s.write('את הראשונה תאשר, היא מעולה. למה היא לא עלתה אתמול?');
    assert.match(seen[0], /does not name post 2/);
    assert.deepEqual(s.teder.calls.filter((c) => c.method === 'POST').map((c) => c.path), [`/internal/assistant/customers/${WS}/posts/11/approve`], 'only 1, after the refusal');

    await s.write('בשנייה, תשנה את הכותרת של הפתיחה ל"גב חזק בריצה", בסדר?');
    assert.match(seen[2], /owner's exact words/);
    const edit = s.teder.calls.find((c) => c.path.endsWith('/edit'))!;
    assert.deepEqual([edit.body.slide, edit.body.field, edit.body.newText], [1, 'hook', 'גב חזק בריצה'], "the cover's first line is its hook");
    assert.ok(s.toOwner().some((m) => m.mediaUrl === 'https://teder.test/m/12/instagram/1-v2?e=1&s=x'), 'the slide as Teder drew it again');
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
    // As Teder sends it: its body, X-OF-Event, and the signature in the direction teder->toran.
    const signed = (raw: string, secret = SECRET, t?: number) => ({ 'x-of-event': 'quota.low', 'x-of-signature': signature(secret, { dir: DIR.in, method: 'POST', path, body: raw, ...(t ? { t } : {}) }) });
    const ev = JSON.stringify({ id: 'evt_signed_1', type: 'quota.low', at: '2026-10-24T09:00:00.000Z', sentAt: '2026-10-24T09:00:01.000Z', customer: WS, data: { account: { id: 'acc', name: 'חשבון' }, quota: { month: '2026-10', suggestions: { used: 32, held: 0, limit: 40, left: 8 }, redos: { used: 3, held: 0, limit: 10, left: 7 } } } });
    assert.equal((await post(ev, signed(ev, 'wrong-secret-000000000000000000000000'))).status, 401);
    assert.equal((await post(ev, signed(ev, SECRET, Math.floor(Date.now() / 1000) - 600))).status, 401, 'stale');
    assert.equal((await post(ev, signedHeaders(SECRET, 'POST', path, ev))).status, 401, 'a request signed toran->teder is not an event');
    assert.equal((await post(ev, { ...signed(ev), 'x-forwarded-for': '1.2.3.4' })).status, 403, 'never through Caddy');
    const ok = await post(ev, signed(ev));
    assert.equal(ok.status, 200);
    assert.equal((await post(ev, signed(ev))).status, 200, 'again (a retry, a new nonce): acknowledged');
    assert.equal((await s.app.db.one<any>("SELECT COUNT(*)::int AS n FROM jobs WHERE kind = 'teder_event'")).n, 1, 'and kept once');
    const bad = JSON.stringify({ id: 'evt_x', type: 'post.deleted', customer: WS, data: {} });
    assert.equal((await post(bad, signed(bad))).status, 400);
    await drain(s.app);
    assert.equal(s.toOwner().at(-1)!.template, 'teder_quota_low');
    assert.deepEqual(s.toOwner().at(-1)!.vars, ['8 מתוך 40 הצעות למצגות']);
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

    await s.postReady(s.three());
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
