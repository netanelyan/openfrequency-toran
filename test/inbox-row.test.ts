import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationRow, peerLabel } from '../src/web/inbox.ts';

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
