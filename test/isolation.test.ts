import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardRoutes } from '../src/web/routes.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// Tenant isolation, route by route (the audit's PRA-QA-004, Teder's pattern): every route of the dashboard's table has
// a case here, or the test fails and names it. A route that takes an id is asked, from workspace A's session, with
// workspace B's store, chat or job, and must answer 404 (as one that never was) and leave B's rows as they were. A
// route with no id is listed with why it needs no id case: it reads the session's own workspace, or it is the
// operator's alone (server.ts OPERATOR_ONLY, OPERATOR_PAGES).

type Ids = { b: number; chatB: number; jobB: number };
const ID_CASES: Record<string, (i: Ids) => string> = {
  'GET ^\\/lead\\/(\\d+)\\/knowledge$': (i) => `/lead/${i.b}/knowledge`,
  'POST ^\\/lead\\/(\\d+)\\/reread$': (i) => `/lead/${i.b}/reread`,
  'POST ^\\/chat\\/(\\d+)\\/settle$': (i) => `/chat/${i.chatB}/settle`,
  'POST ^\\/lead\\/(\\d+)\\/plan$': (i) => `/lead/${i.b}/plan`,
  'GET ^\\/lead\\/(\\d+)\\/whatsapp$': (i) => `/lead/${i.b}/whatsapp`,
  'POST ^\\/lead\\/(\\d+)\\/whatsapp\\/connect$': (i) => `/lead/${i.b}/whatsapp/connect`,
  'POST ^\\/lead\\/(\\d+)\\/whatsapp\\/disconnect$': (i) => `/lead/${i.b}/whatsapp/disconnect`,
  'GET ^\\/lead\\/(\\d+)\\/(messenger|instagram)$': (i) => `/lead/${i.b}/messenger`,
  'POST ^\\/lead\\/(\\d+)\\/(messenger|instagram)\\/connect$': (i) => `/lead/${i.b}/instagram/connect`,
  'POST ^\\/lead\\/(\\d+)\\/messenger\\/pick$': (i) => `/lead/${i.b}/messenger/pick`,
  'POST ^\\/lead\\/(\\d+)\\/(messenger|instagram)\\/disconnect$': (i) => `/lead/${i.b}/messenger/disconnect`,
  'POST ^\\/lead\\/(\\d+)\\/mail-domain$': (i) => `/lead/${i.b}/mail-domain`,
  'POST ^\\/lead\\/(\\d+)\\/mail-domain\\/check$': (i) => `/lead/${i.b}/mail-domain/check`,
  'POST ^\\/lead\\/(\\d+)\\/orders$': (i) => `/lead/${i.b}/orders`,
  'POST ^\\/lead\\/(\\d+)\\/orders\\/off$': (i) => `/lead/${i.b}/orders/off`,
  'POST ^\\/lead\\/(\\d+)\\/auto\\/(cart|payment|shipping|review)$': (i) => `/lead/${i.b}/auto/cart`,
  'POST ^\\/lead\\/(\\d+)\\/auto\\/templates$': (i) => `/lead/${i.b}/auto/templates`,
  'POST ^\\/lead\\/(\\d+)\\/auto\\/secret$': (i) => `/lead/${i.b}/auto/secret`,
  'GET ^\\/chat\\/(\\d+)$': (i) => `/chat/${i.chatB}`,
  'POST ^\\/chat\\/(\\d+)\\/reply$': (i) => `/chat/${i.chatB}/reply`,
  'GET ^\\/chat\\/(\\d+)\\/file\\/(\\d+)$': (i) => `/chat/${i.chatB}/file/1`,
  'POST ^\\/chat\\/(\\d+)\\/same$': (i) => `/chat/${i.chatB}/same`,
  'POST ^\\/chat\\/(\\d+)\\/apart$': (i) => `/chat/${i.chatB}/apart`,
  'POST ^\\/chat\\/(\\d+)\\/resume$': (i) => `/chat/${i.chatB}/resume`,
  'GET ^\\/lead\\/(\\d+)$': (i) => `/lead/${i.b}`,
  'GET ^\\/job\\/(\\d+)$': (i) => `/job/${i.jobB}`,
  'POST ^\\/lead\\/(\\d+)\\/channels\\/email$': (i) => `/lead/${i.b}/channels/email`,
  'POST ^\\/lead\\/(\\d+)\\/build$': (i) => `/lead/${i.b}/build`,
  'POST ^\\/lead\\/(\\d+)\\/approve$': (i) => `/lead/${i.b}/approve`,
  'POST ^\\/lead\\/(\\d+)\\/takedown$': (i) => `/lead/${i.b}/takedown`,
  'POST ^\\/lead\\/(\\d+)\\/unapprove$': (i) => `/lead/${i.b}/unapprove`,
  'POST ^\\/lead\\/(\\d+)\\/sent$': (i) => `/lead/${i.b}/sent`,
  'POST ^\\/lead\\/(\\d+)\\/followup-sent$': (i) => `/lead/${i.b}/followup-sent`,
  'POST ^\\/lead\\/(\\d+)\\/release$': (i) => `/lead/${i.b}/release`,
  'POST ^\\/lead\\/(\\d+)\\/skip$': (i) => `/lead/${i.b}/skip`,
  'POST ^\\/lead\\/(\\d+)\\/status$': (i) => `/lead/${i.b}/status`,
  'POST ^\\/lead\\/(\\d+)\\/notes$': (i) => `/lead/${i.b}/notes`,
  'GET ^\\/lead\\/(\\d+)\\/review$': (i) => `/lead/${i.b}/review`,
  'POST ^\\/lead\\/(\\d+)\\/product\\/(\\d+)$': (i) => `/lead/${i.b}/product/1`,
  'POST ^\\/lead\\/(\\d+)\\/policy\\/(\\d+)$': (i) => `/lead/${i.b}/policy/1`,
  'POST ^\\/lead\\/(\\d+)\\/faq\\/(\\d+)$': (i) => `/lead/${i.b}/faq/1`,
  'POST ^\\/lead\\/(\\d+)\\/faq$': (i) => `/lead/${i.b}/faq`,
  'POST ^\\/lead\\/(\\d+)\\/brand$': (i) => `/lead/${i.b}/brand`,
  'POST ^\\/lead\\/(\\d+)\\/sample$': (i) => `/lead/${i.b}/sample`,
  'GET ^\\/lead\\/(\\d+)\\/assistant$': (i) => `/lead/${i.b}/assistant`,
  'POST ^\\/lead\\/(\\d+)\\/assistant$': (i) => `/lead/${i.b}/assistant`,
  'GET ^\\/jobs\\/(\\d+)\\.json$': (i) => `/jobs/${i.jobB}.json`,
};

/** The routes with no id, and why none is needed. */
const NO_ID: Record<string, string> = {
  'GET ^\\/knowledge$': "the session's own store",
  'GET ^\\/plan$': "the session's own store",
  'GET ^\\/export\\/conversations\\.csv$': "the session's own conversations (customer.test.ts)",
  'GET ^\\/start$': "the session's own workspace",
  'POST ^\\/start$': "the session's own workspace (setup.test.ts)",
  'POST ^\\/start\\/verify$': "the session's own workspace's claim (setup.test.ts)",
  'GET ^\\/$': "the session's own Today",
  'GET ^\\/chats$': "the session's own inbox",
  'POST ^\\/settings\\/channels$': "the operator's alone (OPERATOR_ONLY)",
  'GET ^\\/followups$': "the operator's alone (OPERATOR_PAGES)",
  'GET ^\\/settings$': "the session's own settings",
  'POST ^\\/settings\\/offer$': "the operator's alone (OPERATOR_ONLY)",
  'POST ^\\/settings\\/discover$': "the operator's alone (OPERATOR_ONLY)",
  'GET ^\\/leads$': "the operator's alone (OPERATOR_PAGES)",
  'POST ^\\/leads\\/add$': "the operator's alone (OPERATOR_ONLY)",
  'GET ^\\/review$': "the operator's alone (OPERATOR_PAGES)",
  'POST ^\\/review\\/approve-all$': "the operator's alone (OPERATOR_ONLY)",
  'GET ^\\/assistant$': "the session's own store's assistant",
  'GET ^\\/brand$': 'the brand sheet, nobody\'s data',
};

test('every dashboard route has an isolation case: an id case asked with another workspace\'s ids, or a reason it needs none', async () => {
  const s = await serve();
  try {
    const keys = dashboardRoutes(s.app).map(([m, re]) => `${m} ${re.source}`);
    const missing = keys.filter((k) => !ID_CASES[k] && !NO_ID[k]);
    assert.deepEqual(missing, [], `routes with no isolation case: ${missing.join(', ')}`);
    const stale = [...Object.keys(ID_CASES), ...Object.keys(NO_ID)].filter((k) => !keys.includes(k));
    assert.deepEqual(stale, [], 'cases for routes that no longer exist');
    for (const k of keys) if (/\(\\d\+\)/.test(k)) assert.ok(ID_CASES[k], `${k} takes an id: it needs an id case, not a reason`);
  } finally {
    await s.close();
  }
});

test("workspace A asking with workspace B's ids: every id route answers 404, and B's rows stay as they were", async () => {
  const s = await serve();
  try {
    const a = s.seeded.storeId;
    const b = (await s.app.db.one<{ id: number }>("SELECT id FROM stores WHERE domain = 'shaked-jewelry.example'"))!.id;
    await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [a]);
    await s.app.db.query("UPDATE stores SET workspace_id = 2, notes = 'B notes' WHERE id = $1", [b]);
    const chatB = (await s.app.db.one<{ id: number }>("INSERT INTO conversations (store_id, channel, peer) VALUES ($1, 'whatsapp', '972500000445') RETURNING id", [b]))!.id;
    await s.app.db.query("INSERT INTO messages (conversation_id, role, text) VALUES ($1, 'customer', 'שאלה של חנות ב')", [chatB]);
    const jobB = Number((await s.app.db.one<{ id: number }>("INSERT INTO jobs (kind, payload, status) VALUES ('ingest', $1::jsonb, 'done') RETURNING id", [JSON.stringify({ storeId: b })]))!.id);
    const snapshot = async () =>
      JSON.stringify(
        await s.app.db.one<any>(
          `SELECT (SELECT row_to_json(x) FROM (SELECT workspace_id, status, notes, approved_at, taken_down_at, skipped_at, brand_override, config, updated_at FROM stores WHERE id = $1) x) AS store,
                  (SELECT COUNT(*)::int FROM faqs WHERE store_id = $1) AS faqs,
                  (SELECT COUNT(*)::int FROM messages WHERE conversation_id = $2) AS messages,
                  (SELECT row_to_json(c) FROM (SELECT agent_paused_until, closed_at FROM conversations WHERE id = $2) c) AS chat,
                  (SELECT COUNT(*)::int FROM channel_accounts WHERE store_id = $1) AS channels,
                  (SELECT COUNT(*)::int FROM jobs WHERE payload->>'storeId' = $1::text) AS jobs`,
          [b, chatB],
        ),
      );
    const before = await snapshot();
    s.as(s.accounts.session(customer(1)).cookie);
    const token = await s.csrf(`/lead/${a}/knowledge`);
    assert.ok(token);
    const ids = { b, chatB, jobB };
    for (const [key, path] of Object.entries(ID_CASES)) {
      const p = path(ids);
      const r = key.startsWith('GET') ? await s.get(p) : await s.post(p, { _csrf: token, notes: 'A', status: 'paid', plan: 'big', on: '1', text: 'A', question: 'A?', answer: 'A', reason: 'A', key: 'A', domain: 'a.example' });
      assert.equal(r.status, 404, `${key} (${p})`);
    }
    assert.equal(await snapshot(), before, "nothing of B's changed");
  } finally {
    await s.close();
  }
});
