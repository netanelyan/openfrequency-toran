import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleInbound } from '../src/channels/route.ts';
import { turnOn } from '../src/channels/web.ts';
import { handOver } from '../src/channels/store.ts';
import { ARCHIVE_DAYS, STATE_SQL } from '../src/web/inbox.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// The inbox's archive (the owner, 2026-11-12: "Add an options to archive chats, and archive them automatically 5 days
// after inactivity"; web/inbox.ts ARCHIVED_SQL): by hand from the conversation's head, by itself after five silent days
// for one that waits for no one, and back by itself when the customer writes again.

async function inbox() {
  const s = await serve();
  const id = s.seeded.storeId;
  await s.app.db.query('UPDATE stores SET workspace_id = 7 WHERE id = $1', [id]);
  const acc = (await turnOn(s.app, id, 'test'))!;
  await s.app.db.query(`UPDATE channel_accounts SET meta = meta || '{"first_seen_at":"2026-11-01T00:00:00Z"}'::jsonb WHERE id = $1`, [acc.id]);
  s.as(s.accounts.session(customer(7)).cookie);
  // The seed's own conversations are not this test's.
  const seeded = new Set((await s.app.db.query<{ id: number }>('SELECT id FROM conversations')).map((c) => c.id));
  let n = 0;
  const say = async (v: string, text: string) => handleInbound(s.app, { channel: 'web', from: v, text, id: `web:${acc.external_id}:${v}:${n++}`, account: acc.external_id } as any);
  const conv = async (v: string) => (await s.app.db.one<{ id: number }>("SELECT id FROM conversations WHERE channel = 'web' AND peer = $1", [v]))!.id;
  const page = async (path: string) => (await s.get(path)).text();
  // The conversations a list shows, by their links (the archive's carry ?box=archive).
  const listed = async (path: string) => [...(/<div class="ib-list">([^]*?)<\/div>\s*<\/aside>/.exec(await page(path))?.[1] || '').matchAll(/href="\/chat\/(\d+)[?"]/g)].map((m) => Number(m[1])).filter((c) => !seeded.has(c));
  const archive = async (conversation: number, on = true) => (await (await s.post(`/chat/${conversation}/archive`, { _csrf: await s.csrf(`/chat/${conversation}`), on: on ? '1' : '0' }, { 'x-tn-ajax': '1' })).json()).message as string;
  const state = async (conversation: number) => (await s.app.db.one<{ st: string }>(`SELECT ${STATE_SQL} AS st FROM conversations c WHERE c.id = $1`, [conversation]))!.st;
  const waiting = async () => (await (await s.get('/waiting.json')).json()).chats as number;
  const silentFor = (conversation: number, days: number) => s.app.db.query(`UPDATE conversations SET last_at = now() - interval '${days} days' WHERE id = $1`, [conversation]);
  return { s, id, say, conv, page, listed, archive, state, waiting, silentFor };
}

test('a conversation put in the archive leaves the list, is in the archive with its count, keeps where it stood, and comes back when the customer writes again', async () => {
  const t = await inbox();
  try {
    await t.say('Abcdefghijklmnopqrstu1', 'יש לכם משלוחים?');
    await t.say('Abcdefghijklmnopqrstu2', 'מה שעות הפתיחה?');
    const [a, b] = [await t.conv('Abcdefghijklmnopqrstu1'), await t.conv('Abcdefghijklmnopqrstu2')];
    assert.deepEqual((await t.listed('/chats')).sort(), [a, b].sort());
    assert.equal(await t.state(a), 'alone');

    // From the conversation's head: "לארכיון", its icon alone on a phone.
    const open = await t.page(`/chat/${a}`);
    assert.match(open, new RegExp(`action="/chat/${a}/archive"[^]*?name="on" value="1"[^]*?title="לארכיון"><svg class="i" aria-hidden="true"><use href="#i-archive"/></svg><span>לארכיון</span>`));
    assert.equal(await t.archive(a), 'השיחה עברה לארכיון. כשהלקוח יכתוב שוב, היא תחזור לשיחות.');
    assert.deepEqual(await t.listed('/chats'), [b], 'out of the list');
    assert.deepEqual(await t.listed('/chats?box=archive'), [a], 'in the archive');
    assert.equal(await t.state(a), 'alone', 'Toran answered it alone, archived or not');
    const list = await t.page('/chats');
    assert.match(list, /<a class="ib-arch" href="\/chats\?box=archive">[^]*?<span class="t">ארכיון<\/span><span class="n num">1<\/span><\/a>/, 'the way into the archive, with its count');
    const inArchive = await t.page('/chats?box=archive');
    assert.match(inArchive, /<div class="ib-up"><a href="\/chats" aria-label="חזרה לשיחות">/, 'and the way back');
    assert.doesNotMatch(inArchive, /class="seg"/, 'the archive is one list, no tabs');
    const facts = /<p class="th-facts">([^]*?)<\/p>/.exec(await t.page(`/chat/${a}`))![1];
    assert.match(facts, /<span class="chip ghost">בארכיון<\/span>/);
    assert.match(await t.page(`/chat/${a}`), /name="on" value="0"[^]*?<span>להוציא מהארכיון<\/span>/);

    // A search looks in the archive too, and says it.
    const found = await t.page('/chats?q=' + encodeURIComponent('משלוחים'));
    assert.match(found, new RegExp(`href="/chat/${a}\\?q=[^"]*"[^]*?<span class="chip ghost">בארכיון</span>`));

    // The customer writes again: back in the list by itself.
    await t.say('Abcdefghijklmnopqrstu1', 'ומה עם איסוף עצמי?');
    assert.deepEqual((await t.listed('/chats')).sort(), [a, b].sort());
    assert.deepEqual(await t.listed('/chats?box=archive'), []);
    assert.doesNotMatch(await t.page('/chats'), /class="ib-arch"/, 'no way into an empty archive');
  } finally {
    await t.s.close();
  }
});

test(`${ARCHIVE_DAYS} silent days put a conversation in the archive by itself, never one that waits for the owner; taking it out counts the days again`, async () => {
  const t = await inbox();
  try {
    await t.say('Abcdefghijklmnopqrstu3', 'יש מידה 42?');
    await t.say('Abcdefghijklmnopqrstu4', 'אפשר להחזיר מוצר?');
    const [quiet, waits] = [await t.conv('Abcdefghijklmnopqrstu3'), await t.conv('Abcdefghijklmnopqrstu4')];
    await handOver(t.s.app, t.id, waits, 'refund', 'מבקש להחזיר מוצר', 'x');
    await t.silentFor(quiet, ARCHIVE_DAYS - 1);
    await t.silentFor(waits, ARCHIVE_DAYS + 3);
    assert.deepEqual((await t.listed('/chats')).sort(), [quiet, waits].sort(), 'four days is not five');
    await t.silentFor(quiet, ARCHIVE_DAYS + 1);
    assert.deepEqual(await t.listed('/chats'), [waits], 'a waiting one stays, however long');
    assert.deepEqual(await t.listed('/chats?box=archive'), [quiet]);
    assert.equal(await t.waiting(), 1, 'the badge and the list agree');
    assert.deepEqual(await t.listed('/chats?state=waiting'), [waits]);

    // Taken out: in the list again, for five more days.
    assert.equal(await t.archive(quiet, false), 'השיחה חזרה לשיחות.');
    assert.deepEqual((await t.listed('/chats')).sort(), [quiet, waits].sort());
    await t.s.app.db.query(`UPDATE conversations SET unarchived_at = now() - interval '${ARCHIVE_DAYS + 1} days' WHERE id = $1`, [quiet]);
    assert.deepEqual(await t.listed('/chats?box=archive'), [quiet], 'and back in the archive after them');

    // Today's last conversations are the ones out of the archive, and say where the rest went.
    await t.silentFor(waits, 0);
    await t.archive(waits);
    await t.s.app.db.query(`UPDATE conversations SET last_at = now() - interval '30 days' WHERE NOT (id = ANY($1::int[]))`, [[quiet, waits]]);
    const today = await t.page('/');
    assert.match(today, /<b>אין שיחות מהימים האחרונים<\/b>[^]*?<a href="\/chats\?box=archive">לשיחות בארכיון<\/a>/);
    assert.doesNotMatch(today, /<b>עוד אין שיחות<\/b>/);
  } finally {
    await t.s.close();
  }
});

test('a waiting conversation put in the archive is marked handled, said before the second press, so the badge never counts one the list hides', async () => {
  const t = await inbox();
  try {
    await t.say('Abcdefghijklmnopqrstu5', 'אפשר לדבר עם מישהו?');
    const id = await t.conv('Abcdefghijklmnopqrstu5');
    await handOver(t.s.app, t.id, id, 'human_requested', 'רוצה לדבר עם מישהו', 'x');
    assert.equal(await t.waiting(), 1);
    assert.match(await t.page(`/chat/${id}`), /data-confirm="השיחה הזו מחכה לכם\. בארכיון היא תסומן כטופלה, ותחזור לשיחות כשהלקוח יכתוב שוב\. לחצו שוב כדי להעביר\."/);
    await t.archive(id);
    assert.equal(await t.waiting(), 0);
    assert.equal(await t.state(id), 'fixed', 'handled by the owner, as "טיפלתי בזה"');
    assert.deepEqual(await t.listed('/chats?box=archive'), [id]);
    // Their next message brings it back.
    await t.say('Abcdefghijklmnopqrstu5', 'הלו?');
    assert.deepEqual(await t.listed('/chats'), [id]);
    const audit = await t.s.app.db.query<any>("SELECT action FROM audit WHERE action IN ('archive', 'unarchive')");
    assert.deepEqual(audit.map((x) => x.action), ['archive']);
  } finally {
    await t.s.close();
  }
});
