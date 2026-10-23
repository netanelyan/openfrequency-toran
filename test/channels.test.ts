import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR } from '../src/core/clock.ts';
import { fit, LIMITS, sendPlan } from '../src/channels/policy.ts';
import { reply } from '../src/channels/send.ts';
import { adapterFor } from '../src/channels/route.ts';
import { simProvider, twilioProvider } from '../src/channels/whatsapp.ts';
import { testApp } from './helpers.ts';

test('the reply window: open for 24 hours after the customer wrote on WhatsApp, closed after', () => {
  const t = Date.parse('2026-10-23T12:00:00Z');
  assert.deepEqual(sendPlan(LIMITS.whatsapp, { lastCustomerAt: t, now: t + 23 * HOUR }), { ok: true, mode: 'response' });
  assert.deepEqual(sendPlan(LIMITS.whatsapp, { lastCustomerAt: t, now: t + 24 * HOUR + 1 }), { ok: false, reason: 'window_closed' });
  assert.deepEqual(sendPlan({ ...LIMITS.whatsapp, window: null }, { lastCustomerAt: t, now: t + 400 * HOUR }), { ok: true, mode: 'response' }, 'a channel with no window (email) is always open');
});

test('fit: a short text is one part; a long one is cut at a blank line, a line or a space, never past the limit', () => {
  assert.deepEqual(fit('שלום', 10), ['שלום']);
  assert.deepEqual(fit('', 10), ['']);
  assert.deepEqual(fit('אחת שתיים\n\nשלוש ארבע', 14), ['אחת שתיים', 'שלוש ארבע']);
  const long = Array.from({ length: 300 }, (_, i) => `מילה${i}`).join(' ');
  const parts = fit(long, 100);
  assert.ok(parts.every((p) => p.length <= 100 && p.length > 50));
  assert.equal(parts.join(' '), long, 'nothing lost or doubled');
  assert.deepEqual(fit('x'.repeat(25), 10), ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
});

test('every WhatsApp adapter carries the channel and Twilio\'s 1,600-character body', () => {
  const t = twilioProvider({ accountSid: 'AC0', authToken: 't', from: '+972500000999', webhookUrl: 'https://x/wa/twilio' });
  for (const a of [t, simProvider()]) {
    assert.equal(a.channel, 'whatsapp');
    assert.equal(a.limits.maxChars, 1600);
    assert.deepEqual(a.limits.window, { hours: 24 });
  }
  assert.equal(t.inboundUsd, 0.005);
  assert.equal(simProvider().inboundUsd, 0);
});

test('send: a reply past the window is not sent and is recorded; a long reply goes in parts, each one counted', async () => {
  const app = await testApp();
  const old = { from: '972500000101', text: 'שלום', id: 'old-1', at: Date.now() - 25 * HOUR };
  await reply(app, app.wa, old, 'תשובה מאוחרת', null, null);
  assert.equal(app.wa.outbox!.length, 0, 'nothing went out past the 24-hour window');
  assert.deepEqual((await app.db.one<any>("SELECT kind, data FROM events WHERE kind = 'wa_blocked'")).data, { conversationId: null, reason: 'window_closed' });

  const fresh = { from: '972500000101', text: 'שלום', id: 'new-1', at: Date.now() };
  await reply(app, app.wa, fresh, `${'א'.repeat(1200)}\n\n${'ב'.repeat(1200)}`, null, null);
  assert.deepEqual(app.wa.outbox!.map((o) => o.text.length), [1200, 1200]);
  assert.ok(app.wa.outbox!.every((o) => o.to === fresh.from && o.inReplyTo === fresh.id));
  assert.equal((await app.db.one<any>("SELECT COUNT(*)::int AS n FROM usage WHERE tag = 'wa_out'")).n, 2);
  assert.throws(() => adapterFor(app, 'email' as any), /no adapter for channel email/);
  await app.db.close();
});
