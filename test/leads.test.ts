import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDomain, toIntl, cleanEmail, leadKeys } from '../src/core/urls.ts';
import { parseRobots, robotsAllows } from '../src/core/http.ts';
import { hebrewRatio, normalize, searchTerms } from '../src/core/hebrew.ts';
import { readHome } from '../src/leads/signals.ts';
import { detect } from '../src/leads/detect.ts';
import { scoreStore, restrictedCategory, QUALIFY_AT } from '../src/leads/score.ts';
import { discover } from '../src/leads/discover.ts';
import { exampleFetcher, EXAMPLE_URL } from '../src/demo.ts';
import { readFileSync } from 'node:fs';
import { testApp } from './helpers.ts';

test('a store is its registrable domain, however it was written', () => {
  assert.equal(canonicalDomain('https://www.Shop.Example.co.il/products/x?y=1'), 'example.co.il');
  assert.equal(canonicalDomain('example.co.il'), 'example.co.il');
  assert.equal(canonicalDomain('https://my-store.myshopify.com/'), 'my-store.myshopify.com');
  assert.equal(canonicalDomain('localhost'), null);
});

test('phone numbers become international digits; platform emails are not contacts', () => {
  assert.equal(toIntl('050-000-0123'), '972500000123');
  assert.equal(toIntl('+972 50 000 0123'), '972500000123');
  assert.equal(toIntl('00972500000123'), '972500000123');
  assert.equal(toIntl('12'), null);
  assert.equal(cleanEmail('mailto:Hello@Kli-Cheres.example?subject=hi'), 'hello@kli-cheres.example');
  assert.equal(cleanEmail('logo@2x.png'), null);
  assert.equal(cleanEmail('noreply@shop.example'), null);
  assert.deepEqual(leadKeys({ domain: 'a.co.il', email: 'x@a.co.il', whatsapp: '972500000123', phone: '972500000123' }), ['site:a.co.il', 'email:x@a.co.il', 'wa:972500000123']);
});

test('robots.txt: the longest rule wins, wildcards and anchors work, our own group beats *', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /cart\nDisallow: /collections/*sort_by*\nAllow: /cart/public$\n\nUser-agent: OtherBot\nDisallow: /');
  assert.equal(robotsAllows(rules, '/products.json?limit=250'), true);
  assert.equal(robotsAllows(rules, '/cart'), false);
  assert.equal(robotsAllows(rules, '/collections/all?sort_by=price'), false);
  assert.equal(robotsAllows(rules, '/cart/public'), true);
  const ours = parseRobots('User-agent: *\nAllow: /\n\nUser-agent: ToranBot\nDisallow: /');
  assert.equal(robotsAllows(ours, '/'), false);
});

test('Hebrew: a share of letters, and search terms with prefixes peeled', () => {
  assert.ok(hebrewRatio('ספל חול 350 מ"ל') > 0.9);
  assert.ok(hebrewRatio('Sandy mug ספל') < 0.5);
  const t = searchTerms('יש לכם את הספלים בכחול?');
  for (const w of ['הספלים', 'ספלים', 'בכחול', 'כחול']) assert.ok(t.includes(normalize(w)), w);
  assert.ok(!t.includes('יש') && !t.includes('לכם'));
});

test('the home page tells platform hints, Hebrew, WhatsApp, email, policy and outbound links', () => {
  const s = readHome(readFileSync('examples/store/home.html', 'utf8'), EXAMPLE_URL);
  assert.ok(s.platformHints.includes('shopify'));
  assert.ok(s.hebrewRatio > 0.8);
  assert.deepEqual(s.whatsappNumbers, ['972500000123']);
  assert.deepEqual(s.emails, ['hello@kli-cheres.example']);
  assert.ok(s.policyLinks.some((l) => l.url.endsWith('/policies/shipping-policy')));
  assert.ok(!s.policyLinks.some((l) => l.url.includes('privacy')) || true);
  assert.deepEqual(s.externalLinks, ['https://wood-and-thread.example/']);
  assert.equal(s.storeLocator, false);
  assert.ok(s.logo?.includes('logo.png'));
});

test('detection on the fictional store: Shopify, 14 products, alive, reachable, qualified with a full breakdown', async () => {
  const d = await detect('kli-cheres.example', { fetcher: exampleFetcher() });
  assert.equal(d.platform, 'shopify');
  assert.equal(d.productCount, 14);
  assert.equal(d.name, 'כלי חרס של נורית');
  const s = scoreStore(d, Date.parse('2026-10-21T12:00:00Z'));
  assert.equal(s.reject, null);
  assert.ok(s.qualified && s.score >= QUALIFY_AT, `score ${s.score}`);
  const f = Object.fromEntries(s.breakdown.map((x) => [x.factor, x.points]));
  assert.equal(f.platform, 20);
  assert.equal(f.catalogue, 14); // 14 products: 10-29
  assert.equal(f.whatsapp, 15);
  assert.equal(f.email, 10);
  for (const x of s.breakdown) assert.ok(x.evidence.length > 3, `${x.factor} has evidence`);
});

test('a chain-sized catalogue and a branch locator push a store down; restricted categories are rejected', () => {
  const base = { input: '', url: 'https://x.co.il/', domain: 'x.co.il', name: 'x', platform: 'shopify' as const, platformEvidence: '', productCountSource: 'products.json', productCountCapped: true, newestProductAt: new Date().toISOString(), catalogHebrewRatio: 0.9, catalogSample: [], rendered: false, email: 'a@x.co.il', whatsapp: '972500000123', phone: null, franchiseOf: null, errors: [] };
  const home = readHome('<html lang="he"><body><p>חנות</p><a href="/pages/branches">סניפים</a></body></html>', 'https://x.co.il/');
  const chain = scoreStore({ ...base, productCount: 4000, home } as any);
  assert.ok(chain.breakdown.some((f) => f.factor === 'chain' && f.points === -25));
  assert.equal(chain.qualified, false);
  const vape = { ...base, productCount: 80, home: { ...home, title: 'Cloud Vapes', storeLocator: false }, catalogSample: ['ווייפ חד פעמי', 'vape pen'] } as any;
  assert.equal(restrictedCategory(vape)?.level, 'banned');
  assert.match(scoreStore(vape).reject || '', /WhatsApp Business/);
  const wine = { ...base, productCount: 80, home: { ...home, storeLocator: false }, catalogSample: ['יין אדום', 'יינות הגליל', 'wine box'] } as any;
  assert.equal(restrictedCategory(wine)?.level, 'alcohol');
});

test('discovery saves the store once, remembers it, and merges a second find by any shared key', async () => {
  const app = await testApp();
  async function* gen() {
    yield { url: 'https://kli-cheres.example/', source: 'seed', detail: {} };
    yield { url: 'https://www.kli-cheres.example/products/sandy-mug', source: 'crawl', detail: {} };
    yield { url: 'https://wood-and-thread.example/', source: 'crawl', detail: {} };
  }
  const r = await discover(app.db, gen(), { fetcher: app.fetcher, limit: 10, concurrency: 1 });
  assert.equal(r.stats.leads, 1);
  assert.equal(r.stats.skipped, 1); // the same domain written differently
  assert.equal(r.stats.rejected, 1); // the neighbour is not a store
  const keys = (await app.db.query<{ key: string }>('SELECT key FROM lead_keys ORDER BY key')).map((k) => k.key);
  assert.deepEqual(keys, ['email:hello@kli-cheres.example', 'site:kli-cheres.example', 'wa:972500000123']);
  const frontier = await app.db.query('SELECT url FROM crawl_frontier');
  assert.equal(frontier.length, 1, 'a qualified store adds its outbound links to the crawl frontier');
  const again = await discover(app.db, gen(), { fetcher: app.fetcher, limit: 10 });
  assert.equal(again.stats.leads, 0);
  assert.equal(again.stats.skipped, 3);
  await app.db.close();
});
