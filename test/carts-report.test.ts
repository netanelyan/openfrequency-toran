import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setNow } from '../src/core/clock.ts';
import { seal } from '../src/core/secrets.ts';
import { shopifyCheckout, shopifyOrderRead, wixOrderRead, wooOrderRead } from '../src/auto/platforms.ts';
import { cartLine, cartReport, moneyHe, monthNow, RECOVERY_DAYS } from '../src/auto/report.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// What the cart reminders brought back (the owner, 2026-11-06, docs/todo.md): carts reminded, carts recovered within
// RECOVERY_DAYS of the reminder by the same checkout or the same person, and the money, per month, on Today and on the
// automatic messages' settings.

const T0 = Date.parse('2026-11-08T10:00:00Z');
const day = 86_400_000;
let seq = 0;

/** A cart reminder that went out at `sentAt`, for a checkout and a person. */
async function reminder(db: any, storeId: number, sentAt: number, o: { checkout: string; phone?: string; email?: string; total?: number }) {
  await db.query(
    "INSERT INTO auto_events (store_id, key, kind, message, ref, contact, vars, source, happened_at, due_at, status, channel, sent_at) VALUES ($1, $2, 'cart', 'cart', 'c', $3::jsonb, $4::jsonb, 'webhook', $5, $5, 'sent', 'whatsapp', $5)",
    [storeId, `shopify:checkout:${o.checkout}:cart`, JSON.stringify({ phone: o.phone || null, email: o.email || null }), JSON.stringify({ link: 'https://x', total: o.total ?? null, currency: 'ILS' }), new Date(sentAt).toISOString()],
  );
}

/** An order placed at `at` (send.ts keeps one per order while carts are on). */
async function placed(db: any, storeId: number, at: number, o: { checkout?: string; phone?: string; email?: string; total?: number; currency?: string }) {
  await db.query(
    "INSERT INTO auto_events (store_id, key, kind, message, ref, contact, vars, source, happened_at, due_at, status) VALUES ($1, $2, 'order', 'placed', 'o', $3::jsonb, $4::jsonb, 'platform', $5, $5, 'noted')",
    [storeId, `shopify:placed:order:${seq++}`, JSON.stringify({ phone: o.phone || null, email: o.email || null }), JSON.stringify({ checkout: o.checkout || null, total: o.total ?? null, currency: o.currency || 'ILS' }), new Date(at).toISOString()],
  );
}

test('the platforms give the cart and the order their totals, for the money that came back', () => {
  const cart = shopifyCheckout({ token: 'tok1', created_at: '2026-11-01T10:00:00Z', abandoned_checkout_url: 'https://s/c', total_price: '249.90', currency: 'ILS', phone: '0500000123' });
  assert.deepEqual([cart.happenings[0].vars.total, cart.happenings[0].vars.currency], [249.9, 'ILS']);
  const order = shopifyOrderRead({ id: 7, created_at: '2026-11-02T10:00:00Z', total_price: '310.00', currency: 'ils', checkout_token: 'tok1', phone: '0500000123' });
  assert.deepEqual([order.placed[0].total, order.placed[0].currency], [310, 'ILS']);
  const woo = wooOrderRead({ id: 9, date_created_gmt: '2026-11-02T10:00:00', status: 'processing', total: '120.5', currency: 'ILS', billing: { phone: '0500000123' } }, 'https://w');
  assert.deepEqual([woo.placed[0].total, woo.placed[0].currency], [120.5, 'ILS']);
  const wix = wixOrderRead({ id: 'w1', createdDate: '2026-11-02T10:00:00Z', status: 'APPROVED', currency: 'ILS', priceSummary: { total: { amount: '89' } } }, [], 'https://x');
  assert.deepEqual([wix.placed[0].total, wix.placed[0].currency], [89, 'ILS']);
  assert.equal(shopifyOrderRead({ id: 8, created_at: '2026-11-02T10:00:00Z', total_price: 'abc' }).placed[0].total, null, 'no number, no amount');
});

test('a cart counts as recovered by its checkout or its person within the window, once, with the order\'s money', async () => {
  setNow(T0);
  const s = await serve();
  try {
    const db = s.app.db;
    const id = s.seeded.storeId;
    const sent = T0 - 5 * day;
    // By its checkout, two days after: the order's own total counts.
    await reminder(db, id, sent, { checkout: 'a', phone: '972500000111', total: 200 });
    await placed(db, id, sent + 2 * day, { checkout: 'a', total: 250 });
    // By the same email, with no total on the order: the cart's.
    await reminder(db, id, sent, { checkout: 'b', email: 'dana@example.test', total: 90 });
    await placed(db, id, sent + day, { email: 'dana@example.test' });
    // Ordered before the reminder went out: not the reminder's.
    await reminder(db, id, sent, { checkout: 'c', phone: '972500000122', total: 70 });
    await placed(db, id, sent - 3600_000, { phone: '972500000122', total: 70 });
    // Past the window: not counted.
    await reminder(db, id, T0 - 20 * day, { checkout: 'd', phone: '972500000133', total: 50 });
    await placed(db, id, T0 - 20 * day + (RECOVERY_DAYS + 1) * day, { phone: '972500000133', total: 50 });
    // Two orders after one reminder: one recovery, the first order's money.
    await reminder(db, id, sent, { checkout: 'e', phone: '972500000144' });
    await placed(db, id, sent + day, { phone: '972500000144', total: 40 });
    await placed(db, id, sent + 2 * day, { phone: '972500000144', total: 999 });
    // A reminder of another store's never counts here.
    const other = (await db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source) VALUES ('other.example', 'https://other.example/', 'Other', 'shopify', 'seed') RETURNING id"))!.id;
    await reminder(db, other, sent, { checkout: 'z', phone: '972500000155', total: 1000 });
    await placed(db, other, sent + day, { checkout: 'z', total: 1000 });

    const months = await cartReport(db, [id]);
    const now = months.find((m) => m.month === monthNow());
    assert.ok(now, 'this month is there');
    const all = months.reduce((a, m) => ({ reminded: a.reminded + m.reminded, recovered: a.recovered + m.recovered, ils: a.ils + (m.money.ILS || 0) }), { reminded: 0, recovered: 0, ils: 0 });
    assert.deepEqual(all, { reminded: 5, recovered: 3, ils: 250 + 90 + 40 });
    assert.equal(moneyHe({ ILS: 1240.4, USD: 80 }), '₪1,240 + $80');
    assert.equal(cartLine({ month: '2026-11', reminded: 12, recovered: 3, money: { ILS: 1240 } }), '12 עגלות קיבלו תזכורת, 3 חזרו והזמינו, ₪1,240');
    assert.equal(cartLine({ month: '2026-11', reminded: 1, recovered: 0, money: {} }), 'עגלה אחת קיבלה תזכורת, עוד אף אחת לא חזרה להזמין');
  } finally {
    setNow(null);
    await s.close();
  }
});

test('the owner sees the carts\' month on Today and on the automatic messages, and nothing before a reminder went out', async () => {
  setNow(T0);
  const s = await serve();
  try {
    const db = s.app.db;
    const id = s.seeded.storeId;
    Object.assign(s.app.env, { TORAN_SECRETS_KEY: 'k'.repeat(40), TORAN_CHANNELS: 'whatsapp,email' });
    await db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [id]);
    await db.query("INSERT INTO order_access (store_id, platform, secret, status, meta) VALUES ($1, 'shopify', $2, 'active', '{}')", [id, seal(s.app.env, JSON.stringify({ token: 't', shop: 'kli.myshopify.com' }))]);
    s.as(s.accounts.session(customer(1)).cookie);
    assert.doesNotMatch(await (await s.get('/')).text(), /עגלות שחזרו החודש/, 'no reminder yet, no line');
    await reminder(db, id, T0 - 2 * day, { checkout: 'a', phone: '972500000111', total: 300 });
    await placed(db, id, T0 - day, { checkout: 'a', total: 320 });
    await reminder(db, id, T0 - 2 * day, { checkout: 'b', phone: '972500000122', total: 80 });
    const today = await (await s.get('/')).text();
    assert.match(today, /עגלות שחזרו החודש<\/span><span class="cnt ok">1 · ₪320<\/span>/);
    const settings = await (await s.get('/settings')).text();
    assert.match(settings, /id="carts">מה העגלות החזירו/);
    assert.match(settings, /2 עגלות קיבלו תזכורת, אחת חזרה והזמינה, ₪320/);
  } finally {
    setNow(null);
    await s.close();
  }
});
