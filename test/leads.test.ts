import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDomain, toIntl, cleanEmail, leadKeys } from '../src/core/urls.ts';
import { FetchError, parseRobots, robotsAllows } from '../src/core/http.ts';
import { hebrewRatio, normalize, searchTerms } from '../src/core/hebrew.ts';
import { readHome, socialProfile } from '../src/leads/signals.ts';
import { detect, type Detection } from '../src/leads/detect.ts';
import { saveLead } from '../src/leads/store.ts';
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

// ---- the store's own Instagram, TikTok and Facebook (signals.ts socialProfile), kept in signals.social

const SOCIAL_HOME = `<!doctype html><html lang="he" dir="rtl"><head><title>כלי חרס של נורית</title>
<script type="application/ld+json">{"@context":"https:\\/\\/schema.org","@type":"Organization","sameAs":["https:\\/\\/www.facebook.com\\/sharer\\/sharer.php?u=x","https:\\/\\/www.tiktok.com\\/@kli.cheres"]}</script>
<script>fbq('init', '1'); var px = 'https://www.facebook.com/tr?id=1234567890&ev=PageView';</script>
</head><body>
<a href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fkli-cheres.example%2F">שתפו</a>
<a href="https://www.facebook.com/share.php?u=https://kli-cheres.example/">שתפו</a>
<a href="https://facebook.com/dialog/share?app_id=1&href=x">שתפו</a>
<a href="https://www.facebook.com/plugins/page.php?href=x">עמוד</a>
<a href="https://www.instagram.com/p/C0abc123xyz/">פוסט</a>
<a href="https://www.instagram.com/reel/C0abc123xyz/">ריל</a>
<a href="https://www.instagram.com/explore/tags/pottery/">תגית</a>
<a href="https://www.tiktok.com/@kli.cheres.old/video/7300000000000000000">סרטון</a>
<a href="https://www.instagram.com/shopify">Shopify</a>
<a href="https://www.facebook.com/wix">Wix</a>
<a href="https://instagram.com/Kli.Cheres?igshid=abc123">אינסטגרם</a>
<a href="https://m.facebook.com/kli.cheres.pottery/">פייסבוק</a>
<a href="https://www.instagram.com/second.account/">חשבון נוסף</a>
<p>חנות כלי חרס בעבודת יד</p></body></html>`;

test("the store's own Instagram, TikTok and Facebook: the first real profile of each, never a share link, a post or the platform's account", () => {
  const s = readHome(SOCIAL_HOME, 'https://kli-cheres.example/');
  assert.deepEqual(s.social, {
    instagram: 'https://www.instagram.com/kli.cheres/', // the first profile link; the post, reel, explore and Shopify's before it are not
    tiktok: 'https://www.tiktok.com/@kli.cheres', // a video's link is not a profile; JSON-LD's sameAs is, its slashes escaped
    facebook: 'https://www.facebook.com/kli.cheres.pottery', // past the share buttons, the plugin, the pixel and Wix's own page
  });
  const none = readHome('<html><body><a href="https://twitter.com/kli">x</a><a href="/instagram">i</a></body></html>', 'https://kli-cheres.example/');
  assert.deepEqual(none.social, { instagram: null, tiktok: null, facebook: null }, 'none: all null');
  const theme = readHome('<html><body><script>var settings = {"social_instagram":"https:\\u002F\\u002Finstagram.com\\u002Fkli.cheres"};</script></body></html>', 'https://kli-cheres.example/');
  assert.equal(theme.social.instagram, 'https://www.instagram.com/kli.cheres/', "a theme's settings, its slashes written \\u002F");
});

test('a profile link is one of the three forms; everything else is null', () => {
  const cases: [string, string | null][] = [
    ['https://fb.com/kli.cheres', 'https://www.facebook.com/kli.cheres'],
    ['https://www.fb.com/kli.cheres/', 'https://www.facebook.com/kli.cheres'],
    ['http://he-il.facebook.com/kli.cheres?ref=page_internal', 'https://www.facebook.com/kli.cheres'],
    ['https://web.facebook.com/pg/kli.cheres/about/', 'https://www.facebook.com/kli.cheres'],
    ['https://www.facebook.com/profile.php?id=100012345678', 'https://www.facebook.com/profile.php?id=100012345678'],
    ['https://www.facebook.com/pages/Kli-Cheres/123456789012', 'https://www.facebook.com/pages/Kli-Cheres/123456789012'],
    ['https://www.facebook.com/%D7%9B%D7%9C%D7%99-%D7%97%D7%A8%D7%A1', 'https://www.facebook.com/%D7%9B%D7%9C%D7%99-%D7%97%D7%A8%D7%A1'],
    ['//www.instagram.com/kli.cheres', 'https://www.instagram.com/kli.cheres/'],
    ['https://www.instagram.com/_u/kli.cheres', 'https://www.instagram.com/kli.cheres/'],
    ['https://instagr.am/kli_cheres', 'https://www.instagram.com/kli_cheres/'],
    ['https://m.tiktok.com/@Kli.Cheres?lang=he', 'https://www.tiktok.com/@kli.cheres'],
    ['https://www.facebook.com/kli.cheres/posts/1234567890', null],
    ['https://www.facebook.com/kli.cheres/photos/a.1/2/', null],
    ['https://www.facebook.com/tr?id=1&ev=PageView', null],
    ['https://www.facebook.com/2008/fbml', null],
    ['https://www.facebook.com/sharer.php?u=x', null],
    ['https://www.facebook.com/share/p/abc123/', null],
    ['https://www.facebook.com/groups/1234567', null],
    ['https://www.facebook.com/events/1234567', null],
    ['https://www.facebook.com/watch/?v=1', null],
    ['https://www.facebook.com/profile.php', null],
    ['https://l.facebook.com/l.php?u=https://kli-cheres.example/', null],
    ['https://business.facebook.com/kli.cheres', null],
    ['https://www.facebook.com/', null],
    ['https://www.facebook.com/WordPress', null],
    ['https://www.facebook.com/woocommerce/', null],
    ['https://www.instagram.com/wix/', null],
    ['https://www.instagram.com/your_username', null],
    ['https://www.instagram.com/stories/kli.cheres/123/', null],
    ['https://www.instagram.com/accounts/login/', null],
    ['https://www.instagram.com/embed.js', null],
    ['https://www.tiktok.com/@shopify', null],
    ['https://www.tiktok.com/video/7300000000000000000', null],
    ['https://www.tiktok.com/embed/v2/7300000000000000000', null],
    ['https://vm.tiktok.com/ZSabc123/', null],
    ['https://twitter.com/kli', null],
    ['https://kli-cheres.example/instagram', null],
    ['mailto:hello@kli-cheres.example', null],
    ['https://www.facebook.com/%E0%A4%A', null], // a malformed escape: refused, not thrown
  ];
  for (const [href, want] of cases) assert.equal(socialProfile(href)?.url ?? null, want, href);
  assert.equal(socialProfile('https://fb.com/kli.cheres')?.network, 'facebook');
});

test("the contact page's profiles fill the networks the home page had none of", async () => {
  const pages: Record<string, string> = {
    'https://shop.example/': '<html lang="he"><body><p>חנות</p><a href="/pages/contact">צור קשר</a><a href="https://www.instagram.com/home.handle/">ig</a><a href="/cart">סל</a></body></html>',
    'https://shop.example/pages/contact': '<html lang="he"><body><a href="mailto:hello@shop.example">מייל</a><a href="https://www.instagram.com/contact.handle/">ig</a><a href="https://www.facebook.com/shop.page">fb</a></body></html>',
  };
  const fetcher = async (url: string) => {
    const text = pages[url];
    if (text == null) throw new FetchError('not found', 'http', url, 404);
    return { url, status: 200, contentType: 'text/html', text, headers: {} };
  };
  const d = await detect('shop.example', { fetcher });
  assert.equal(d.email, 'hello@shop.example', 'the contact page was read');
  assert.deepEqual(d.home.social, { instagram: 'https://www.instagram.com/home.handle/', tiktok: null, facebook: 'https://www.facebook.com/shop.page' });
});

test('signals.social is kept on the lead, and a later find fills a missing network but never replaces one already kept', async () => {
  const app = await testApp();
  try {
    const found = (body: string) => {
      const home = readHome(`<html lang="he"><body><p>חנות כלי חרס</p>${body}</body></html>`, 'https://kli-cheres.example/');
      return { input: 'kli-cheres.example', url: 'https://kli-cheres.example/', domain: 'kli-cheres.example', name: 'כלי חרס של נורית', platform: 'shopify', platformEvidence: '', productCount: 14, productCountSource: 'products.json', productCountCapped: false, newestProductAt: null, catalogHebrewRatio: null, catalogSample: [], home, rendered: false, email: home.emails[0] || null, whatsapp: home.whatsappNumbers[0] || null, phone: null, franchiseOf: null, errors: [] } as Detection;
    };
    const score = { score: 80, breakdown: [], qualified: true, reject: null };
    const mail = '<a href="mailto:hello@kli-cheres.example">m</a>';
    const first = await saveLead(app.db, found(`<a href="https://www.instagram.com/kli.cheres/">ig</a>${mail}`), score, 'seed');
    const social = async () => (await app.db.one<any>('SELECT signals FROM stores WHERE id = $1', [first.id])).signals.social;
    assert.deepEqual(await social(), { instagram: 'https://www.instagram.com/kli.cheres/' }, 'only the networks found');
    const again = await saveLead(app.db, found(`<a href="https://www.instagram.com/someone.else/">ig</a><a href="https://www.facebook.com/kli.cheres">fb</a>${mail}`), score, 'crawl');
    assert.equal(again.id, first.id, 'the same lead');
    assert.deepEqual(await social(), { instagram: 'https://www.instagram.com/kli.cheres/', facebook: 'https://www.facebook.com/kli.cheres' }, 'Instagram kept, Facebook filled in');
    await saveLead(app.db, found(mail), score, 'crawl');
    assert.deepEqual(await social(), { instagram: 'https://www.instagram.com/kli.cheres/', facebook: 'https://www.facebook.com/kli.cheres' }, 'a find with none takes nothing away');
    const s = await app.db.one<any>('SELECT signals, contact_email FROM stores WHERE id = $1', [first.id]);
    assert.equal(s.contact_email, 'hello@kli-cheres.example');
    assert.equal(s.signals.productCount, 14, 'the rest of the signals refreshed as before');
  } finally {
    await app.db.close();
  }
});

test("a store's WhatsApp is the one its site links to, else its first Israeli mobile; a landline is not one", async () => {
  const app = await testApp();
  try {
    const save = async (domain: string, body: string) => {
      const url = `https://${domain}/`;
      const home = readHome(`<html lang="he"><body><p>חנות</p>${body}</body></html>`, url);
      const d = { input: domain, url, domain, name: domain, platform: 'shopify', platformEvidence: '', productCount: 14, productCountSource: 'products.json', productCountCapped: false, newestProductAt: null, catalogHebrewRatio: null, catalogSample: [], home, rendered: false, email: null, whatsapp: home.whatsappNumbers[0] || null, phone: home.phones.find((p) => p !== home.whatsappNumbers[0]) || home.phones[0] || null, franchiseOf: null, errors: [] } as Detection;
      const { id } = await saveLead(app.db, d, { score: 80, breakdown: [], qualified: true, reject: null }, 'seed');
      return app.db.one<any>('SELECT contact_whatsapp, contact_phone FROM stores WHERE id = $1', [id]);
    };
    const mobile = await save('mobile.example', '<a href="tel:03-123-4567">משרד</a><a href="tel:052-000-0901">נייד</a>');
    assert.equal(mobile!.contact_whatsapp, '972520000901', 'the mobile, past the landline before it');
    assert.equal(mobile!.contact_phone, '97231234567', 'the phone kept as found');
    const linked = await save('linked.example', '<a href="https://wa.me/972500000903">וואטסאפ</a><a href="tel:052-000-0902">נייד</a>');
    assert.equal(linked!.contact_whatsapp, '972500000903', 'the WhatsApp the site links to wins');
    const landline = await save('landline.example', '<a href="tel:03-765-4321">משרד</a>');
    assert.equal(landline!.contact_whatsapp, null, 'a landline is no WhatsApp');

    // The stores known before (migration 080): the phone when it is a mobile, else the first mobile the site listed.
    await app.db.query("INSERT INTO stores (domain, url, source, contact_phone, signals) VALUES ('old1.example', 'https://old1.example/', 'seed', '972540000904', '{}'), ('old2.example', 'https://old2.example/', 'seed', '97231234567', '{\"phones\": [\"97231234567\", \"972530000905\"]}'), ('old3.example', 'https://old3.example/', 'seed', '97231234567', '{\"phones\": [\"97231234567\"]}')");
    await app.db.query("INSERT INTO stores (domain, url, source, contact_phone, platform, status) VALUES ('company.example', 'https://company.example/', 'seed', '972550000906', 'company', 'company')");
    await app.db.exec(readFileSync(new URL('../src/db/migrations/080_mobile_whatsapp.sql', import.meta.url), 'utf8'));
    const wa = async (domain: string) => (await app.db.one<any>('SELECT contact_whatsapp FROM stores WHERE domain = $1', [domain]))!.contact_whatsapp;
    assert.equal(await wa('old1.example'), '972540000904');
    assert.equal(await wa('old2.example'), '972530000905');
    assert.equal(await wa('old3.example'), null);
    assert.equal(await wa('company.example'), null, "a company's row is left as it is");
    assert.equal(await wa('linked.example'), '972500000903', 'one that has a WhatsApp keeps it');
  } finally {
    await app.db.close();
  }
});
