import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/leads/discover.ts';
import { ingestStore } from '../src/ingest/pack.ts';
import { runTool } from '../src/agent/tools.ts';
import { connectOrders, OrderConnectError } from '../src/orders.ts';
import { hookSecretOf, setupSource } from '../src/auto/platforms.ts';
import { EXAMPLE_DOMAIN } from '../src/demo.ts';
import type { App } from '../src/app.ts';
import { testApp } from './helpers.ts';

// A Shopify store connected the way Shopify allows since 2026-01-01: an app made in the Dev Dashboard, installed on the
// store, its Client ID and Client secret exchanged for a 24-hour token with the client credentials grant
// (shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant). Shopify is a stand-in (app.api).

const SHOP = 'kli-cheres-example.myshopify.com';
const KEY = { TORAN_SECRETS_KEY: 's'.repeat(40) };
const SECRET = `shpss_${'DEVSECRET'.repeat(3)}`;
const ORDER = {
  id: 5001, name: '#1042', order_number: 1042, email: 'dana@example.test', contact_email: 'dana@example.test', phone: null,
  created_at: '2026-10-20T09:00:00+03:00', cancelled_at: null, financial_status: 'paid', fulfillment_status: 'fulfilled',
  customer: { email: 'dana@example.test', phone: '+972500000101' }, billing_address: { phone: '050-000-0101' }, shipping_address: { phone: '050-000-0101' },
  fulfillments: [],
};

async function store(): Promise<{ app: App; id: number }> {
  const app = await testApp();
  await discover(app.db, (async function* () { yield { url: `https://${EXAMPLE_DOMAIN}/`, source: 'seed', detail: {} }; })(), { fetcher: app.fetcher, limit: 1 });
  const id = (await app.db.one<{ id: number }>('SELECT id FROM stores WHERE domain = $1', [EXAMPLE_DOMAIN]))!.id;
  await ingestStore(app, id);
  Object.assign(app.env, KEY);
  return { app, id };
}

type Call = { url: string; method: string; headers: Record<string, string>; form: URLSearchParams | null; json: any };

/** Shopify's token endpoint and Admin API: a token per grant, and only the current one is taken. */
function shopify(clientId: string, { refuse = '' }: { refuse?: string } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const state = { current: '' };
  const api = (async (input: any, init: any = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = init.body ? String(init.body) : '';
    const c: Call = { url: String(input), method: init.method || 'GET', headers, form: headers['content-type']?.includes('urlencoded') ? new URLSearchParams(body) : null, json: body && !headers['content-type']?.includes('urlencoded') ? JSON.parse(body) : null };
    calls.push(c);
    const u = new URL(c.url);
    const out = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.host !== SHOP) return out(404, {});
    if (u.pathname === '/admin/oauth/access_token') {
      if (refuse) return out(400, { error: refuse, error_description: `Oauth error ${refuse}: Client credentials cannot be performed on this shop.` });
      if (c.form?.get('grant_type') !== 'client_credentials' || c.form?.get('client_id') !== clientId || c.form?.get('client_secret') !== SECRET || c.form?.has('scope')) return out(401, { error: 'invalid_client' });
      state.current = `tok-${++n}`;
      return out(200, { access_token: state.current, scope: 'read_orders', expires_in: 86399 });
    }
    if (c.headers['x-shopify-access-token'] !== state.current) return out(401, { errors: '[API] Invalid API key or access token' });
    if (u.pathname.endsWith('/orders.json')) return out(200, { orders: !u.searchParams.get('name') || u.searchParams.get('name') === '#1042' ? [ORDER] : [] });
    if (u.pathname.endsWith('/checkouts.json')) return out(200, { checkouts: [] });
    if (u.pathname.endsWith('/webhooks.json')) return c.method === 'POST' ? out(201, { webhook: { id: calls.length, ...c.json?.webhook } }) : out(200, { webhooks: [] });
    return out(404, {});
  }) as typeof fetch;
  const tokens = () => calls.filter((c) => c.url.endsWith('/admin/oauth/access_token')).length;
  return { api, calls, state, tokens };
}

test('a Dev Dashboard app connects with its Client ID and secret: a token from the grant, sealed, kept for the day and asked again on a 401', async () => {
  const { app, id } = await store();
  try {
    const sh = shopify('a'.repeat(32));
    app.api = sh.api;
    await connectOrders(app, id, { client_id: 'a'.repeat(32), client_secret: SECRET, shop: SHOP }, 'owner');
    const row = await app.db.one<any>('SELECT secret, status, meta FROM order_access WHERE store_id = $1', [id]);
    assert.deepEqual([row.status, row.meta.kind, row.meta.shop], ['active', 'dev_dashboard', SHOP]);
    assert.ok(!row.secret.includes(SECRET) && !row.secret.includes('a'.repeat(32)), 'sealed');
    assert.equal(sh.tokens(), 1, 'one grant to try the app');

    const ctx = { db: app.db, storeId: id, origin: `https://${EXAMPLE_DOMAIN}`, currency: 'ILS', env: app.env, demo: false, api: sh.api, said: ['איפה 1042?'], waPhone: '972500000101' };
    assert.match((await runTool(ctx, 'get_order_status', { order_number: '1042' })).content, /^Order #1042/);
    assert.match((await runTool(ctx, 'get_order_status', { order_number: '1042' })).content, /^Order #1042/);
    assert.equal(sh.tokens(), 1, 'the token is kept, not asked for on every call');

    sh.state.current = 'rotated'; // Shopify stopped taking the kept token
    assert.match((await runTool(ctx, 'get_order_status', { order_number: '1042' })).content, /^Order #1042/, 'one new token after a 401, then the answer');
    assert.equal(sh.tokens(), 2);
  } finally {
    await app.db.close();
  }
});

test('an app outside the store\'s organization, an app not installed, and a malformed ID are each said in Hebrew; the old shpat_ token still connects', async () => {
  const { app, id } = await store();
  try {
    app.api = shopify('b'.repeat(32), { refuse: 'shop_not_permitted' }).api;
    await assert.rejects(connectOrders(app, id, { client_id: 'b'.repeat(32), client_secret: SECRET, shop: SHOP }, 'owner'), (e: any) => e instanceof OrderConnectError && /מאותו חשבון שהחנות שייכת אליו/.test(e.he));
    app.api = shopify('c'.repeat(32)).api;
    await assert.rejects(connectOrders(app, id, { client_id: 'd'.repeat(32), client_secret: SECRET, shop: SHOP }, 'owner'), (e: any) => e instanceof OrderConnectError && /שהאפליקציה מותקנת על החנות/.test(e.he), 'another app\'s ID: the store did not give a token');
    await assert.rejects(connectOrders(app, id, { client_id: 'not an id', client_secret: SECRET, shop: SHOP }, 'owner'), (e: any) => e instanceof OrderConnectError && /Client ID/.test(e.he));
    await assert.rejects(connectOrders(app, id, { client_id: 'c'.repeat(32), client_secret: '', shop: SHOP }, 'owner'), (e: any) => e instanceof OrderConnectError && /Client secret/.test(e.he));
    assert.equal(await app.db.one('SELECT 1 FROM order_access WHERE store_id = $1', [id]), null, 'nothing kept');

    const token = `shpat_${'TEST'.repeat(6)}`;
    app.api = (async (input: any, init: any = {}) => new Response(JSON.stringify(new URL(String(input)).pathname.endsWith('/orders.json') && init.headers?.['x-shopify-access-token'] === token ? { orders: [] } : {}), { status: init.headers?.['x-shopify-access-token'] === token ? 200 : 401 })) as typeof fetch;
    await connectOrders(app, id, { token, shop: SHOP }, 'owner');
    assert.equal((await app.db.one<any>('SELECT meta FROM order_access WHERE store_id = $1', [id])).meta.kind, 'custom_app');
  } finally {
    await app.db.close();
  }
});

test('the automatic messages sign Shopify\'s webhooks with the Dev Dashboard app\'s client secret, with nothing more to paste', async () => {
  const { app, id } = await store();
  try {
    app.env.PUBLIC_BASE_URL = 'https://toran.example';
    const sh = shopify('e'.repeat(32));
    app.api = sh.api;
    await connectOrders(app, id, { client_id: 'e'.repeat(32), client_secret: SECRET, shop: SHOP }, 'owner');
    const src = await setupSource(app, id);
    assert.equal(src?.can?.webhooks ?? (await app.db.one<any>('SELECT can FROM auto_sources WHERE store_id = $1', [id]))?.can?.webhooks, true, 'webhooks registered');
    assert.equal(await hookSecretOf(app, id, 'shopify'), SECRET);
    assert.ok(sh.calls.some((c) => c.method === 'POST' && c.url.endsWith('/webhooks.json') && c.json?.webhook?.address === `https://toran.example/hooks/shopify/${id}`));
  } finally {
    await app.db.close();
  }
});
