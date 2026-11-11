import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleInbound } from '../src/channels/route.ts';
import { PAGE_ABOUT, PAGE_DOWN } from '../src/offer.ts';
import { COMPANY_PROMPT } from '../src/agent/prompt.ts';
import { COMPANY_TOOLS } from '../src/agent/tools.ts';
import { testApp } from './helpers.ts';

// Our own funnel promises only what someone does (the audit of 2026-11-12, P1-22): "לכתוב לנו" from a pitch page is
// answered "ונחזור אליכם כאן", so the operator is told at once; and our support says how a demo is asked for (the
// website's form, its code on WhatsApp) instead of promising to build one by hand.

test('"לכתוב לנו" and "להוריד את העמוד" from a pitch page reach the operator, with the store\'s name and what they wrote', async () => {
  const app = await testApp();
  try {
    app.env.DEMO_WA_NUMBER = app.env.TORAN_OWNER_WHATSAPP = '972500000999';
    const id = (await app.db.one<{ id: number }>("INSERT INTO stores (domain, url, name, platform, source, slug, status, approved_at, page_built_at, sent_at, brand) VALUES ('shop.example', 'https://shop.example/', 'shop', 'shopify', 'seed', 'shop-x1', 'sent', now(), now(), now(), '{\"name\": \"כלי חרס של נורית\"}'::jsonb) RETURNING id"))!.id;
    const about = await handleInbound(app, { from: '972500000581', text: `${PAGE_ABOUT} לכלי חרס של נורית: https://toran.example/s/shop-x1 יש לי שאלה על המחיר`, id: 'c1', at: Date.now() });
    assert.equal(about.action, 'contact');
    const alerts = async () => app.db.query<{ data: any }>("SELECT data FROM events WHERE kind = 'operator_alert' AND store_id = $1 ORDER BY id", [id]);
    const [contact] = await alerts();
    assert.equal(contact?.data.key, `contact:${id}`);
    assert.equal(contact?.data.title, 'כתבו לנו מהעמוד של כלי חרס של נורית');

    const down = await handleInbound(app, { from: '972500000582', text: `${PAGE_DOWN} לכלי חרס של נורית? https://toran.example/s/shop-x1`, id: 'c2', at: Date.now() });
    assert.equal(down.action, 'takedown');
    assert.deepEqual((await alerts()).map((a) => a.data.title), ['כתבו לנו מהעמוד של כלי חרס של נורית', 'ביקשו להוריד את העמוד של כלי חרס של נורית']);
  } finally {
    await app.db.close();
  }
});

test('our support says how a demo is asked for, on the website, and hands off neither a demo nor a promise to build one', () => {
  assert.match(COMPANY_PROMPT, /Someone wants a demo: it is asked for on the company's website/);
  assert.match(COMPANY_PROMPT, /Do not call handoff for a demo/);
  assert.match(COMPANY_PROMPT, /מבקשים דמו באתר שלנו, openfrequency\.co\.il: כותבים שם את הכתובת של החנות/);
  assert.doesNotMatch(COMPANY_PROMPT, /נבנה עליה דמו|we will build the demo/);
  const handoff = COMPANY_TOOLS.find((t) => t.name === 'handoff')!;
  assert.match(handoff.description, /Not for a demo/);
  assert.doesNotMatch(handoff.description, /wants a demo/);
});
