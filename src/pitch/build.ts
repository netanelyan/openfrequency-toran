import { randomInt } from 'node:crypto';
import type { App } from '../app.ts';
import { J } from '../db/index.ts';
import { event } from '../db/log.ts';
import { conversationFor, runTurn, type TurnOutput } from '../agent/loop.ts';
import { isFee, loadProducts } from '../agent/tools.ts';
import { makeSlug } from '../leads/store.ts';

// Building a store's pitch: its demo code, its slug, and the sample chat the page
// shows, made by the real agent about one of the store's real products.
//
// The sample chat is two customer questions and two answers, one conversation, about
// one real product that is in stock. The questions are ours (what a customer asks
// first: is it there and what does it cost, then how long delivery takes, or whether
// it comes in another option, or whether it can be returned). The answers are what the
// loop, the tools and the guard produced from this store's pack, untouched.
//
// An answer that handed off or that the guard had to cut is not shown: the next second
// question is tried, then the next product. After that the page has no sample chat, and
// it waits in the review queue with that gap (pitch/ready.ts). There is no fallback
// built from a product row: a page shows what the agent really said, or nothing.

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: a code someone may type
export const newCode = () => `DEMO-${Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('')}`;
export const CODE_RE = /DEMO-([A-HJKMNP-Z2-9]{4})\b/i;

export type SampleChat = { role: 'customer' | 'agent'; text: string }[];

export const shortTitle = (t: string) => t.replace(/[-–|(].*$/, '').replace(/\s+/g, ' ').trim();

type Product = Awaited<ReturnType<typeof loadProducts>>[number];

/** A product worth showing: in stock, priced, with a picture and a title a customer would say out loud. */
function candidates(products: Product[]) {
  return products
    .filter((p) => p.available && p.price_min != null && p.image && shortTitle(p.title).length >= 4 && shortTitle(p.title).length <= 40 && !/gift ?card|כרטיס מתנה|שובר/i.test(p.title) && !isFee(p.title))
    .sort((a, b) => Number(b.variants.length > 1) - Number(a.variants.length > 1) || a.title.length - b.title.length);
}

/** The second questions worth asking about this product, best first, given what the store's pack holds. */
function secondQuestions(p: Product, policies: Set<string>): { kind: string; text: string }[] {
  const out: { kind: string; text: string }[] = [];
  if (policies.has('shipping')) out.push({ kind: 'shipping', text: 'ותוך כמה זמן זה מגיע?' });
  const option = p.variants.find((v: any, i: number) => i > 0 && v.available && v.title && !/default/i.test(v.title) && v.title.length <= 24);
  if (option) out.push({ kind: 'variant', text: `ויש את זה גם ב־${option.title}?` });
  if (policies.has('returns')) out.push({ kind: 'returns', text: 'ואם זה לא מתאים, אפשר להחזיר?' });
  return out;
}

const clean = (o: TurnOutput) => !o.redactions.length && !o.handoff;
const MAX_TURNS = 8;

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
  const policies = new Set((await db.query<{ kind: string }>('SELECT DISTINCT kind FROM policies WHERE store_id = $1', [storeId])).map((r) => r.kind));
  const picks = candidates(await loadProducts(db, storeId)).slice(0, 3);

  let chat: SampleChat = [];
  let productId: number | null = null;
  let second: string | null = null;
  let turns = 0;
  const ask = async (conv: number, text: string) => {
    turns++;
    return runTurn(app, { storeId, conversationId: conv, text, footer: false });
  };

  products: for (const p of picks) {
    const q1 = `היי, יש לכם ${shortTitle(p.title)}? כמה זה עולה?`;
    log(`sample chat: ${shortTitle(p.title)}`);
    for (const q2 of secondQuestions(p, policies)) {
      if (turns + 2 > MAX_TURNS) break products;
      try {
        // A fresh conversation for each try, so a failed second answer is not in the history the next one reads.
        const conv = await conversationFor(db, storeId, 'pitch', null);
        const a1 = await ask(conv, q1);
        if (!clean(a1) || !a1.tools.some((t) => t.name === 'search_products' || t.name === 'get_product')) {
          log('  the first answer was not clean, next product');
          continue products;
        }
        const a2 = await ask(conv, q2.text);
        if (!clean(a2)) {
          log(`  the ${q2.kind} answer was not clean`);
          continue;
        }
        chat = [
          { role: 'customer', text: q1 },
          { role: 'agent', text: a1.reply },
          { role: 'customer', text: q2.text },
          { role: 'agent', text: a2.reply },
        ];
        productId = p.id;
        second = q2.kind;
        break products;
      } catch (e: any) {
        log(`  sample chat failed: ${e.message}`);
      }
    }
  }

  await db.tx(async (t) => {
    await t.query(
      `INSERT INTO pitches (store_id, product_id, sample_chat, automations, built_at) VALUES ($1, $2, $3::jsonb, '[]'::jsonb, now())
       ON CONFLICT (store_id) DO UPDATE SET product_id = EXCLUDED.product_id, sample_chat = EXCLUDED.sample_chat, built_at = now()`,
      [storeId, productId, J(chat)],
    );
    await t.query(`UPDATE stores SET demo_code = $2, slug = $3, page_built_at = now(), status = CASE WHEN status = 'new' THEN 'page_ready' ELSE status END, updated_at = now() WHERE id = $1`, [storeId, code, slug]);
    await event(t, storeId, 'page_built', { productId, second, turns, sample: chat.length ? 'agent' : 'none' });
  });
  return { slug, code, productId, chat, second, turns };
}
