import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// The customer's Results (TORAN-READINESS.md P1-12): answered alone leads, then waiting and fixed, three months, and
// what was handed over this month behind a button; the store's own conversations only, never the demo number's.

test('Results: answered alone first, the three states and months, the handed-over questions folded; only the session\'s own stores', async () => {
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 3 WHERE id = $1', [id]);
    const acc = (await s.app.db.one<{ id: number }>("INSERT INTO channel_accounts (store_id, channel, kind, external_id, name) VALUES ($1, 'email', 'sim', 'shop@in.results.test', 'x') RETURNING id", [id]))!.id;
    const conv = async (q: string, handoff: string | null) => {
      const c = (await s.app.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer, account_id) VALUES ($1, 'email', 'dana@example.test', $2) RETURNING id", [id, acc]))!.id;
      await s.app.db.query("INSERT INTO messages (conversation_id, role, text) VALUES ($1, 'customer', $2)", [c, q]);
      await s.app.db.query("INSERT INTO messages (conversation_id, role, text, handoff) VALUES ($1, 'agent', 'תשובה', $2::jsonb)", [c, handoff ? JSON.stringify({ reason: 'unknown', summary: handoff }) : null]);
      return c;
    };
    await conv('יש קערה?', null);
    await conv('יש צלחת?', null);
    const asked = await conv('אפשר לאסוף מהמחסן?', 'הלקוחה שואלת אם אפשר לאסוף מהמחסן');
    s.as(s.accounts.session(customer(3)).cookie);

    const home = await (await s.get('/')).text();
    assert.match(home, /<a href="\/results"[^>]*>.*תוצאות/s, 'Results in the menu');
    const page = await (await s.get('/results')).text();
    assert.match(page, /<span class="l">תורן ענה לבד<\/span><span class="v ok">2<\/span><span class="s">מתוך 3 שיחות החודש<\/span>/);
    assert.match(page, /<span class="l">מחכות לכם<\/span><span class="cnt sig">1<\/span>/);
    assert.match(page, /<h2>שלושה חודשים<\/h2>/);
    assert.match(page, /<details class="panel"><summary><h2>מה תורן העביר אליכם החודש<\/h2><span class="chip">1<\/span>/);
    assert.ok(page.includes(`href="/chat/${asked}"`));

    // Another workspace: nothing of this store.
    s.as(s.accounts.session(customer(8)).cookie);
    const other = await (await s.get('/results')).text();
    assert.ok(!other.includes(`/chat/${asked}`));
    assert.match(other, /עוד אין תוצאות/);
  } finally {
    await s.close();
  }
});
