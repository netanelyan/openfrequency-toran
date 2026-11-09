import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The desk's look, one of two (the owner, 2026-11-09: "make both dashboard look more professional. research. shopify
// is a good example. save the current style so i will be able to revert if i dont like the new"). docs/design-pro.md
// has the brief and the way back.
//
//   glass  static/style.css alone: Apple's frosted glass over the silver wallpaper, exactly the look the desk had on
//          2026-11-09 (git tag style-glass-2026-11-09). The file is never edited for the new look.
//   pro    static/style.css, then static/style-pro.css after it in the same response: solid surfaces, 1px borders,
//          small radii, a Shopify-admin side bar, one accent (Toran's green). The pro file only overrides, so every
//          page a later change adds to style.css is styled in both looks, and going back is one setting.
//
// TORAN_STYLE in private/.env picks it, pro unless it says glass; the server reads it once, as it starts. Both go out
// at the one address, /static/style.css, so no page's <head> changes with the look. A browser keeps the file for an
// hour, but every page asks for it with ?v= of the server's start, so a restart after a change is seen at once.

export type StyleName = 'glass' | 'pro';

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');

/** The look a server runs with: glass only when TORAN_STYLE says exactly that, pro otherwise. */
export const styleOf = (env: Record<string, string | undefined>): StyleName => (String(env.TORAN_STYLE || '').trim().toLowerCase() === 'glass' ? 'glass' : 'pro');

/** The stylesheet at /static/style.css for a look: the glass file as it is, or the glass file and the pro layer after it. */
export function styleSheet(style: StyleName): Buffer {
  const base = readFileSync(path.join(STATIC, 'style.css'));
  if (style === 'glass') return base;
  return Buffer.concat([base, Buffer.from('\n\n'), readFileSync(path.join(STATIC, 'style-pro.css'))]);
}
