import { randomInt } from 'node:crypto';
import type { App } from '../app.ts';
import { J } from '../db/index.ts';
import { event } from '../db/log.ts';
import { conversationFor, runTurn, type TurnOutput } from '../agent/loop.ts';
import { isFee, loadProducts } from '../agent/tools.ts';
import { makeSlug } from '../leads/store.ts';
import { autoApprove, pitchGaps } from './ready.ts';
import { reviewChat, reviewOn, type Review } from './review.ts';

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
//
// A clean answer is then read the way the store's owner will read it (review.ts): the
// first answer as soon as it comes, so a muddled one moves on to the next product
// without asking the second question, and the whole chat before it is kept (the owner,
// 2026-11-12: "make sure it catches things like that"). What it turned down, and why, is
// in the page_built event, for the review page. A product whose name fits others too
// ("Grow", in "Grow & Shine" and "Grow - חודש") is asked about last: the question then
// has one answer, not a list.

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: a code someone may type
export const newCode = () => `DEMO-${Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('')}`;
export const CODE_RE = /DEMO-([A-HJKMNP-Z2-9]{4})\b/i;

export type SampleChat = { role: 'customer' | 'agent'; text: string }[];

export const shortTitle = (t: string) => t.replace(/[-–|(].*$/, '').replace(/\s+/g, ' ').trim();

type Product = Awaited<ReturnType<typeof loadProducts>>[number];

const said = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** Whether a customer who says this product's short name could mean another product too: another title holds it. */
export const ambiguous = (p: { id: number; title: string }, all: { id: number; title: string }[]) => {
  const name = said(shortTitle(p.title));
  return all.some((o) => o.id !== p.id && said(o.title).includes(name));
};

/** A product worth showing: in stock, priced, with a picture and a title a customer would say out loud; one name, one product, first. */
export function candidates(products: Product[]) {
  const unclear = new Set(products.filter((p) => ambiguous(p, products)).map((p) => p.id));
  return products
    .filter((p) => p.available && p.price_min != null && p.image && shortTitle(p.title).length >= 4 && shortTitle(p.title).length <= 40 && !/gift ?card|כרטיס מתנה|שובר/i.test(p.title) && !isFee(p.title))
    .sort((a, b) => Number(unclear.has(a.id)) - Number(unclear.has(b.id)) || Number(b.variants.length > 1) - Number(a.variants.length > 1) || a.title.length - b.title.length);
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

/**
 * keep: when no new chat passes, the page keeps the one it has instead of none (npm run pitch -- --check --rebuild, for
 * a page already sent: a link a store has must not stop opening because a new chat did not pass).
 */
export async function buildPitch(app: App, storeId: number, { log = (_: string) => {}, keep = false }: { log?: (m: string) => void; keep?: boolean } = {}) {
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
  const turnedDown: { product: string; question: string; why: string }[] = [];
  const ask = async (conv: number, text: string) => {
    turns++;
    return runTurn(app, { storeId, conversationId: conv, text, footer: false });
  };
  const review = async (p: Product, sample: SampleChat, outs: TurnOutput[], question: string): Promise<Review> => {
    if (!reviewOn(app)) return { ok: true, why: null };
    const r = await reviewChat(app, { storeId, chat: sample, product: p, toolTexts: outs.flatMap((o) => o.tools.map((t) => t.result)) });
    if (!r.ok) {
      turnedDown.push({ product: shortTitle(p.title), question, why: r.why || '' });
      log(`  turned down: ${r.why}`);
    }
    return r;
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
        const first: SampleChat = [
          { role: 'customer', text: q1 },
          { role: 'agent', text: a1.reply },
        ];
        if (!(await review(p, first, [a1], 'first')).ok) continue products;
        const a2 = await ask(conv, q2.text);
        if (!clean(a2)) {
          log(`  the ${q2.kind} answer was not clean`);
          continue;
        }
        const whole: SampleChat = [...first, { role: 'customer', text: q2.text }, { role: 'agent', text: a2.reply }];
        if (!(await review(p, whole, [a1, a2], q2.kind)).ok) continue;
        chat = whole;
        productId = p.id;
        second = q2.kind;
        break products;
      } catch (e: any) {
        log(`  sample chat failed: ${e.message}`);
      }
    }
  }

  const kept = keep && !chat.length && Boolean(await db.one("SELECT 1 FROM pitches WHERE store_id = $1 AND jsonb_array_length(sample_chat) >= 4", [storeId]));
  await db.tx(async (t) => {
    if (!kept) {
      await t.query(
        `INSERT INTO pitches (store_id, product_id, sample_chat, automations, built_at) VALUES ($1, $2, $3::jsonb, '[]'::jsonb, now())
         ON CONFLICT (store_id) DO UPDATE SET product_id = EXCLUDED.product_id, sample_chat = EXCLUDED.sample_chat, built_at = now()`,
        [storeId, productId, J(chat)],
      );
    }
    await t.query(`UPDATE stores SET demo_code = $2, slug = $3, page_built_at = now(), status = CASE WHEN status = 'new' THEN 'page_ready' ELSE status END, updated_at = now() WHERE id = $1`, [storeId, code, slug]);
    await event(t, storeId, 'page_built', { productId, second, turns, sample: chat.length ? 'agent' : kept ? 'kept' : 'none', ...(turnedDown.length ? { turnedDown } : {}) });
  });
  // A page with nothing missing goes up as soon as it is built: nobody approves pages by hand.
  const built = await db.one<any>('SELECT id, name, brand, brand_override, approved_at, taken_down_at, status FROM stores WHERE id = $1', [storeId]);
  if (built) await autoApprove(app, built, await pitchGaps(app, built));
  return { slug, code, productId, chat, second, turns, turnedDown, kept };
}
