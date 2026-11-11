import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_HE, MESSAGING } from '../src/channels/config.ts';
import { avatar, conversationRow, peerLabel } from '../src/web/inbox.ts';
import { layout } from '../src/web/ui.ts';

// A conversation's row in the inbox and on Today, as the owner read it on 2026-11-11.

const row = (o: Record<string, unknown>) => conversationRow({ id: 1, channel: 'whatsapp', account_id: 1, state: 'waiting', last_at: new Date().toISOString(), last_q: 'מה נשמע', ...o } as any);

test('a waiting conversation shows what Toran handed over in Hebrew, an old English line too', () => {
  const html = row({ summary: 'the guard cut stock: מה נשמע' });
  assert.match(html, /תורן העביר/);
  assert.doesNotMatch(html, /the guard cut/);
  assert.match(html, /המלאי/);
});

test("a site chat visitor is a customer, never their browser's id dressed as a phone", () => {
  assert.equal(peerLabel('web', '2PmkTx9qZ1GUg'), 'לקוח');
  assert.doesNotMatch(row({ channel: 'web', peer: '2PmkTx9qZ1GUg', summary: null, state: 'alone' }), /•••/);
  assert.equal(peerLabel('whatsapp', '972500000493'), '+97250•••493', 'a phone stays partly hidden');
});

// The owner, 2026-11-11: "make the toran inbox look a bit more like an inbox, maybe mark every type of channel with its
// logo".

test("each channel's row carries the channel's own logo, named in Hebrew, and every page has the logos to draw", () => {
  const page = layout({ title: 't', csrf: 'c' }, '');
  for (const ch of MESSAGING) {
    const html = row({ channel: ch, peer: ch === 'email' ? 'dana@example.test' : '972500000493', state: 'alone', summary: null });
    const name = CHANNEL_HE[ch as keyof typeof CHANNEL_HE];
    assert.ok(html.includes(`<span class="av-ch"><svg class="chl chl-${ch}" role="img" aria-label="${name}"><title>${name}</title><use href="#ch-${ch}"/></svg></span>`), `${ch}: its logo, named "${name}"`);
    assert.match(html, /^<a class="ib-row" href="\/chat\/1"><span class="av av-\d">/, `${ch}: the avatar is not hidden from a screen reader, so the logo's name is read`);
    assert.ok(!html.includes(`<span class="chip">${name}</span>`), `${ch}: the logo says the channel, no word beside it`);
    assert.ok(page.includes(`<symbol id="ch-${ch}" viewBox="0 0 24 24">`), `${ch}: drawn in the sprite`);
  }
  // Over an open conversation the channel's name is written beside the avatar, so its logo there is decoration.
  assert.match(avatar('whatsapp:1', null, 'whatsapp', { cls: 'av lg', label: false }), /^<span class="av lg av-\d" aria-hidden="true">.*<svg class="chl chl-whatsapp" aria-hidden="true"><use href="#ch-whatsapp"\/><\/svg>/);
});

test('a waiting conversation is the unread one: bold with a dot, "מחכה לכם" for a screen reader; the others say where they stand', () => {
  const waiting = row({ summary: 'הלקוחה שואלת על משלוח' });
  assert.match(waiting, /^<a class="ib-row is-waiting"/);
  assert.ok(waiting.includes('<span class="sr">מחכה לכם</span>'));
  assert.doesNotMatch(waiting, /class="chip bad"/, 'no badge: the line of what Toran handed over keeps the width');
  const alone = row({ state: 'alone', summary: null, last_text: 'כן, יש בכחול', last_role: 'agent' });
  assert.match(alone, /^<a class="ib-row" /);
  assert.match(alone, /<span class="ib-line"><span class="ib-snip"><span class="ib-who">תורן:<\/span> כן, יש בכחול<\/span><span class="chip ok">ענה לבד<\/span><\/span>/);
  assert.doesNotMatch(alone, /ib-meta/, 'nothing under the line when there is no store, demo or note');
  assert.match(row({ state: 'fixed', summary: null, store: 'כלי חרס' }), /<span class="chip sig">תיקנתם<\/span><\/span><span class="ib-meta"><span class="chip ghost">כלי חרס<\/span><\/span>/);
});
