import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast } from '../src/ingest/brand.ts';
import { colorOf, cssLinks, lookCss, lookOf, readPalette, readableOn } from '../src/ingest/palette.ts';
import { customer } from './helpers.ts';
import { serve } from './serve.ts';

// The chat on the store's site in the site's own look (the owner, 2026-11-09: "design the website widget better. make
// it according to the website's colors"): the colours, corner and type read from the site at ingest, every text pair at
// 4.5:1 whatever was found, a calm neutral look when nothing was, the owner's own colour and light or dark over it, and
// the chat's script and frame still served as before.

const page = (head: string, body = '') => `<!doctype html><html lang="he"><head><title>חנות</title>${head}</head><body>${body}</body></html>`;

test('a Shopify Dawn-like theme: the button colour, its text, the page, the corner and the body font', () => {
  const html = page(`<meta name="theme-color" content="#ffffff">
<style>
  @font-face { font-family: Assistant; font-weight: 400; src: url("//shop.example/cdn/fonts/assistant.woff2") format("woff2"); }
  :root, .color-scheme-1 { --color-background: 246,244,238; --color-foreground: 20,40,30; --color-button: 24,74,52; --color-button-text: 255,255,255; --color-link: 24,74,52; }
  .color-scheme-2 { --color-background: 24,74,52; --color-button: 255,255,255; }
  :root { --font-body-family: Assistant, sans-serif; --buttons-radius: 0px; }
</style>`);
  const p = readPalette(html, 'https://green-shop.example/');
  assert.equal(p.from, 'shopify', 'a white theme-color is the toolbar, not the button');
  assert.equal(p.primary, '#184a34');
  assert.equal(p.onPrimary, '#ffffff');
  assert.equal(p.background, '#f6f4ee');
  assert.equal(p.text, '#14281e');
  assert.equal(p.radius, 0);
  assert.equal(p.font, 'Assistant', 'loaded by the page itself (its @font-face)');
  const l = lookOf({ palette: p });
  assert.equal(l.primary, '#184a34');
  assert.equal(l.bg, '#f6f4ee');
  assert.equal(l.dark, false);
  assert.equal(l.rLaunch, '18px', 'a square site gets a squarer button');
  assert.ok(l.rBubble <= 8);
});

test('a WordPress block theme with WooCommerce: the presets, and the add-to-cart rule in the theme\'s sheet', () => {
  const html = page(`<link rel="stylesheet" href="https://pink.example/wp-content/themes/boutique/style.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700">
<link rel="stylesheet" href="https://cdn.other.example/slick.css">
<style id="global-styles-inline-css">:root{--wp--preset--color--base:#fff8fb;--wp--preset--color--contrast:#2b1d24;--wp--preset--color--primary:#d63384;--wp--preset--color--secondary:#6f42c1;--wp--preset--font-family--body:"Heebo", sans-serif;}</style>`);
  const sheet = '.woocommerce .single_add_to_cart_button { background-color: var(--wp--preset--color--primary); color: #fff; border-radius: 30px; } .single_add_to_cart_button:hover { background-color: #000 }';
  assert.deepEqual(cssLinks(html, 'https://pink.example/'), ['https://pink.example/wp-content/themes/boutique/style.css'], 'the theme\'s own sheet, not fonts or another site');
  const p = readPalette(html, 'https://pink.example/', [sheet]);
  assert.equal(p.from, 'wordpress');
  assert.equal(p.primary, '#d63384');
  assert.equal(p.background, '#fff8fb');
  assert.equal(p.text, '#2b1d24');
  assert.equal(p.accent, '#6f42c1');
  assert.equal(p.radius, 30, 'from the add-to-cart button');
  assert.equal(p.font, 'Heebo');
  const l = lookOf({ palette: p });
  assert.equal(l.rCtl, 999, 'a pill site gets a pill field');
  assert.ok(contrast(l.onPrimary, l.primary) >= 4.5);
});

test('Elementor\'s own default colours are not the store\'s; a primary button rule is', () => {
  const html = page('<style>.elementor-kit-7{--e-global-color-primary:#6EC1E4;--e-global-color-accent:#61CE70;--e-global-color-text:#7A7A7A;} .btn-primary{background-color:#0a7d5a;color:#ffffff;border-radius:4px} .btn-primary:hover{background-color:#000}</style>');
  const p = readPalette(html, 'https://el.example/');
  assert.equal(p.primary, '#0a7d5a');
  assert.equal(p.from, 'button');
  assert.equal(p.radius, 4);
  assert.equal(p.text, null);
});

test('a plain site with a theme-color and a body rule', () => {
  const html = page('<meta name="theme-color" content="#e0457b"><style>body { background: #fff0f5; color: #3a2a30; font-family: Georgia, serif }</style>');
  const p = readPalette(html, 'https://boutique.example/');
  assert.deepEqual({ primary: p.primary, from: p.from, background: p.background, text: p.text, font: p.font }, { primary: '#e0457b', from: 'theme-color', background: '#fff0f5', text: '#3a2a30', font: 'Georgia' });
});

test('a dark site makes a dark chat; a font the page does not load is not named', () => {
  const html = page('<meta name="color-scheme" content="dark"><style>body{background-color:#0d0d0f;color:#ececec;font-family:"Made Up Sans",sans-serif} header{background:#0d0d0f}</style>');
  const p = readPalette(html, 'https://night.example/');
  assert.equal(p.background, '#0d0d0f');
  assert.equal(p.font, null);
  const l = lookOf({ palette: p, colors: ['#7c5cff'] });
  assert.equal(l.dark, true);
  assert.equal(l.bg, '#0d0d0f');
  assert.ok(contrast(l.text, l.bg) >= 4.5 && contrast(l.text, l.surface) >= 4.5);
  assert.match(lookCss(l), /--scheme:dark/);
});

test('nothing on the site: every field null, and a calm neutral look', () => {
  const p = readPalette(page('', '<p>שלום</p>'), 'https://empty.example/');
  assert.deepEqual(Object.values(p).filter((x) => x !== null), []);
  const l = lookOf({ palette: p });
  assert.equal(l.from, 'none');
  assert.equal(l.primary, '#2c2c30');
  assert.equal(l.bg, '#ffffff');
  assert.equal(l.onPrimary, '#ffffff');
  const css = lookCss(lookOf({}));
  assert.match(css, /^:root\{--p:#2c2c30;--on-p:#ffffff;--bg:#ffffff;/);
});

test('every text pair reads at 4.5:1, whatever the site gave: yellow, pink, pale grey text, and a hundred random colours', () => {
  const yellow = lookOf({ palette: { primary: '#ffd400' } });
  assert.equal(yellow.onPrimary, '#111114', 'dark text on a light button');
  const pink = lookOf({ palette: { primary: '#e0457b', onPrimary: '#ffffff' } });
  assert.ok(contrast(pink.onPrimary, pink.primary) >= 4.5, 'the site\'s white on pink does not read, so it changes');
  const pale = lookOf({ palette: { text: '#999999', accent: '#ffd400' } });
  assert.ok(contrast(pale.text, pale.bg) >= 4.5 && contrast(pale.text, pale.surface) >= 4.5);
  assert.ok(contrast(pale.accent, pale.surface) >= 4.5);
  assert.ok(contrast(readableOn('#777777', '#808080'), '#808080') >= 4.5, 'a grey on a grey ends at black or white');

  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const hex = () => `#${[0, 0, 0].map(() => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join('')}`;
  for (let i = 0; i < 100; i++) {
    const l = lookOf({ palette: { primary: hex(), onPrimary: hex(), background: hex(), text: hex(), accent: hex(), radius: Math.floor(rnd() * 60) }, choice: { mode: (['site', 'light', 'dark'] as const)[i % 3] } });
    const pairs: [string, string, string][] = [['onPrimary/primary', l.onPrimary, l.primary], ['text/bg', l.text, l.bg], ['text/surface', l.text, l.surface], ['muted/bg', l.muted, l.bg], ['accent/surface', l.accent, l.surface], ['ink/surface', l.ink, l.surface], ['ink/bg', l.ink, l.bg]];
    for (const [name, a, b] of pairs) assert.ok(contrast(a, b) >= 4.5, `${name} ${a} on ${b}: ${contrast(a, b).toFixed(2)}`);
    assert.ok(contrast(l.primary, l.bg) >= 1.5, 'the button never vanishes into the page');
  }
});

test('colours as sites write them, and nothing a site wrote reaches the CSS as it was', () => {
  assert.equal(colorOf('rgb(24 74 52 / 100%)'), '#184a34');
  assert.equal(colorOf('rgba(0,0,0,0)'), null);
  assert.equal(colorOf('#11223340'), null, 'mostly see-through');
  assert.equal(colorOf('hsl(330, 70%, 57%)'), '#de4591');
  assert.equal(colorOf('18, 18, 18'), '#121212');
  assert.equal(colorOf('red;} body{display:none'), null);
  const p = readPalette(page('<style>:root{--font-body-family:"Evil\'; } body { x";--color-button:1,2,3}</style>'), 'https://x.example/');
  assert.equal(p.font, null);
  assert.doesNotMatch(lookCss(lookOf({ palette: { font: "x'}body{" } })), /body\{/);
});

test('the site read keeps the look in the store\'s brand, and the chat\'s theme.css is drawn from it', async () => {
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    const brand = (await s.app.db.one<{ brand: any }>('SELECT brand FROM stores WHERE id = $1', [id]))!.brand;
    assert.equal(brand.palette.primary, '#b4532a', 'the example store\'s theme-color');
    assert.equal(brand.palette.from, 'theme-color');
    assert.equal(brand.palette.text, '#121212', 'its Shopify --color-foreground');
  } finally {
    await s.close();
  }
});

test('the owner picks another colour and dark: saved on the chat, the frame and its preview follow, the line still serves', async () => {
  const s = await serve();
  try {
    const id = s.seeded.storeId;
    await s.app.db.query('UPDATE stores SET workspace_id = 1 WHERE id = $1', [id]);
    s.as(s.accounts.session(customer(1)).cookie);
    await s.post(`/lead/${id}/web`, { _csrf: await s.csrf('/settings'), do: 'on' });
    const key = (await s.app.db.one<{ external_id: string }>("SELECT external_id FROM channel_accounts WHERE store_id = $1 AND channel = 'web'", [id]))!.external_id;

    const settings = await (await s.get('/settings')).text();
    assert.match(settings, /איך הצ׳אט נראה[^]*כמו באתר שלכם[^]*הצבעים שמצאנו באתר[^]*fill="#b4532a"[^]*צבע אחר[^]*type="color"[^]*עוד אפשרויות[^]*כהה/);
    assert.match(settings, /name="use" value="site" checked/, 'as on the site, by default');
    assert.match(settings, new RegExp(`<iframe id="look-${id}" src="/lead/${id}/web/preview\\?use=site`));
    // Saving the look is a plain button: Settings has one main button, a card's next step (the audit of 2026-11-12, P1-11).
    assert.doesNotMatch(settings, /class="btn primary sm" type="submit">לשמור</);
    assert.match(settings, /data-look="#look-\d+">[^]*class="btn sm" type="submit">לשמור</);

    // The frame as it was, in the site's colour: the header says who answers, never how fast.
    let theme = await (await s.get(`/w/${key}/theme.css`)).text();
    assert.match(theme, /--p:#b4532a;--on-p:#ffffff;/);
    const frame = await (await s.get(`/w/${key}/frame`)).text();
    assert.match(frame, /הבוט של החנות/);
    assert.doesNotMatch(frame, /תוך רגע|תוך דקה/);
    assert.match(frame, /role="dialog" aria-modal="true"/);
    assert.match(frame, /class="c-chip"/);
    assert.match(frame, new RegExp(`/w/${key}/theme\\.css\\?v=\\w+`));

    const res = await s.post(`/lead/${id}/web`, { _csrf: await s.csrf('/settings'), do: 'look', use: 'own', color: '#123456', mode: 'dark' });
    assert.equal(res.status, 303);
    const meta = (await s.app.db.one<{ meta: any }>("SELECT meta FROM channel_accounts WHERE store_id = $1 AND channel = 'web'", [id]))!.meta;
    assert.deepEqual(meta.look, { color: '#123456', mode: 'dark' });
    assert.ok(meta.domains.length, 'the rest of the chat\'s settings kept');
    theme = await (await s.get(`/w/${key}/theme.css`)).text();
    assert.match(theme, /--scheme:dark/);
    const l = /--p:(#[0-9a-f]{6});--on-p:(#[0-9a-f]{6})/.exec(theme)!;
    assert.ok(contrast(l[2], l[1]) >= 4.5);
    assert.match(await (await s.get('/settings')).text(), /name="use" value="own" checked/);

    // A colour that is not one keeps the site's.
    await s.post(`/lead/${id}/web`, { _csrf: await s.csrf('/settings'), do: 'look', use: 'own', color: 'red;}', mode: 'nope' });
    assert.deepEqual((await s.app.db.one<{ meta: any }>("SELECT meta FROM channel_accounts WHERE store_id = $1 AND channel = 'web'", [id]))!.meta.look, { color: null, mode: 'site' });

    // The preview: framed only by our own pages, its look from the query.
    const pv = await s.get(`/lead/${id}/web/preview?use=own&color=%23e0457b&mode=light`);
    assert.equal(pv.status, 200);
    assert.match(String(pv.headers.get('content-security-policy')), /frame-ancestors 'self'/);
    assert.equal(pv.headers.get('x-frame-options'), 'SAMEORIGIN');
    const pvHtml = await pv.text();
    assert.match(pvHtml, /class="pv side-left"/);
    assert.ok(pvHtml.includes(`/lead/${id}/web/look.css?use=own&amp;color=%23e0457b&amp;mode=light`) || pvHtml.includes(`/lead/${id}/web/look.css?use=own&color=%23e0457b&mode=light`));
    const css = await (await s.get(`/lead/${id}/web/look.css?use=own&color=%23e0457b&mode=light`)).text();
    assert.match(css, /--scheme:light/);
    // Another workspace's store: not found.
    assert.equal((await s.get(`/lead/999999/web/preview`)).status, 404);

    // The line on the store's site serves as before.
    const loader = await (await s.get(`/w/${key}.js`)).text();
    assert.ok(loader.includes('window.__toranChat') && loader.includes('data-toran-reviews') && loader.includes("'toran:open'"));
    assert.doesNotMatch(loader, /document\.cookie|localStorage/);
  } finally {
    await s.close();
  }
});
