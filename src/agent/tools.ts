import type { Db } from '../db/index.ts';
import { V } from '../db/index.ts';
import { hebrewRatio, normalize, termGroups } from '../core/hebrew.ts';
import { embed } from '../ingest/embed.ts';
import { conceptGroups, conceptsOf, conceptsSaid } from './claims.ts';
import { contactsIn, findOrder, fromOrder, orderAccessOf, phoneGiven, type Order } from '../orders.ts';
import { pageFor, shipmentsTold } from '../tracking.ts';
import type { ToolDef } from './llm/types.ts';
import type { Fetcher } from '../core/http.ts';
import { type Photo, productPhoto } from './images.ts';

// The agent's tools, the same seven for every store. Only the store they read changes.
//
// The rule from tiyul-plus's booking_search: a tool that cannot lie. No tool has a
// field for a price, a discount, a date or a promise. Prices come out of the product
// rows (search_products, get_product), policy text out of the store's own pages
// (get_policy), and nothing the model writes into a tool call can become a fact.
//
// Each result ends with a short rule line for that moment ("quote only the prices
// above"): the last thing the model reads is what it follows (tiyul-plus again).
//
// In the demo, create_cart_link and get_order_status are mocks that say so. Live, create_cart_link builds the
// platform's own cart link from the stored variant ids, and get_order_status reads the store's orders once the owner
// connected them (src/orders.ts). handoff records the handoff for the dashboard and tells the agent what to say.

export const TOOLS: ToolDef[] = [
  {
    name: 'search_products',
    description: 'Search this store\'s catalogue. Returns matching products with their current price and stock, straight from the store\'s product data, and what their photos look like when that was read. Use it for any question about what the store sells, a product, a price, a size, a colour or availability. Search in the customer\'s words (Hebrew or English); try a broader word if nothing comes back. Its result says which of the customer\'s words no product mentions: when one of them is a colour or a look, check the photos (view_product_images) before you offer anything.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the customer is looking for, in a few words' },
        in_stock_only: { type: 'boolean', description: 'Only products that can be bought now' },
        max_price: { type: 'number', description: 'Only when the customer gave a budget: their number' },
        page: { type: 'integer', description: 'The next results of the same search: 2 for the 7th to 12th, and so on' },
      },
      required: ['query'],
    },
  },
  {
    name: 'view_product_images',
    description: 'See the main photo of up to 6 products, by their ids from search_products. Use it whenever the answer depends on how a product looks and the text does not say it: a colour (צהוב, שחור), a pattern, a print, a style, or whether it matches a photo the customer sent. Look first, then answer: offer only a product whose photo shows what the customer asked for.',
    input_schema: {
      type: 'object',
      properties: { product_ids: { type: 'array', items: { type: 'integer' }, description: 'Up to 6 ids from search_products, the closest first' } },
      required: ['product_ids'],
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
    description: 'Prepare a link for the customer to buy specific products. Use when the customer wants to order. For a product with several options (size, colour), give the variant_id of the one the customer chose, from get_product. The result is the link to give, or the product pages when the store has no cart link.',
    input_schema: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: { product_id: { type: 'integer' }, variant_id: { type: 'string', description: 'The [variant ...] id from get_product' }, quantity: { type: 'integer' } }, required: ['product_id'] } } },
      required: ['items'],
    },
  },
  {
    name: 'get_order_status',
    description: 'Look up an existing order by its number in the store\'s own system: its status, its shipments (the carrier, the tracking number) and the tracking link to give. Ask the customer for the order number only, and call it. It answers when the customer writes from the order\'s own phone (or email address); otherwise its result asks you to check it is really them by asking for the phone number the order was placed with, and you call it again once they give it. When the store\'s orders are not connected, its result says how to hand the question to the store. Tell the customer the status in plain, natural Hebrew with the tracking link as given, and only what the result says: never a status, a place or a date of your own.',
    input_schema: { type: 'object', properties: { order_number: { type: 'string', description: 'The order number as the customer wrote it' } }, required: ['order_number'] },
  },
  {
    name: 'handoff',
    description: 'Hand the conversation to a person at the store. Use it whenever: you do not have the answer from a tool; the customer asks for a refund, a discount, a price match, a special arrangement or anything outside the written policy; the customer is upset or asks for a person; or the question is about an existing order that get_order_status did not answer.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: ['unknown', 'refund', 'discount', 'complaint', 'order', 'human_requested', 'other'] },
        summary: { type: 'string', description: 'One line for the store owner, in Hebrew: what the customer needs' },
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
    description: 'Hand the conversation to a person at the company. Use it whenever: you do not have the answer from a tool; the person asks about their own account, a bill, an invoice, a cancellation or a problem; asks for a discount or anything outside what is written; wants to join and the tools do not say how; is upset or asks for a person. Not for a demo: that is asked for on the website.',
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

// said: the customer's own messages in this conversation, this turn's included (an order is told only to whoever wrote
// its email or phone in them); waPhone: the number the customer writes from on the store's own WhatsApp; api: the way
// to the store's order API (app.api).
// images: the fetcher product photos are read with (app.images; absent, view_product_images says it cannot show them).
export type ToolContext = { db: Db; storeId: number; origin: string; currency: string; env?: Record<string, string | undefined>; demo?: boolean; company?: boolean; api?: typeof fetch; conversationId?: number; said?: string[]; waPhone?: string | null; fromEmail?: string | null; images?: Fetcher };
/** images: photos the model sees with the result's text (view_product_images); the record keeps the text alone. */
export type ToolOutcome = { ok: boolean; content: string; handoff?: { reason: string; summary: string }; facts?: string[]; images?: Photo[] };

// looks: what the product's main photo shows (its colours, a pattern), read once from the photo (ingest/looks.ts).
type P = { id: number; ext_id: string; title: string; url: string; handle: string; image: string | null; price_min: number | null; price_max: number | null; compare_at_max: number | null; available: boolean; variants: any[]; body_text: string; search_text: string; product_type: string | null; override: any; looks: string | null };

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

// A sale is said of what is on sale. A range whose options are not all on sale says so, and which ones are is
// get_product's: "Grow: 249 ₪ עד 389 ₪ (במבצע, במקום 498 ₪)" went to a customer word for word, when only the 389 ₪
// option was 498 ₪ before (the owner, 2026-11-12, on a demo: "something with the grow is not it").
export const SOME_ON_SALE = 'חלק מהאפשרויות במבצע';
function priceLine(p: P, currency: string): string {
  const ranged = p.price_min != null && p.price_max != null && p.price_max !== p.price_min;
  const range = ranged ? `${money(p.price_min, currency)} עד ${money(p.price_max, currency)}` : money(p.price_min, currency);
  const priced = (p.variants || []).filter((v: any) => v?.price != null);
  // One price, or no options to tell by: the product's own sale.
  if (!ranged || !priced.length) return p.compare_at_max != null && p.price_max != null && p.compare_at_max > p.price_max ? `${range} (במבצע, במקום ${money(p.compare_at_max, currency)})` : range;
  const was = priced.map((v: any) => (v.compare_at != null && Number(v.compare_at) > Number(v.price) ? Number(v.compare_at) : null));
  if (was.every((w) => w == null)) return range;
  if (was.some((w) => w == null)) return `${range} (${SOME_ON_SALE})`;
  const lo = Math.min(...(was as number[]));
  const hi = Math.max(...(was as number[]));
  return `${range} (במבצע, במקום ${lo === hi ? money(hi, currency) : `${money(lo, currency)} עד ${money(hi, currency)}`})`;
}

export async function loadProducts(db: Db, storeId: number): Promise<P[]> {
  const rows = await db.query<P>("SELECT id, ext_id, title, url, handle, image, price_min::float, price_max::float, compare_at_max::float, available, variants, body_text, search_text, product_type, override, looks FROM products WHERE store_id = $1 AND gone_at IS NULL AND COALESCE((override->>'hidden')::boolean, false) = false", [storeId]);
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
      const looks = p.looks ? normalize(p.looks) : '';
      let s = 0;
      let hit = 0;
      // Each word of the query scores once, by its best form and place. What the photo shows (looks) counts as a tag:
      // "חולצה צהובה" finds the yellow kits of a store whose titles are only team and season.
      for (const g of groups) {
        const inTitle = g.some((t) => title.includes(t));
        const inSearch = g.some((t) => p.search_text.includes(t) || looks.includes(t));
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
  const page = Math.max(1, Math.min(20, Math.floor(Number(input.page) || 1)));
  const from = (page - 1) * PAGE;
  const top = found.slice(from, from + PAGE);
  if (!top.length) {
    if (page > 1 && found.length) return { ok: true, content: `No more results: the search "${input.query}" has ${found.length}, all shown on the pages before.\nRule: do not suggest or describe a product that is not in a result.` };
    const types = [...new Set(all.map((p) => p.product_type).filter(Boolean))].slice(0, 12);
    const none = `No products match "${input.query}".${types.length ? ` What this store does carry, by type: ${types.join(', ')}.` : ''}`;
    // Words in another language than the products' names find nothing ("big olive bowl" in a store of "קערת זית
    // גדולה", told to say the store does not carry it: docs/models.md, q10): one more search in the names' language first.
    const query = String(input.query || '');
    const namesHe = hebrewRatio(all.map((p) => p.title).join(' ')) >= 0.5;
    if (all.length && /\p{L}/u.test(query) && (hebrewRatio(query) >= 0.5) !== namesHe) {
      const lang = namesHe ? 'Hebrew' : 'English';
      return { ok: true, content: `${none}\nRule: the store's products are named in ${lang}, and these words are not. Call search_products once more with them in ${lang} before you say anything about this product. Do not suggest or describe a product that is not in a result.` };
    }
    return { ok: true, content: `${none}\nRule: do not suggest or describe a product that is not in a result. Say the store does not seem to carry it, offer the closest type above if it fits, or hand off.` };
  }
  // The customer's words that no product in the store mentions, not even in what its photo was read to show: a colour
  // here means the text cannot tell it, and the photos must (the owner's red kit offered for a yellow shirt, 2026-11-09).
  const unmatched = unmatchedWords(all, String(input.query || ''));
  const lines = top.map(({ p }) => `- [id ${p.id}] ${p.title}: ${priceLine(p, c.currency)}, ${stockWord(p.available)}${p.variants.length > 1 ? `, ${p.variants.length} options` : ''}.${p.looks ? ` Photo: ${p.looks}.` : ''} ${p.url}`);
  const head = `${found.length} matching product${found.length === 1 ? '' : 's'}${found.length > top.length ? ` (${page > 1 ? `page ${page}: ` : 'the '}${from + 1} to ${from + top.length}, the closest first)` : ''}:`;
  const words = unmatched.length ? `\nNo product's text or photo mentions: ${unmatched.join(', ')}.` : '';
  const rule = `Rule: quote only prices and stock shown above, exactly. For sizes or colours call get_product. When the customer asked for a colour, a pattern or a look that a product's line above does not show, call view_product_images on the closest ids before offering any of them, and offer only one whose photo shows it.${found.length > from + top.length ? ' page: the next results.' : ''}`;
  return { ok: true, content: `${head}\n${lines.join('\n')}${words}\n${rule}`, facts: lines };
}

const PAGE = 6;

/** The query's words (by termGroups) that no product's title, tags, description or photo looks contain. */
export function unmatchedWords(products: P[], query: string): string[] {
  const texts = products.map((p) => `${normalize(p.title)} ${p.search_text} ${normalize(p.body_text.slice(0, 600))} ${p.looks ? normalize(p.looks) : ''}`);
  return termGroups(query)
    .filter((g) => !texts.some((t) => g.some((w) => t.includes(w))))
    .map((g) => g[0]);
}

/** The products' main photos, for the model to look at, each named by its id and title in the text beside them. */
async function viewProductImages(c: ToolContext, input: any): Promise<ToolOutcome> {
  const ids = [...new Set((Array.isArray(input.product_ids) ? input.product_ids : [input.product_ids]).map(Number).filter((n: number) => Number.isInteger(n) && n > 0))].slice(0, MAX_VIEW) as number[];
  if (!ids.length) return { ok: false, content: 'Give product_ids: the ids from search_products.' };
  const all = await loadProducts(c.db, c.storeId);
  const lines: string[] = [];
  const images: Photo[] = [];
  const photos = await Promise.all(ids.map((id) => {
    const p = all.find((x) => x.id === id);
    return p && c.images ? productPhoto(c.images, p.image) : Promise.resolve(null);
  }));
  ids.forEach((id, i) => {
    const p = all.find((x) => x.id === id);
    if (!p) lines.push(`- [id ${id}]: no such product in this store.`);
    else if (!photos[i]) lines.push(`- [id ${p.id}] ${p.title}: its photo could not be loaded.`);
    else {
      images.push(photos[i]!);
      lines.push(`- Photo ${images.length}: [id ${p.id}] ${p.title}`);
    }
  });
  if (!images.length) return { ok: true, content: `${lines.join('\n')}\nRule: you could not see these photos, so you do not know how they look. Do not say what colour or style they are; ask the customer one short question (which team, which style), or hand off.` };
  return {
    ok: true,
    content: `The photos below, in this order:\n${lines.join('\n')}\nRule: say only what you plainly see in a photo (its colours, a pattern, a print, the style). Offer only a product whose photo shows what the customer asked for; one whose photo shows otherwise (asked for yellow, it is red) is not an answer, so leave it out without mentioning it. None fits: say plainly you did not find one like that, and ask one short question. Prices and stock only from the search lines, never from a photo.`,
    images,
  };
}

const MAX_VIEW = 6;

async function getProduct(c: ToolContext, input: any): Promise<ToolOutcome> {
  const id = Number(input.product_id);
  const p = (await loadProducts(c.db, c.storeId)).find((x) => x.id === id);
  if (!p) return { ok: false, content: `No product with id ${input.product_id} in this store. Search again with search_products.` };
  const vs = p.variants.filter((v: any) => !/^default title$/i.test(v.title));
  const variantLines = vs.slice(0, 30).map((v: any) => `  - ${v.title}: ${money(v.price, c.currency)}${v.compare_at && v.price != null && v.compare_at > v.price ? ` (במקום ${money(v.compare_at, c.currency)})` : ''}, ${stockWord(v.available)} [variant ${v.id}]`);
  const desc = p.body_text ? p.body_text.slice(0, 900) : '(no description)';
  return {
    ok: true,
    content: `[id ${p.id}] ${p.title}\nPrice: ${priceLine(p, c.currency)}. ${stockWord(p.available)}.\n${variantLines.length ? `Options:\n${variantLines.join('\n')}\n` : ''}Link: ${p.url}\n${p.looks ? `Photo: ${p.looks}.\n` : ''}Description (the store's own words): ${desc}\nRule: quote prices, sizes and stock only as written above. Anything the description does not say (materials, care, fit, delivery) you do not know. How it looks (its colour, a print) you can see with view_product_images.`,
    facts: [p.title],
  };
}

async function getPolicy(c: ToolContext, input: any): Promise<ToolOutcome> {
  const topic = String(input.topic || '');
  const groups = termGroups(topic);
  // What the topic is about, in the claim check's words (claims.ts), Hebrew and English alike: "international shipping"
  // and "משלוחים לחו"ל" are both ship and abroad. A passage in another language than the topic matches by its concepts,
  // so a question in English finds the store's Hebrew page (docs/models.md, q10: every English question about the pages
  // found nothing); one in the topic's own language by its words, as before.
  const he = hebrewRatio(topic) >= 0.5;
  const about = conceptGroups(topic);
  const score = (text: string) => {
    const n = normalize(text);
    const words = groups.filter((g) => g.some((t) => n.includes(t))).length;
    const ids = about.length && (hebrewRatio(text) >= 0.5) !== he ? conceptsOf(text) : null;
    const concepts = ids ? about.filter((g) => g.some((id) => ids.has(id))).length : 0;
    return { words, concepts, s: words + concepts };
  };
  const fits = (x: { words: number; concepts: number }) => x.words >= Math.min(2, groups.length) || (about.length > 0 && x.concepts >= Math.min(2, about.length));
  // The owner's own answers come first: they are the most trusted text the agent has.
  const faqs = await c.db.query<{ question: string; answer: string | null; site_answer: string | null }>('SELECT question, answer, site_answer FROM faqs WHERE store_id = $1', [c.storeId]);
  const faqHits = faqs
    .map((f) => ({ f, s: score(f.question).s }))
    .filter((x) => x.s > 0 && (x.f.answer || x.f.site_answer))
    .sort((a, b) => b.s - a.s)
    .slice(0, 2);

  const chunks: { text: string; kind: string; title: string; url: string; d?: number }[] = [];
  // The topic is also asked by its concepts in the other language ("shipping to London, international shipping" as
  // "משלוח חוץ לארץ"): e5 puts an English question about 0.2 from every Hebrew passage, the right one included, and
  // that one 0.15 from the shipping page (measured on the fictional store).
  const other = conceptsSaid(topic, !he);
  // Each on its own: in one batch with another text, a query's vector moves by about 0.0025, which is enough to move a
  // passage across the cut below.
  const q = await embed([topic], 'query', c.env);
  const q2 = q && other ? await embed([other], 'query', c.env) : null;
  if (q) {
    const rows = await c.db.query<any>(
      `SELECT c.text, c.kind, p.title, p.url, c.embedding <=> $2::vector AS d, c.embedding <=> $3::vector AS d2
       FROM chunks c JOIN policies p ON p.id = c.policy_id WHERE c.store_id = $1 AND c.embedding IS NOT NULL
       ORDER BY LEAST(c.embedding <=> $2::vector, c.embedding <=> $3::vector) LIMIT 8`,
      [c.storeId, V(q[0]), V((q2 || q)[0])],
    );
    // A passage in the topic's own language is measured from the topic, one in the other language from its concepts too.
    const near = rows
      .map((r) => ({ ...r, d: (hebrewRatio(r.text) >= 0.5) === he ? Number(r.d) : Math.min(Number(r.d), Number(r.d2)) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);
    // e5's scores sit in a narrow band (a right passage about 0.12 distance, an unrelated one about 0.2), so the cut is
    // relative: the best passage if it is close enough, and the others only near it.
    const best = near[0]?.d ?? 1;
    for (const r of near) if (r.d <= Math.min(0.19, best + 0.025)) chunks.push({ text: r.text, kind: r.kind, title: r.title, url: r.url, d: r.d });
  }
  let pages: { text: string }[] = [];
  if (!chunks.length) {
    const rows = await c.db.query<any>('SELECT c.text, c.kind, p.title, p.url FROM chunks c JOIN policies p ON p.id = c.policy_id WHERE c.store_id = $1', [c.storeId]);
    pages = rows;
    const scored = rows.map((r) => ({ r, ...score(r.text) })).filter(fits).sort((a, b) => b.s - a.s).slice(0, 3);
    for (const { r } of scored) chunks.push({ text: r.text, kind: r.kind, title: r.title, url: r.url });
  }
  // An owner's correction to a whole policy replaces its chunks.
  const overrides = await c.db.query<{ kind: string; title: string; override_text: string }>('SELECT kind, title, override_text FROM policies WHERE store_id = $1 AND override_text IS NOT NULL', [c.storeId]);
  const parts: string[] = [];
  // A company store's passages are the company's, and its person is told someone from us answers, not "the store".
  const biz = c.company ? 'company' : 'store';
  // What the model says when it has no answer: not sure, passed to a person, never why (agent/guard.ts, the owner's
  // "לא כתבנו כלום ... makes it feel bizarre").
  const checking = c.company ? 'say you are not sure and that you passed the question to someone from our team (נציג), who will answer here' : 'say you are not sure and that you passed the question to someone from the store (נציג), who will answer here';
  for (const { f } of faqHits) parts.push(`From the ${biz}'s FAQ: "${f.question}"\n${f.answer || f.site_answer}`);
  for (const o of overrides) if (chunks.some((ch) => ch.kind === o.kind) || score(o.title).s > 0) parts.push(`From the ${biz}'s ${o.kind} policy (${o.title}):\n${o.override_text}`);
  for (const ch of chunks) if (!overrides.some((o) => o.kind === ch.kind)) parts.push(`From the ${biz}'s ${ch.kind} page (${ch.title}, ${ch.url}):\n${ch.text}`);
  if (!parts.length) {
    const none = `No passage of the ${biz}'s answers or pages is about "${topic}".`;
    // Asked in another language than the pages are written in, and their concepts did not find it either: the model
    // asks once more in the pages' own language, before it hands off.
    const pagesHe = pages.length ? hebrewRatio(pages.map((p) => p.text).join('\n')) >= 0.5 : he;
    if (pagesHe !== he && /\p{L}/u.test(topic)) {
      const lang = pagesHe ? 'Hebrew' : 'English';
      return { ok: true, content: `${none}\nRule: the ${biz}'s pages are in ${lang}, and these words are not. Call get_policy once more with the topic in ${lang}, and answer in the ${c.company ? 'person' : 'customer'}'s own language. If that finds nothing either, you do not know the answer: ${checking}, and call handoff with reason "unknown". Do not guess what is usual, and do not say why you do not know.` };
    }
    return { ok: true, content: `${none}\nRule: you do not know the answer. Do not guess what is usual, and do not say why you do not know (nothing about what is or is not written). ${checking[0].toUpperCase()}${checking.slice(1)}, and call handoff with reason "unknown".` };
  }
  return {
    ok: true,
    content: `${parts.join('\n\n')}\nRule: answer only with what these passages say, in your own short words. A number, a time or a condition that is not written here, you do not know. If these passages are near the question but do not answer it (the ${c.company ? 'person' : 'customer'} asked about installation and they are about shipping), do not say what they lack: ${checking}, and call handoff with reason "unknown" in this same answer.`,
    facts: parts,
  };
}

async function getPlans(c: ToolContext): Promise<ToolOutcome> {
  const plans = await loadProducts(c.db, c.storeId);
  if (!plans.length) return { ok: true, content: 'No plans are written down.\nRule: you do not know the prices. Say you are not sure and that you passed the question to someone from our team (נציג), who will answer here, and call handoff with reason "unknown".' };
  const lines = plans.map((p) => `- ${p.title}: ${p.body_text} ${p.url}`);
  return { ok: true, content: `${lines.join('\n')}\nRule: quote prices, VAT, setup fees and what a plan covers exactly as written above. A plan, a price, a discount or a condition that is not written here, you do not know.`, facts: lines };
}

type Picked = { p: P; v: any; qty: number };

/** Where a product lives: its own page's host (the store's canonical one), else the store's. */
const originOf = (p: P, fallback: string) => {
  try {
    return new URL(p.url).origin;
  } catch {
    return fallback;
  }
};
const optionOf = (v: any) => (v && !/^default title$/i.test(String(v.title)) ? String(v.title) : null);
const itemLine = (x: Picked) => `${x.p.title}${optionOf(x.v) ? ` (${optionOf(x.v)})` : ''}${x.qty > 1 ? `, ${x.qty} units` : ''}`;

/**
 * The id WooCommerce adds to a cart: a simple product's own id, or a variation's. A variation's id is known only when
 * the catalogue came from the Store API (stores.config.catalogue); read from the sitemap, a product's options carry
 * its JSON-LD's SKUs, which add nothing, and only a one-option product's page id (ext_id) does. One row with a price
 * range is a variable product whose variations were not read: its own id would only open its page, so it gets none.
 */
function wooCartId(p: P, v: any, source: string | undefined): string | null {
  if (p.variants.length === 1) return /^\d+$/.test(p.ext_id) && (p.price_max == null || p.price_max === p.price_min) ? p.ext_id : null;
  return source === 'store-api' && v && /^\d+$/.test(String(v.id)) ? String(v.id) : null;
}

// A live cart, by platform: Shopify takes every item in one link (/cart/<variant>:<qty>,...); WooCommerce takes one
// product a link (?add-to-cart=<id>&quantity=<n>), so several items are several links that fill one cart in one
// browser; Wix has no address that fills a cart, so the customer gets the product pages and is told which option to
// pick. Every item is checked first: the product is in this store, the option is one of its own, and it is in stock.
async function cartLink(c: ToolContext, input: any): Promise<ToolOutcome> {
  const items = Array.isArray(input.items) ? input.items : [];
  const all = await loadProducts(c.db, c.storeId);
  const store = await c.db.one<{ platform: string; config: any }>('SELECT platform, config FROM stores WHERE id = $1', [c.storeId]);
  const platform = store?.platform || '';
  const picked: Picked[] = [];
  for (const it of items.slice(0, 10)) {
    const p = all.find((x) => x.id === Number(it.product_id));
    if (!p) return { ok: false, content: `No product with id ${it.product_id}. Search first.` };
    const given = it.variant_id != null && String(it.variant_id) !== '';
    const v = given ? p.variants.find((x: any) => String(x.id) === String(it.variant_id)) : p.variants.length === 1 ? p.variants[0] : null;
    if (given && !v) return { ok: false, content: `${p.title} has no option [variant ${it.variant_id}]. Call get_product for its options.` };
    if (!p.available || v?.available === false) return { ok: true, content: `${p.title}${optionOf(v) ? ` (${optionOf(v)})` : ''} is out of stock, so it cannot go in a cart. Tell the customer it is out of stock and offer to hand off to the store about restocking.` };
    picked.push({ p, v, qty: Math.min(20, Math.max(1, Math.floor(Number(it.quantity)) || 1)) });
  }
  if (!picked.length) return { ok: false, content: 'No items given.' };
  const pages = picked.map((x) => `${itemLine(x)}: ${x.p.url}`);
  const wixPages = `Wix has no link that fills a cart, so the customer orders from the product pages:\n${pages.join('\n')}\nRule: give these links, and say which option to pick on the page when there is one.`;
  if (c.demo !== false) {
    if (platform === 'wix') return { ok: true, content: `DEMO: ${wixPages.replace('so the customer', 'in the demo or in the live version, so the customer')}` };
    return { ok: true, content: `DEMO: in the live version this is one link to a ready cart. For now, the product pages:\n${pages.join('\n')}\nRule: give these links and say plainly that in the full version the customer would get a ready cart.` };
  }

  // A product with several options and none chosen: the cart needs one.
  const unchosen = picked.find((x) => !x.v && (platform === 'shopify' || (platform === 'woocommerce' && store?.config?.catalogue === 'store-api')));
  if (unchosen) return { ok: true, content: `${unchosen.p.title} comes in ${unchosen.p.variants.length} options, and the cart needs one.\nRule: ask the customer which option they want (get_product lists them), then call create_cart_link again with its variant_id.` };

  if (platform === 'shopify') {
    const url = `${originOf(picked[0].p, c.origin)}/cart/${picked.map((x) => `${x.v.id}:${x.qty}`).join(',')}`;
    return { ok: true, content: `One link to a ready cart with ${picked.map(itemLine).join('; ')}:\n${url}\nRule: give this link exactly as written. The customer checks the cart and pays on the store's own checkout.`, facts: [url] };
  }
  if (platform === 'woocommerce') {
    const lines = picked.map((x) => {
      const id = wooCartId(x.p, x.v, store?.config?.catalogue);
      return id ? `${itemLine(x)}: ${originOf(x.p, c.origin)}/?add-to-cart=${id}&quantity=${x.qty}` : `${itemLine(x)}: ${x.p.url} (its page: the option is picked there)`;
    });
    const one = lines.length === 1;
    return { ok: true, content: `${one ? 'A link that puts the item in the cart' : 'Links that put each item in the cart (the store takes one product a link; opened one after another in the same browser, they fill one cart)'}:\n${lines.join('\n')}\nRule: give ${one ? 'this link' : 'these links'} exactly as written. The customer checks the cart and pays on the store's own checkout.`, facts: lines };
  }
  if (platform === 'wix') return { ok: true, content: wixPages };
  return { ok: true, content: `The product pages, where the customer adds the item to the cart:\n${pages.join('\n')}\nRule: give these links.` };
}

const ORDER_TRIES = 3;
const israelDay = (iso: string) => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', year: 'numeric' }).format(new Date(iso));

// An order is looked up only on a live turn, in the store's own system (src/orders.ts), and told only to whoever
// wrote the email or phone number on it, or writes from that phone on the store's WhatsApp. A number that is not
// there and details that do not match get the same answer, so a guess learns nothing; after ORDER_TRIES of them in
// one conversation the question goes to the store.
async function orderStatus(c: ToolContext, input: any): Promise<ToolOutcome> {
  const order = String(input.order_number || '').trim().slice(0, 30);
  // Nothing in a demo goes to the store (prompt.ts DEMO_NOTE): it says what a live store does, never that someone checks.
  if (c.demo !== false) return { ok: true, content: `DEMO: this demo is not connected to the store's orders, so order ${order} cannot be looked up.\nRule: say in one short sentence that once the store connects its orders, Toran tells a customer here where their order is, and that with a real customer this would now go to the store. Never say that someone will check it or get back to them here. Then call handoff with reason "order", as a live conversation would.` };
  const toStore = (why: string): ToolOutcome => ({ ok: true, content: `${why}\nRule: tell the customer you are passing it to the store, who will answer here, and call handoff with reason "order".` });
  const access = await orderAccessOf(c.db, c.storeId);
  if (!access) return toStore(`The store's orders are not connected here, so order ${order} cannot be looked up.`);
  if (access.status !== 'active') return toStore(`The store's order system did not accept its key, so order ${order} cannot be looked up now.`);
  if (!/^#?[A-Za-z0-9-]{1,30}$/.test(order)) return { ok: true, content: `"${order}" is not an order number.\nRule: ask the customer for the order number, as it appears in the order confirmation.` };

  const said = contactsIn(c.said || []);
  if (c.conversationId) {
    const tried = await c.db.one<{ n: number }>("SELECT COUNT(*)::int AS n FROM messages m, jsonb_array_elements(m.tools) t WHERE m.conversation_id = $1 AND t->>'name' = 'get_order_status' AND t->>'result' LIKE 'NO MATCH%'", [c.conversationId]);
    if ((tried?.n || 0) >= ORDER_TRIES) return toStore('Several order numbers and details did not match in this conversation, so the store checks this one itself.');
  }
  let o: Order | null;
  try {
    o = await findOrder({ db: c.db, env: c.env || {}, api: c.api || fetch }, c.storeId, order);
  } catch (e: any) {
    return toStore(`The store's order system did not answer (${String(e?.message || e).slice(0, 120)}).`);
  }
  // Writing from the order's own phone (or email) is enough. Anyone else is asked for the phone number the order was
  // placed with, and a missing order is asked the same, so the question says nothing about whether it exists.
  if (!o || !(fromOrder(o, { waPhone: c.waPhone, email: c.fromEmail }) || phoneGiven(o, said))) {
    if (!said.phones.length) return { ok: true, content: `ASK PHONE: the customer is not writing from the phone number on order ${order}, so first make sure it is really them.\nRule: ask in one short question for the phone number the order was placed with. Say nothing about the order before it matches, not even whether it exists.` };
    return { ok: true, content: `NO MATCH: no order ${order} goes with the phone number the customer gave.\nRule: say you could not find an order with this number and phone, and ask them to check the order number and the phone number they ordered with. Do not say which of them did not match. If it does not match again, tell them you are passing it to the store and call handoff with reason "order".` };
  }

  // Only now, with the order theirs, where its packages are (src/tracking.ts): one link each, the website's tracking
  // page when the store has one, else the store's own tracking link.
  const store = await c.db.one<{ tracking_page: string | null }>('SELECT tracking_page FROM stores WHERE id = $1', [c.storeId]);
  const told = shipmentsTold(store?.tracking_page, o.number, o.shipments);
  const ships = told.map((s) => {
    const what = [s.status, s.company ? `with ${s.company}` : null, s.number ? `tracking number ${s.number}` : null];
    return `- ${what.filter(Boolean).join(', ') || 'a shipment'}${s.link ? `, tracking link: ${s.link}` : ''}`;
  });
  const page = told.length ? null : pageFor(store?.tracking_page, null, o.number);
  const lines = [
    `Order ${o.number}${o.placed ? `, placed ${israelDay(o.placed)}` : ''}: ${o.status}.`,
    ships.length ? `Shipments:\n${ships.join('\n')}` : 'No tracking details on the order.',
    ...(page ? [`The store's own tracking page, where the customer can follow the order, tracking link: ${page}`] : []),
  ];
  return {
    ok: true,
    content: `${lines.join('\n')}\nRule: tell the customer this status in your own short words, with the tracking link exactly as written when there is one. Say it in plain, natural Hebrew, the way the store's own staff would text it ("ההזמנה יצאה והיא בדרך"): the status in your own Hebrew words, with no status codes and no English. A status, a place or a time the lines above do not give, you never say. A delivery date, the reason for a delay, or anything the lines above do not say, you do not know. To change, cancel or return the order, or for a refund: tell them you are passing it to the store and call handoff with reason "order".`,
    facts: lines,
  };
}

export async function runTool(c: ToolContext, name: string, input: any): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'search_products':
        return await searchProducts(c, input || {});
      case 'get_product':
        return await getProduct(c, input || {});
      case 'view_product_images':
        return await viewProductImages(c, input || {});
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
        // In a demo nobody sees it (loop.ts tells no one): what would happen with a real customer, never a reply to wait for.
        const content = c.company
          ? 'Handed off: someone at the company sees this conversation now.\nRule: tell the person in one short sentence that someone from us will get back to them here. No promises about what we will decide or when.'
          : c.demo !== false
            ? 'Handed off, in a demo: nothing goes to anyone from here, and nobody will reply in this conversation.\nRule: tell them in one short sentence that with a real customer this question would now go to them, the store, who answer it ("אצל לקוח אמיתי השאלה הייתה עוברת עכשיו אליכם, ואתם עונים לו."). Never say that someone will get back to them here.'
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
