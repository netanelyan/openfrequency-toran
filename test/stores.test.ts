import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foundStores, parseSince } from '../src/ops/stores.ts';
import { INTERNAL_TOKEN, testApp } from './helpers.ts';
import { serve } from './serve.ts';

// GET /internal/stores (src/ops/stores.ts, docs/operator.md section 4): the stores Toran found, for Teder's operator
// page of leads. Only from this machine with the token; only qualified stores, the opted-out ones flagged; paged in the
// order they changed, by stores.changed_at, which the database keeps on every write (migration 046).

const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

async function store(app: any, domain: string, cols: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = { domain, url: `https://${domain}/`, name: domain.split('.')[0], platform: 'shopify', source: 'seed', score: 70, qualified: true, ...cols };
  const keys = Object.keys(all);
  const vals = Object.values(all).map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v));
  return (await app.db.one('INSERT INTO stores (' + keys.join(', ') + ') VALUES (' + keys.map((_, i) => `$${i + 1}`).join(', ') + ') RETURNING id', vals)).id as number;
}

test('only from this machine with the token: none, a wrong one, through Caddy or not configured are refused as /internal/ops refuses them', async () => {
  const s = await serve();
  try {
    const get = (q = '', h: Record<string, string> = {}) => fetch(`${s.base}/internal/stores${q}`, { headers: h });
    const token = { authorization: `Bearer ${INTERNAL_TOKEN}` };
    const no = async (r: Response, status: number, error: string, why: string) => {
      assert.equal(r.status, status, why);
      assert.deepEqual(await r.json(), { error }, why);
    };
    await no(await get(), 401, 'bad_token', 'no token');
    await no(await get('', { authorization: `Bearer ${'x'.repeat(INTERNAL_TOKEN.length)}` }), 401, 'bad_token', 'a wrong token of the same length');
    await no(await get('', { authorization: 'Bearer short' }), 401, 'bad_token', 'a wrong token');
    await no(await get('', { ...token, 'x-forwarded-for': '1.2.3.4' }), 403, 'forbidden', 'never through Caddy, even with the token');
    const ok = await get('', token);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const body = await ok.json();
    assert.deepEqual(Object.keys(body), ['stores', 'next']);
    assert.ok(Array.isArray(body.stores));

    await no(await get('?since=yesterday', token), 400, 'bad_since', 'since that is not a moment');
    await no(await get('?since=now', token), 400, 'bad_since', "Postgres's own words are not moments here");
    await no(await get('?limit=0', token), 400, 'bad_limit', 'limit 0');
    await no(await get('?limit=ten', token), 400, 'bad_limit', 'limit not a number');
    assert.equal((await get('?limit=9999', token)).status, 200, 'past 500: 500');
    assert.equal((await get(`?since=${encodeURIComponent('2026-11-05T10:00:00.123456+02:00')}`, token)).status, 200);
    assert.equal((await get('?since=2026-11-05T10:00:00+02:00', token)).status, 200, 'a plus left unencoded is a space in the query, and mended');

    const saved = s.app.env.OF_INTERNAL_TOKEN;
    delete s.app.env.OF_INTERNAL_TOKEN;
    await no(await get('', token), 503, 'not_configured', 'no token set here');
    s.app.env.OF_INTERNAL_TOKEN = saved;
  } finally {
    await s.close();
  }
});

test('since is an ISO moment with its zone', () => {
  assert.equal(parseSince('2026-11-05T10:00:00.123456Z'), '2026-11-05T10:00:00.123456Z');
  assert.equal(parseSince('2026-11-05T10:00:00 02:00'), '2026-11-05T10:00:00+02:00');
  for (const bad of ['2026-11-05', '2026-11-05T10:00:00', 'now', 'epoch', '-infinity', '2026-13-45T10:00:00Z', '2026-11-05T10:00:00.1234567Z']) assert.equal(parseSince(bad), null, bad);
});

test('only qualified stores, each as the contract has it; every store Toran must not write to is there, flagged optedOut', async () => {
  const app = await testApp();
  try {
    const lead = await store(app, 'kli-cheres.example', {
      name: 'kli-cheres',
      brand: { name: 'כלי חרס' },
      brand_override: { name: 'כלי חרס של נורית' },
      status: 'page_ready',
      score: 82,
      contact_email: 'hello@kli-cheres.example',
      contact_whatsapp: '972500000401',
      contact_phone: '972500000403',
      signals: { productCount: 14, social: { instagram: 'https://www.instagram.com/kli.cheres/', facebook: 'https://www.facebook.com/kli.cheres' } },
    });
    const bare = await store(app, 'bare.example', { platform: 'unknown', name: null });
    await store(app, 'unqualified.example', { qualified: false, score: 40, contact_whatsapp: '972500000402' });
    const asked = await store(app, 'asked-down.example', { takedown_asked_at: new Date().toISOString() });
    const down = await store(app, 'taken-down.example', { taken_down_at: new Date().toISOString(), status: 'skipped' });
    const skipped = await store(app, 'skipped.example', { status: 'skipped', skipped_at: new Date().toISOString() });
    const lost = await store(app, 'lost.example', { lost_at: new Date().toISOString(), lost_reason: 'not_interested' });
    const customer = await store(app, 'customer.example', { workspace_id: 7 });
    const won = await store(app, 'pilot.example', { status: 'pilot' });

    const { stores, next } = await foundStores(app);
    assert.equal(next, null, 'not a full page');
    assert.deepEqual(stores.map((s) => s.domain).sort(), ['asked-down.example', 'bare.example', 'customer.example', 'kli-cheres.example', 'lost.example', 'pilot.example', 'skipped.example', 'taken-down.example'], 'the unqualified store is not there');
    const by = Object.fromEntries(stores.map((s) => [s.id, s]));
    const { updatedAt, ...rest } = by[lead];
    assert.match(updatedAt, MOMENT, 'an ISO moment in UTC, to the microsecond');
    assert.deepEqual(rest, {
      id: lead,
      domain: 'kli-cheres.example',
      url: 'https://kli-cheres.example/',
      name: 'כלי חרס של נורית', // the owner's name for the store first, as the dashboard shows it
      platform: 'shopify',
      score: 82,
      toranStatus: 'page_ready',
      contact: { email: 'hello@kli-cheres.example', whatsapp: '972500000401', phone: '972500000403' },
      social: { instagram: 'https://www.instagram.com/kli.cheres/', tiktok: null, facebook: 'https://www.facebook.com/kli.cheres' },
      optedOut: false,
    });
    assert.deepEqual([by[bare].name, by[bare].platform, by[bare].contact, by[bare].social], [null, null, { email: null, whatsapp: null, phone: null }, { instagram: null, tiktok: null, facebook: null }], 'nothing known: null, and an unknown platform too');
    for (const id of [asked, down, skipped, lost, customer]) assert.equal(by[id].optedOut, true, by[id].domain);
    assert.equal(by[won].optedOut, false, 'a pilot said yes, not no: toranStatus says it');
    assert.equal(by[won].toranStatus, 'pilot');

    // "reopen" on the dashboard undoes "not interested": the store comes again, no longer opted out.
    const { markLost, reopen } = await import('../src/ops/actions.ts');
    const last = stores.map((s) => s.updatedAt).sort().at(-1)!;
    await reopen(app, 'toran', String(lost), 'op');
    const again = await foundStores(app, { since: last });
    assert.deepEqual(again.stores.map((s) => [s.id, s.optedOut]), [[lost, false]]);
    await markLost(app, 'toran', String(lead), 'not_interested', 'op');
    assert.deepEqual((await foundStores(app, { since: again.stores[0].updatedAt })).stores.map((s) => [s.id, s.optedOut]), [[lead, true]], 'the operator\'s "לא מעוניינים" (a "לא" to the first message is recorded so)');
  } finally {
    await app.db.close();
  }
});

test('paged in the order the rows changed: since=next gives the rest, a change by any path brings a store back, one Teder is not given does not', async () => {
  const app = await testApp();
  try {
    const ids: number[] = [];
    for (const d of ['a', 'b', 'c', 'd', 'e']) ids.push(await store(app, `${d}.example`, { contact_whatsapp: `97250000041${ids.length}` }));
    await store(app, 'not-qualified.example', { qualified: false });
    // A moment of its own for each (PGlite's clock can give two inserts the same one; the next test is about that), long
    // ago, so that every change below is later than all of them.
    for (const [i, id] of ids.entries()) await app.db.query('UPDATE stores SET changed_at = $2 WHERE id = $1', [id, `2020-01-01T00:00:00.00000${i + 1}Z`]);

    const p1 = await foundStores(app, { limit: 2 });
    assert.deepEqual(p1.stores.map((s) => s.id), ids.slice(0, 2), 'the oldest change first');
    assert.equal(p1.next, p1.stores[1].updatedAt, 'a full page: next is its last row');
    const p2 = await foundStores(app, { since: p1.next, limit: 2 });
    assert.deepEqual(p2.stores.map((s) => s.id), ids.slice(2, 4));
    const p3 = await foundStores(app, { since: p2.next, limit: 2 });
    assert.deepEqual(p3.stores.map((s) => s.id), ids.slice(4));
    assert.equal(p3.next, null, 'the last page');
    const at = p3.stores[0].updatedAt;

    // Paths that write without updated_at (channels/request.ts sets contact_whatsapp so) still move it; a field Teder
    // is not given does not.
    await app.db.query('UPDATE stores SET opened_at = now(), notes = $2, knowledge_seen_at = now() WHERE id = $1', [ids[0], 'a note']);
    assert.deepEqual((await foundStores(app, { since: at })).stores, [], 'nothing Teder is given changed');
    await app.db.query('UPDATE stores SET contact_whatsapp = $2 WHERE id = $1', [ids[1], '972500000419']);
    await app.db.query(`UPDATE stores SET signals = signals || '{"social":{"tiktok":"https://www.tiktok.com/@c.example"}}'::jsonb WHERE id = $1`, [ids[2]]);
    const moved = await foundStores(app, { since: at });
    assert.deepEqual(moved.stores.map((s) => [s.id, s.contact.whatsapp, s.social.tiktok]), [[ids[1], '972500000419', null], [ids[2], '972500000412', 'https://www.tiktok.com/@c.example']], 'in the order they changed');
    assert.ok(moved.stores[0].updatedAt > at && moved.stores[1].updatedAt >= moved.stores[0].updatedAt);
    assert.equal(at, '2020-01-01T00:00:00.000005Z', 'given back exactly as kept, to the microsecond');

    // The over-the-HTTP answer is the same.
    const s = await serve();
    try {
      for (const d of ['x', 'y', 'z']) await store(s.app, `${d}.example`);
      const all: any[] = [];
      let since = '';
      for (let i = 0; i < 20; i++) {
        const r = await (await fetch(`${s.base}/internal/stores?limit=2${since ? `&since=${encodeURIComponent(since)}` : ''}`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } })).json();
        all.push(...r.stores);
        if (!r.next) break;
        since = r.next;
      }
      const mine = all.filter((x) => /^[xyz]\.example$/.test(x.domain));
      assert.deepEqual(mine.map((x) => x.domain), ['x.example', 'y.example', 'z.example'], 'every store once, in order');
      assert.equal(new Set(all.map((x) => x.id)).size, all.length, 'none twice');
    } finally {
      await s.close();
    }
  } finally {
    await app.db.close();
  }
});

test('rows that changed at the same moment as a page\'s last row all come in that page, so none falls between two pages', async () => {
  const app = await testApp();
  try {
    const ids: number[] = [];
    for (const d of ['t1', 't2', 't3', 't4']) ids.push(await store(app, `${d}.example`));
    // Three at one moment (a field Teder is not given changes nothing else, so the moment is kept as written).
    await app.db.query("UPDATE stores SET changed_at = '2026-11-05T10:00:00.000001Z' WHERE id = ANY($1::int[])", [ids.slice(0, 3)]);
    await app.db.query("UPDATE stores SET changed_at = '2026-11-05T10:00:00.000002Z' WHERE id = $1", [ids[3]]);
    const p1 = await foundStores(app, { since: '2026-11-05T09:00:00Z', limit: 2 });
    assert.deepEqual(p1.stores.map((s) => s.id), ids.slice(0, 3), 'the third shares the second\'s moment: it comes too');
    assert.equal(p1.next, '2026-11-05T10:00:00.000001Z');
    const p2 = await foundStores(app, { since: p1.next, limit: 2 });
    assert.deepEqual(p2.stores.map((s) => s.id), [ids[3]]);
    assert.equal(p2.next, null);
  } finally {
    await app.db.close();
  }
});
