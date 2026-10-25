import type { Db } from '../db/index.ts';
import { V } from '../db/index.ts';
import { normalize, termGroups } from '../core/hebrew.ts';
import { embed } from '../ingest/embed.ts';
import type { ToolDef } from './llm/types.ts';

// The agent's tools, the same six for every store. Only the store they read changes.
//
// The rule from tiyul-plus's booking_search: a tool that cannot lie. No tool has a
// field for a price, a discount, a date or a promise. Prices come out of the product
// rows (search_products, get_product), policy text out of the store's own pages
// (get_policy), and nothing the model writes into a tool call can become a fact.
//
// Each result ends with a short rule line for that moment ("quote only the prices
// above"): the last thing the model reads is what it follows (tiyul-plus again).
//
// In the demo, create_cart_link and get_order_status are mocks that say so; handoff
// records the handoff for the dashboard and tells the agent what to say.

export const TOOLS: ToolDef[] = [
  {
    name: 'search_products',
    description: 'Search this store\'s catalogue. Returns matching products with their current price and stock, straight from the store\'s product data. Use it for any question about what the store sells, a product, a price, a size, a colour or availability. Search in the customer\'s words (Hebrew or English); try a broader word if nothing comes back.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the customer is looking for, in a few words' },
        in_stock_only: { type: 'boolean', description: 'Only products that can be bought now' },
        max_price: { type: 'number', description: 'Only when the customer gave a budget: their number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product',
    description: 'One product in full: every variant (size, colour) with its own price and stock, the sale price when there is one, the description and the link. Use it before answering about a specific product\'s variants, sizes or details.',
    input_schema: { type: 'object', properties: { product_id: { type: 'integer', description: 'The id from search_products' } }, required: ['product_id'] },
  },
  {
    name: 'get_policy',
    description: 'The store\'s own policy text on a topic: shipping (cost, areas, delivery times, pickup), returns and exchanges, payment methods, warranty, contact details, or any other question about how the store works. Returns the passages from the store\'s pages, or nothing when the store has not written about it.',
    input_schema: { type: 'object', properties: { topic: { type: 'string', description: 'The question, in the customer\'s words' } }, required: ['topic'] },
  },
  {
    name: 'create_cart_link',
    description: 'Prepare a link for the customer to buy specific products. Use when the customer wants to order. For now it gives the product pages to order from.',
    input_schema: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: { product_id: { type: 'integer' }, variant_id: { type: 'string' }, quantity: { type: 'integer' } }, required: ['product_id'] } } },
      required: ['items'],
    },
  },
  {
    name: 'get_order_status',
    description: 'Look up an existing order by its number. The store\'s orders are not connected yet, so its result says how to hand the question to the store.',
    input_schema: { type: 'object', properties: { order_number: { type: 'string' } }, required: ['order_number'] },
  },
  {
    name: 'handoff',
    description: 'Hand the conversation to a person at the store. Use it whenever: you do not have the answer from a tool; the customer asks for a refund, a discount, a price match, a special arrangement or anything outside the written policy; the customer is upset or asks for a person; or the question is about an existing order.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: ['unknown', 'refund', 'discount', 'complaint', 'order', 'human_requested', 'other'] },
        summary: { type: 'string', description: 'One line for the store owner: what the customer needs' },
      },
      required: ['reason', 'summary'],
    },
  },
];

// demo: the turn is on our shared demo number or a pitch page (loop.ts isDemoTurn), where the cart and order tools say
// they are demo versions; on the store's own channels they say what is not connected yet instead.
// A company store (src/company.ts) sells plans, not products: three tools, the same grounding. get_plans reads the plan
// rows, get_policy the same questions and pages as a store's, handoff the same record with reasons of its own.
export const COMPANY_TOOLS: ToolDef[] = [
  {
    name: 'get_plans',
    description: 'Every plan the company sells, each with its monthly price, VAT, what it covers and its setup fee, and the page that says so. Use it before saying anything about a price, a plan or what a plan includes.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_policy',
    description: 'The company\'s own questions and answers and its pages on a topic: how the service works, which channels and platforms it works with, the demo, starting, cancelling, terms, privacy, security, accessibility. Returns the passages, or nothing when the company has not written about it.',
    input_schema: { type: 'object', properties: { topic: { type: 'string', description: 'The question, in the person\'s words' } }, required: ['topic'] },
  },
  {
    name: 'handoff',
    description: 'Hand the conversation to a person at the company. Use it whenever: you do not have the answer from a tool; the person asks about their own account, a bill, an invoice, a cancellation or a problem; asks for a discount or anything outside what is written; wants a demo or to join; is upset or asks for a person.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: ['unknown', 'demo', 'join', 'account', 'billing', 'cancel', 'discount', 'complaint', 'human_requested', 'other'] },
        summary: { type: 'string', description: 'One line for the company: what the person needs, with their store\'s address when they gave it' },
      },
      required: ['reason', 'summary'],
    },
  },
];

export type ToolContext ={ db: Db; storeId: number; origin: string; currency: string; env?: Record<string, string | undefined>; demo?: boolean; company?: boolean };
export type ToolOutcome = { ok: boolean; content: string; handoff?: { reason: string; summary: string }; facts?: string[] };

type P = { id: number; title: string; url: string; handle: string; image: string | null; price_min: number | null; price_max: number | null; compare_at_max: number | null; available: boolean; variants: any[]; body_text: string; search_text: string; product_type: string | null; override: any };

/** A fee sold as a line item (exchange shipping, gift wrap, a warranty extension): in the catalogue, not merchandise. */
export const isFee = (title: string) => /משלוח|שילוח|אריזת מתנה|עטיפת מתנה|אחריות|ביטוח|פיקדון|shipping|delivery|gift ?wrap|warranty|insurance|deposit/i.test(title);

export const money =(n: number | null | undefined, currency = 'ILS') => (n == null ? 'מחיר לא ידוע' : currency === 'ILS' ? `${fmtNum(n)} ₪` : `${fmtNum(n)} ${currency}`);
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** A product with the owner's corrections applied over what was scraped. */
function effective(p: P): P {
  const o = p.override || {};
  const price = o.price != null ? Number(o.price) : null;
  return {
    ...p,
    title: o.title || p.title,
    price_min: price ?? (p.price_min != null ? Number(p.price_min) : null),
    price_max: price ?? (p.price_max != null ? Number(p.price_max) : null),
    compare_at_max: p.compare_at_max != null ? Number(p.compare_at_max) : null,
    available: o.available != null ? Boolean(o.available) : p.available,
    variants: price != null ? p.variants.map((v) => ({ ...v, price })) : p.variants,
  };
}

const stockWord = (a: boolean) => (a ? 'במלאי' : 'אזל מהמלאי');

function priceLine(p: P, currency: string): string {
  const range = p.price_min != null && p.price_max != null && p.price_max !== p.price_min ? `${money(p.price_min, currency)} עד ${money(p.price_max, currency)}` : money(p.price_min, currency);
  const sale = p.compare_at_max != null && p.price_max != null && p.compare_at_max > p.price_max ? ` (במבצע, במקום ${money(p.compare_at_max, currency)})` : '';
  return `${range}${sale}`;
}

export async function loadProducts(db: Db, storeId: number): Promise<P[]> {
  const rows = await db.query<P>("SELECT id, title, url, handle, image, price_min::float, price_max::float, compare_at_max::float, available, variants, body_text, search_text, product_type, override FROM products WHERE store_id = $1 AND gone_at IS NULL AND COALESCE((override->>'hidden')::boolean, false) = false", [storeId]);
  return rows.map(effective);
}

/** Rank products for a query: words in the title count most, then type and tags, then the description; a near-miss on a Hebrew prefix still counts. */
export function rank(products: P[], query: string): { p: P; s: number }[] {
  const groups = termGroups(query);
  if (!groups.length) return [];
  return products
    .map((p) => {
      const title = normalize(p.title);
      const body = normalize(p.body_text.slice(0, 600));
      let s = 0;
      let hit = 0;
      // Each word of the query scores once, by its best form and place.
      for (const g of groups) {
        const inTitle = g.some((t) => title.includes(t));
        const inSearch = g.some((t) => p.search_text.includes(t));
        const inBody = g.some((t) => body.includes(t));
        if (inTitle) s += 3;
        else if (inSearch) s += 2;
        else if (inBody) s += 0.5;
        if (inTitle || inSearch || inBody) hit++;
      }
      // Every word found beats some words found.
      if (hit === groups.length) s += 2;
      return { p, s };
    })
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s || Number(b.p.available) - Number(a.p.available));
}

async function searchProducts(c: ToolContext, input: any): Promise<ToolOutcome> {
  const all = await loadProducts(c.db, c.storeId);
  let found = rank(all, String(input.query || ''));
  if (input.in_stock_only) found = found.filter((x) => x.p.available);
  if (input.max_price != null && Number.isFinite(Number(input.max_price))) found = found.filter((x) => x.p.price_min != null && x.p.price_min <= Number(input.max_price));
  const top = found.slice(0, 6);
  if (!top.length) {
    const types = [...new Set(all.map((p) => p.product_type).filter(Boolean))].slice(0, 12);
    return { ok: true, content: `No products match "${input.query}".${types.length ? ` What this store does carry, by type: ${types.join(', ')}.` : ''}\nRule: do not suggest or describe a product that is not in a result. Say the store does not seem to carry it, offer the closest type above if it fits, or hand off.` };
  }
  const lines = top.map(({ p }) => `- [id ${p.id}] ${p.title}: ${priceLine(p, c.currency)}, ${stockWord(p.available)}${p.variants.length > 1 ? `, ${p.variants.length} options` : ''}. ${p.url}`);
  return { ok: true, content: `${found.length} matching product${found.length === 1 ? '' : 's'}${found.length > top.length ? ` (the ${top.length} closest)` : ''}:\n${lines.join('\n')}\nRule: quote only prices and stock shown above, exactly. For sizes or colours call get_product.`, facts: lines };
}

async function getProduct(c: ToolContext, input: any): Promise<ToolOutcome> {
  const id = Number(input.product_id);
  const p = (await loadProducts(c.db, c.storeId)).find((x) => x.id === id);
  if (!p) return { ok: false, content: `No product with id ${input.product_id} in this store. Search again with search_products.` };
  const vs = p.variants.filter((v: any) => !/^default title$/i.test(v.title));
  const variantLines = vs.slice(0, 30).map((v: any) => `  - ${v.title}: ${money(v.price, c.currency)}${v.compare_at && v.price != null && v.compare_at > v.price ? ` (במקום ${money(v.compare_at, c.currency)})` : ''}, ${stockWord(v.available)} [variant ${v.id}]`);
  const desc = p.body_text ? p.body_text.slice(0, 900) : '(no description)';
  return {
    ok: true,
    content: `[id ${p.id}] ${p.title}\nPrice: ${priceLine(p, c.currency)}. ${stockWord(p.available)}.\n${variantLines.length ? `Options:\n${variantLines.join('\n')}\n` : ''}Link: ${p.url}\nDescription (the store's own words): ${desc}\nRule: quote prices, sizes and stock only as written above. Anything the description does not say (materials, care, fit, delivery) you do not know.`,
    facts: [p.title],
  };
}

async function getPolicy(c: ToolContext, input: any): Promise<ToolOutcome> {
  const topic = String(input.topic || '');
  const groups = termGroups(topic);
  const matched = (text: string) => {
    const n = normalize(text);
    return groups.filter((g) => g.some((t) => n.includes(t))).length;
  };
  // The owner's own answers come first: they are the most trusted text the agent has.
  const faqs = await c.db.query<{ question: string; answer: string | null; site_answer: string | null }>('SELECT question, answer, site_answer FROM faqs WHERE store_id = $1', [c.storeId]);
  const faqHits = faqs
    .map((f) => ({ f, s: matched(f.question) }))
    .filter((x) => x.s > 0 && (x.f.answer || x.f.site_answer))
    .sort((a, b) => b.s - a.s)
    .slice(0, 2);

  const chunks: { text: string; kind: string; title: string; url: string; d?: number }[] = [];
  const q = await embed([topic], 'query', c.env);
  if (q) {
    const rows = await c.db.query<any>(
      `SELECT c.text, c.kind, p.title, p.url, COALESCE(p.override_text, '') AS override, c.embedding <=> $2::vector AS d
       FROM chunks c JOIN policies p ON p.id = c.policy_id WHERE c.store_id = $1 AND c.embedding IS NOT NULL ORDER BY d LIMIT 4`,
      [c.storeId, V(q[0])],
    );
    // e5's scores sit in a narrow band (a right passage about 0.12 distance, an unrelated one about 0.2), so the cut is
    // relative: the best passage if it is close enough, and the others only near it.
    const best = rows[0]?.d ?? 1;
    for (const r of rows) if (r.d <= Math.min(0.19, best + 0.025)) chunks.push({ text: r.text, kind: r.kind, title: r.title, url: r.url, d: r.d });
  }
  if (!chunks.length) {
    const rows = await c.db.query<any>('SELECT c.text, c.kind, p.title, p.url FROM chunks c JOIN policies p ON p.id = c.policy_id WHERE c.store_id = $1', [c.storeId]);
    const scored = rows.map((r) => ({ r, s: matched(r.text) })).filter((x) => x.s >= Math.min(2, groups.length)).sort((a, b) => b.s - a.s).slice(0, 3);
    for (const { r } of scored) chunks.push({ text: r.text, kind: r.kind, title: r.title, url: r.url });
  }
  // An owner's correction to a whole policy replaces its chunks.
  const overrides = await c.db.query<{ kind: string; title: string; override_text: string }>('SELECT kind, title, override_text FROM policies WHERE store_id = $1 AND override_text IS NOT NULL', [c.storeId]);
  const parts: string[] = [];
  // A company store's passages are the company's, and its person is told someone from us answers, not "the store".
  const biz = c.company ? 'company' : 'store';
  const checking = c.company ? 'tell the person you are checking and someone from us will answer here' : 'tell the customer you are checking with the store';
  for (const { f } of faqHits) parts.push(`From the ${biz}'s FAQ: "${f.question}"\n${f.answer || f.site_answer}`);
  for (const o of overrides) if (chunks.some((ch) => ch.kind === o.kind) || matched(o.title) > 0) parts.push(`From the ${biz}'s ${o.kind} policy (${o.title}):\n${o.override_text}`);
  for (const ch of chunks) if (!overrides.some((o) => o.kind === ch.kind)) parts.push(`From the ${biz}'s ${ch.kind} page (${ch.title}, ${ch.url}):\n${ch.text}`);
  if (!parts.length) return { ok: true, content: `The ${biz} has not written anything about "${topic}".\nRule: you do not know the answer. Do not guess what is usual. ${checking[0].toUpperCase()}${checking.slice(1)}, and call handoff with reason "unknown".` };
  return {
    ok: true,
    content: `${parts.join('\n\n')}\nRule: answer only with what these passages say, in your own short words. A number, a time or a condition that is not written here, you do not know. If these passages are near the question but do not answer it (the ${c.company ? 'person' : 'customer'} asked about installation and they are about shipping), say the ${biz} has not written about it, ${checking}, and call handoff with reason "unknown" in this same answer.`,
    facts: parts,
  };
}

async function getPlans(c: ToolContext): Promise<ToolOutcome> {
  const plans = await loadProducts(c.db, c.storeId);
  if (!plans.length) return { ok: true, content: 'No plans are written down.\nRule: you do not know the prices. Say you are checking, and call handoff with reason "unknown".' };
  const lines = plans.map((p) => `- ${p.title}: ${p.body_text} ${p.url}`);
  return { ok: true, content: `${lines.join('\n')}\nRule: quote prices, VAT, setup fees and what a plan covers exactly as written above. A plan, a price, a discount or a condition that is not written here, you do not know.`, facts: lines };
}

async function cartLink(c: ToolContext, input: any): Promise<ToolOutcome> {
  const items = Array.isArray(input.items) ? input.items : [];
  const all = await loadProducts(c.db, c.storeId);
  const lines: string[] = [];
  for (const it of items.slice(0, 10)) {
    const p = all.find((x) => x.id === Number(it.product_id));
    if (!p) return { ok: false, content: `No product with id ${it.product_id}. Search first.` };
    if (!p.available) return { ok: true, content: `${p.title} is out of stock, so it cannot go in a cart. Tell the customer it is out of stock and offer to hand off to the store about restocking.` };
    lines.push(`${p.title}: ${p.url}`);
  }
  if (!lines.length) return { ok: false, content: 'No items given.' };
  if (c.demo === false) return { ok: true, content: `The product pages, where the customer adds the item to the cart:\n${lines.join('\n')}\nRule: give these links.` };
  return { ok: true, content: `DEMO: in the live version this is one link to a ready cart. For now, the product pages:\n${lines.join('\n')}\nRule: give these links and say plainly that in the full version the customer would get a ready cart.` };
}

async function orderStatus(c: ToolContext, input: any): Promise<ToolOutcome> {
  const order = String(input.order_number || '').slice(0, 30);
  if (c.demo === false) return { ok: true, content: `The store's orders are not connected here, so order ${order} cannot be looked up.\nRule: tell the customer you are passing it to the store, who will answer here, and call handoff with reason "order".` };
  return { ok: true, content: `DEMO: this demo is not connected to the store's orders, so order ${order} cannot be looked up.\nRule: say that in the live version order status is answered here automatically, and call handoff with reason "order" so the store can check it.` };
}

export async function runTool(c: ToolContext, name: string, input: any): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'search_products':
        return await searchProducts(c, input || {});
      case 'get_product':
        return await getProduct(c, input || {});
      case 'get_policy':
        return await getPolicy(c, input || {});
      case 'get_plans':
        return await getPlans(c);
      case 'create_cart_link':
        return await cartLink(c, input || {});
      case 'get_order_status':
        return await orderStatus(c, input || {});
      case 'handoff': {
        const reason = String(input?.reason || 'other');
        const summary = String(input?.summary || '').slice(0, 300);
        const content = c.company
          ? 'Handed off: someone at the company sees this conversation now.\nRule: tell the person in one short sentence that someone from us will get back to them here. No promises about what we will decide or when.'
          : 'Handed off: the store owner sees this conversation now.\nRule: tell the customer in one short sentence that someone from the store will get back to them here. No promises about what the store will decide or when.';
        return { ok: true, content, handoff: { reason, summary } };
      }
      default:
        return { ok: false, content: `There is no tool called ${name}.` };
    }
  } catch (e: any) {
    return { ok: false, content: `The tool failed (${String(e?.message || e).slice(0, 120)}). Do not guess the answer; hand off if you cannot answer without it.` };
  }
}
