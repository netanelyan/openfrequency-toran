import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';
import { scriptedClient, type Script } from '../src/agent/llm/scripted.ts';
import { addressOf, choiceOf, emojiOn, learnVoice, PRESETS, readProfile, voiceBlock } from '../src/agent/voice.ts';
import { guardReply, styleReply, buildAllow } from '../src/agent/guard.ts';
import { storeBlock } from '../src/agent/prompt.ts';

// How Toran talks in a store (the owner, 2026-11-09: "make sure that toran learns its language from the website, and
// the store owner has a few options for formats of talking. everything should be natural").

const COPY_TONE = 'אצלנו כל כלי נעשה ביד, בסטודיו הקטן שלנו בגליל. אנחנו אוהבים לשמוע מכם, אז כתבו לנו על כל דבר. חם, ידני ובלי מהומה, ככה אנחנו עובדים כבר עשר שנים, עם חימר מקומי ושריפה איטית.';
const PROFILE = {
  register: 'casual', address: 'plural', sentences: 'short', emoji: { use: 'none', which: [] },
  summary: 'חם ואישי, פונה ללקוחות ברבים, משפטים קצרים.',
  points: [{ what: 'addresses customers in the plural', quote: 'אנחנו אוהבים לשמוע מכם' }, { what: 'invented quote, not on the site', quote: 'משהו שלא כתוב באתר' }],
  phrases: ['בסטודיו הקטן שלנו', 'לא מופיע באתר'], greetings: [], avoid: ['ניתן'],
  samples: [{ q: 'יש לכם קערה כחולה?', a: 'יש, והיא עולה 120 ₪. לשלוח לכם קישור?' }, { q: 'מתי זה מגיע?', a: 'בדרך כלל תוך כמה ימים. לבדוק לכם?' }],
};

test('the profile keeps only what the site really says, and needs a summary and samples', () => {
  const p = readProfile(PROFILE as any, COPY_TONE)!;
  assert.deepEqual(p.points.map((x) => x.quote), ['אנחנו אוהבים לשמוע מכם'], 'a quote not on the site is dropped');
  assert.deepEqual(p.phrases, ['בסטודיו הקטן שלנו']);
  assert.equal(p.address, 'plural');
  assert.equal(readProfile({ ...PROFILE, samples: [] } as any, COPY_TONE), null);
  assert.equal(readProfile(null, COPY_TONE), null);
});

test('the prompt says the chosen voice: the site\'s profile by default, a preset with its sample, the owner\'s line', () => {
  const profile = readProfile(PROFILE as any, COPY_TONE)!;
  const site = voiceBlock({ voice: { profile } }, 'tone');
  assert.match(site, /"כמו באתר שלכם"/);
  assert.match(site, /חם ואישי, פונה ללקוחות ברבים/);
  assert.match(site, /the site: "אנחנו אוהבים לשמוע מכם"/);
  assert.match(site, /plural \(אתם, לכם/, 'the site talks in the plural, so Toran may');
  assert.match(site, /never a source of facts/);
  const none = voiceBlock({}, 'דוגמה מהאתר');
  assert.match(none, /"""דוגמה מהאתר"""/, 'no profile yet: the raw sample, as before');
  assert.match(none, /forms that fit everyone/);
  const short = voiceBlock({ voice: { profile }, voiceChoice: { preset: 'short', note: 'פונים בשם הפרטי' } }, '');
  assert.match(short, /"קצר וענייני"/);
  assert.match(short, new RegExp(PRESETS.short.sample!));
  assert.match(short, /The owner adds, about how they talk: "פונים בשם הפרטי"/);
  assert.doesNotMatch(short, /VOICE PROFILE/, 'a preset of its own does not carry the site\'s profile');
  assert.equal(choiceOf({ voiceChoice: { preset: 'nonsense', emoji: 'x' } }).preset, 'site');
  assert.equal(emojiOn({ voiceChoice: { preset: 'light' } }), true);
  assert.equal(emojiOn({ voiceChoice: { preset: 'light', emoji: 'off' } }), false);
  assert.equal(emojiOn({}), false, 'a site with no emoji, none');
  assert.equal(addressOf({ voiceChoice: { preset: 'formal' } }), 'plural');
});

test('in code: emoji out when off, one mark not two, the honest line in the plural when the store talks so', () => {
  assert.equal(styleReply('יש 💚 עולה 89 ₪!! לשלוח לינק?', { emoji: false }), 'יש עולה 89 ₪! לשלוח לינק?');
  assert.equal(styleReply('יש 💚 עולה 89 ₪', { emoji: true }), 'יש 💚 עולה 89 ₪');
  const g = guardReply('כן, יש במלאי.', buildAllow({ toolTexts: [], customerTexts: ['יש לכם ספל ירוק?'] }), { asked: 'יש לכם ספל ירוק?', voice: { emoji: false, plural: true } });
  assert.match(g.text, /הוא יחזור אליכם כאן\./);
  assert.equal(g.needsHandoff, true, 'the handoff is unchanged');
});

test('learned from the site after a read, again only when the copy changed, never without a model; the store block carries it', async () => {
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    await s.app.db.query("UPDATE stores SET brand = brand || jsonb_build_object('tone', $2::text, 'description', 'כלים מקרמיקה בעבודת יד') WHERE id = $1", [id, COPY_TONE]);
    let calls = 0;
    const script: Script = (req) => {
      calls++;
      assert.match(String(req.messages[0].content), /THE STORE'S COPY:[^]*בסטודיו הקטן שלנו/);
      return [{ type: 'text', text: JSON.stringify(PROFILE) }];
    };
    s.app.llm = scriptedClient(script);
    assert.equal(await learnVoice(s.app, id), 'off', 'the scripted model learns nothing unless asked: the old sample stands');
    s.app.env.TORAN_VOICE = 'on';
    assert.equal(await learnVoice(s.app, id), 'learned');
    const cfg = (await s.app.db.one<any>('SELECT config FROM stores WHERE id = $1', [id]))!.config;
    assert.equal(cfg.voice.profile.summary, PROFILE.summary);
    assert.equal(await learnVoice(s.app, id), 'same', 'the copy did not change: no call');
    assert.equal(calls, 1);
    await s.app.db.query("UPDATE stores SET brand = brand || jsonb_build_object('tone', $2::text) WHERE id = $1", [id, `${COPY_TONE} חדש: גם ספלים בהזמנה אישית.`]);
    assert.equal(await learnVoice(s.app, id), 'learned', 'the re-read found new copy');
    assert.equal(calls, 2);
    s.app.llm = scriptedClient(() => [{ type: 'text', text: 'not json' }]);
    await s.app.db.query("UPDATE stores SET brand = brand || jsonb_build_object('tone', $2::text) WHERE id = $1", [id, `${COPY_TONE} ועוד שורה.`]);
    assert.equal(await learnVoice(s.app, id), 'failed');
    assert.equal((await s.app.db.one<any>('SELECT config FROM stores WHERE id = $1', [id]))!.config.voice.profile.summary, PROFILE.summary, 'a failed answer keeps the profile it had');
    const store = (await s.app.db.one<any>('SELECT * FROM stores WHERE id = $1', [id]))!;
    assert.match(await storeBlock(s.app.db, store), /# VOICE[^]*VOICE PROFILE[^]*חם ואישי/);
  } finally {
    await s.close();
  }
});

test('Settings: the owner picks how Toran talks and sees each voice answer the same question; a team member cannot change it', async () => {
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 16 WHERE id = $1', [id]);
    s.as(s.accounts.session(customer(16)).cookie);
    const page = await (await s.get('/settings')).text();
    assert.match(page, /<section class="panel" id="voice">[^]*איך תורן מדבר/);
    for (const k of ['site', 'warm', 'short', 'light', 'formal']) assert.match(page, new RegExp(`name="preset" value="${k}"`));
    assert.match(page, /value="site" checked/);
    assert.ok(page.includes('יש. 89 ₪. לשלוח קישור?'), 'each option shows its sample');
    const r = await s.post(`/lead/${id}/voice`, { _csrf: await s.csrf('/settings'), preset: 'formal', emoji: 'off', note: 'פונים בשם הפרטי' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/settings#voice');
    const cfg = (await s.app.db.one<any>('SELECT config FROM stores WHERE id = $1', [id]))!.config;
    assert.deepEqual({ ...cfg.voiceChoice, summary: undefined }, { preset: 'formal', emoji: 'off', note: 'פונים בשם הפרטי', summary: undefined });
    assert.match(await (await s.get('/settings')).text(), /value="formal" checked/);
    s.as(s.accounts.session({ ...customer(16), role: 'client_member' }).cookie);
    const refused = await s.post(`/lead/${id}/voice`, { _csrf: await s.csrf('/settings'), preset: 'light' });
    assert.ok([303, 403].includes(refused.status), 'refused (as a page with the reason, or a 403)');
    if (refused.status === 303) assert.match(decodeURIComponent(String(refused.headers.get('set-cookie'))), /רק מי שפתח את החשבון/);
    assert.equal((await s.app.db.one<any>('SELECT config FROM stores WHERE id = $1', [id]))!.config.voiceChoice.preset, 'formal');
  } finally {
    await s.close();
  }
});
