import { randomInt } from 'node:crypto';
import type { App } from '../app.ts';
import { J } from '../db/index.ts';
import { event } from '../db/log.ts';
import { conversationFor, runTurn } from '../agent/loop.ts';
import { loadProducts, money } from '../agent/tools.ts';
import { makeSlug } from '../leads/store.ts';

// Building a store's pitch: its demo code, its slug, and the sample chat the page
// shows, made by the real agent about one of the store's real products.
//
// The sample chat is the agent's honest work, not a mock: the question is ours (a
// customer's ordinary first question), the answer is what the loop, the tools and the
// guard produced from this store's pack. If the guard had to cut anything or the agent
// handed off, the next product is tried; after three, the answer is built from the
// product row itself, so a page never shows a guess.

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: a code someone may type
export const newCode = () => `DEMO-${Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('')}`;
export const CODE_RE = /DEMO-([A-HJKMNP-Z2-9]{4})\b/i;

export type SampleChat = { role: 'customer' | 'agent'; text: string }[];

/** A product worth showing: in stock, priced, with a picture and a title a customer would say out loud. */
function candidates(products: Awaited<ReturnType<typeof loadProducts>>) {
  const short = (t: string) => t.replace(/[-–|(].*$/, '').trim();
  return products
    .filter((p) => p.available && p.price_min != null && p.image && short(p.title).length >= 4 && short(p.title).length <= 40 && !/gift ?card|כרטיס מתנה|שובר/i.test(p.title))
    .sort((a, b) => Number(b.variants.length > 1) - Number(a.variants.length > 1) || a.title.length - b.title.length);
}

export const shortTitle = (t: string) => t.replace(/[-–|(].*$/, '').replace(/\s+/g, ' ').trim();

export async function buildPitch(app: App, storeId: number, { log = (_: string) => {} }: { log?: (m: string) => void } = {}) {
  const { db } = app;
  const store = await db.one<any>('SELECT id, domain, slug, demo_code, status, config FROM stores WHERE id = $1', [storeId]);
  if (!store) throw new Error('no such store');
  let code = store.demo_code;
  for (let i = 0; !code && i < 20; i++) {
    const c = newCode();
    if (!(await db.one('SELECT 1 FROM stores WHERE demo_code = $1', [c]))) code = c;
  }
  const slug = store.slug || makeSlug(store.domain);
  const products = await loadProducts(db, storeId);
  const picks = candidates(products).slice(0, 3);
  let chat: SampleChat | null = null;
  let productId: number | null = null;
  let from: 'agent' | 'row' = 'agent';
  for (const p of picks) {
    const question = p.variants.length > 1 ? `היי, יש לכם את ${shortTitle(p.title)}? באיזה אפשרויות ובכמה?` : `היי, יש לכם את ${shortTitle(p.title)}? כמה זה עולה?`;
    log(`sample chat: ${shortTitle(p.title)}`);
    const conv = await conversationFor(db, storeId, 'pitch', null);
    try {
      const o = await runTurn(app, { storeId, conversationId: conv, text: question, footer: false });
      if (!o.redactions.length && !o.handoff && o.tools.some((t) => t.name === 'search_products' || t.name === 'get_product')) {
        chat = [
          { role: 'customer', text: question },
          { role: 'agent', text: o.reply },
        ];
        productId = p.id;
        break;
      }
    } catch (e: any) {
      log(`sample chat failed: ${e.message}`);
    }
  }
  if (!chat && picks[0]) {
    // The row itself, said plainly: nothing on the page that the data does not hold.
    const p = picks[0];
    const currency = store.config?.currency || 'ILS';
    chat = [
      { role: 'customer', text: `היי, יש לכם את ${shortTitle(p.title)}? כמה זה עולה?` },
      { role: 'agent', text: `כן, יש במלאי. ${shortTitle(p.title)} עולה ${money(p.price_min, currency)}. רוצים שאשלח קישור?` },
    ];
    productId = p.id;
    from = 'row';
  }
  await db.tx(async (t) => {
    await t.query(
      `INSERT INTO pitches (store_id, product_id, sample_chat, automations, built_at) VALUES ($1, $2, $3::jsonb, '[]'::jsonb, now())
       ON CONFLICT (store_id) DO UPDATE SET product_id = EXCLUDED.product_id, sample_chat = EXCLUDED.sample_chat, built_at = now()`,
      [storeId, productId, J(chat || [])],
    );
    await t.query(`UPDATE stores SET demo_code = $2, slug = $3, page_built_at = now(), status = CASE WHEN status = 'new' THEN 'page_ready' ELSE status END, updated_at = now() WHERE id = $1`, [storeId, code, slug]);
    await event(t, storeId, 'page_built', { productId, sampleFrom: from });
  });
  return { slug, code, productId, chat, from };
}
