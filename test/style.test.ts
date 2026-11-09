import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleOf, styleSheet } from '../src/web/style.ts';
import { layout } from '../src/web/ui.ts';

// The desk's two looks (src/web/style.ts, docs/design-pro.md; the owner, 2026-11-09: "make both dashboard look more
// professional ... save the current style so i will be able to revert if i dont like the new"): pro unless
// TORAN_STYLE=glass; glass is style.css as it is, pro is style.css with style-pro.css after it, at the same address.

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'static');
const glass = readFileSync(path.join(STATIC, 'style.css'), 'utf8');
const pro = readFileSync(path.join(STATIC, 'style-pro.css'), 'utf8');

test('the look is pro unless TORAN_STYLE says glass', () => {
  assert.equal(styleOf({}), 'pro');
  assert.equal(styleOf({ TORAN_STYLE: '' }), 'pro');
  assert.equal(styleOf({ TORAN_STYLE: 'pro' }), 'pro');
  assert.equal(styleOf({ TORAN_STYLE: ' Glass ' }), 'glass');
  assert.equal(styleOf({ TORAN_STYLE: 'something else' }), 'pro', 'a typo keeps the default');
});

test('glass is style.css exactly as it is; pro is style.css with the pro layer after it, so the layer wins', () => {
  assert.equal(styleSheet('glass').toString('utf8'), glass);
  const both = styleSheet('pro').toString('utf8');
  assert.ok(both.startsWith(glass), 'the glass file first, untouched');
  assert.ok(both.endsWith(pro), 'the pro layer last');
});

test('the pro layer: solid, the brief\'s tokens, dark on the attribute only, page margins kept', () => {
  // Nothing blurred: every backdrop-filter in the layer turns the glass's off.
  for (const m of pro.matchAll(/backdrop-filter:\s*([^;]+);/g)) assert.equal(m[1].trim(), 'none', m[0]);
  assert.doesNotMatch(pro, /prefers-color-scheme/, 'dark is the reader\'s choice (theme.ts), never the device\'s');
  assert.match(pro, /:root \{\n  color-scheme: light;[^}]*\n  --bg: #eeeff2;/, 'the page the colour of the browser bar (theme.ts THEME_COLOR)');
  assert.match(pro, /:root\[data-theme="dark"\] \{\n  color-scheme: dark;\n  --bg: #111113;/);
  assert.match(pro, /--accent-fill: #0f7a54;/, 'one accent, Toran\'s green');
  assert.match(pro, /--r: 12px;\n  --r-m: 8px;/, 'a card 12px, a control 8px');
  // The accessibility panel's high contrast is on html.a-contrast in style.css, more specific than the layer's :root.
  assert.match(glass, /\nhtml\.a-contrast \{ --ink-2:/);
  assert.doesNotMatch(pro.replace(/\/\*[^]*?\*\//g, ''), /html\.a-contrast/, 'no rule of the layer outranks it');
  // A margin a page asks for (.mt24 on a group) outlives the layer's own margins: the utilities come last.
  const utils = pro.lastIndexOf('.mt24 { margin-top: 24px; }');
  assert.ok(utils > pro.lastIndexOf('.group {'), '.mt24 after .group');
});

test('the spark beside "לעוזר" is drawn in the middle of its square, so the label sits on its centre', () => {
  const page = layout({ title: 't', csrf: 'c' }, '');
  assert.ok(page.includes('<symbol id="i-spark" viewBox="0 0 24 24"><path d="M12 5l1.9 5.5L19.5 12l-5.6 1.6L12 19l-1.9-5.4L4.5 12l5.6-1.5z"/>'));
});
