import type { Detection } from './detect.ts';

// How good a lead a store is for Toran, out of 100, with every factor's points and
// the evidence behind them stored (tiyul-social kept only a total and prose).
//
// Who Toran is for: an Israeli online store big enough to get customer questions
// every day, small enough that the owner answers them personally, that already
// sells on WhatsApp, and that we can reach.
//
//   platform   20  Shopify 20, WooCommerce 18, Wix 14 (the three ingest reads: Shopify's feed
//                  and Woo's Store API whole, Wix page by page), Konimbo/Cashcow 8,
//                  Magento/BigCommerce 6, a cart on an unknown platform 4
//   catalogue  25  30-499 products 25; 10-29 14; 500-999 18; 1,000-1,999 10; 2,000+ 3
//                  (a chain's catalogue); 1-9 6; unknown 5
//   Hebrew     15  the share of Hebrew in the visible text: 60%+ 15, 35%+ 10, 15%+ 4
//   WhatsApp   15  a number on the site 15; a chat button with no number in the HTML 8
//   email      10  any email 10 (one on the store's own domain is the same 10)
//   phone       3  a phone number
//   alive       7  a product updated in the last 60 days 7, in the last year 3, unknown 2
//   Israeli     5  .co.il, prices in shekels, or an Israeli phone
//   chain     -25  a branch locator, the local site of an international brand, or 2,000+ products
//   restricted -10 alcohol (restricted on WhatsApp Business); adult products, tobacco and vapes,
//                  weapons and drugs are rejected outright: Meta's commerce policy bars them
//
// Rejected outright (score kept for the record, never qualified): unreachable, not a
// store (no platform, no cart, no products), no Hebrew and nothing Israeli, a store
// with zero products, and a store we have no way to reach.
//
// Qualified: no rejection and a score of 55 or more.

export type Factor = { factor: string; points: number; max: number; evidence: string };
export type Score = { score: number; breakdown: Factor[]; qualified: boolean; reject: string | null };

export const QUALIFY_AT = 55;

const DAY = 86_400_000;

export function scoreStore(d: Detection, now = Date.now()): Score {
  const b: Factor[] = [];
  const add = (factor: string, points: number, max: number, evidence: string) => b.push({ factor, points, max, evidence });
  let reject: string | null = null;

  // platform
  const P: Record<string, number> = { shopify: 20, woocommerce: 18, wix: 14, konimbo: 8, cashcow: 8, magento: 6, bigcommerce: 6, other: 4, unknown: 0 };
  add('platform', P[d.platform] ?? 0, 20, d.platform === 'unknown' ? 'no store platform found' : `${d.platform}: ${d.platformEvidence}`);

  // catalogue
  const n = d.productCount;
  let cat = 5;
  let catWhy = 'product count unknown';
  if (n != null) {
    const nTxt = `${n}${d.productCountCapped ? '+' : ''} products (${d.productCountSource})`;
    if (n === 0) [cat, catWhy] = [0, `${nTxt}: an empty store`];
    else if (n < 10) [cat, catWhy] = [6, `${nTxt}: very small`];
    else if (n < 30) [cat, catWhy] = [14, nTxt];
    else if (n < 500) [cat, catWhy] = [25, `${nTxt}: the sweet spot`];
    else if (n < 1000) [cat, catWhy] = [18, `${nTxt}: large`];
    else if (n < 2000) [cat, catWhy] = [10, `${nTxt}: very large`];
    else [cat, catWhy] = [3, `${nTxt}: chain-sized`];
  }
  add('catalogue', cat, 25, catWhy);

  // Hebrew: the visible text, or the catalogue's titles when they say more
  const he = Math.max(d.home.hebrewRatio, d.catalogHebrewRatio ?? 0);
  const heLang = d.home.lang?.startsWith('he') || d.home.dir === 'rtl';
  const hePts = he >= 0.6 ? 15 : he >= 0.35 ? 10 : he >= 0.15 ? 4 : 0;
  add('hebrew', hePts, 15, `${Math.round(he * 100)}% Hebrew letters${heLang ? ', lang/dir he/rtl' : ''}`);

  // WhatsApp
  if (d.whatsapp) add('whatsapp', 15, 15, `WhatsApp number on the site (${mask(d.whatsapp)})`);
  else if (d.home.whatsappWidget) add('whatsapp', 8, 15, `WhatsApp chat button (${d.home.whatsappWidget})`);
  else add('whatsapp', 0, 15, 'no WhatsApp on the site');

  add('email', d.email ? 10 : 0, 10, d.email ? `email found${d.email.endsWith(`@${d.domain}`) ? ' on the store domain' : ''}` : 'no email found');
  add('phone', d.phone ? 3 : 0, 3, d.phone ? 'phone found' : 'no phone found');

  // alive
  if (d.newestProductAt) {
    const age = (now - Date.parse(d.newestProductAt)) / DAY;
    add('alive', age <= 60 ? 7 : age <= 365 ? 3 : 0, 7, `newest product update ${Math.round(age)} days ago`);
  } else add('alive', 2, 7, 'activity unknown');

  // Israeli
  const il = [d.domain.endsWith('.il') && '.il domain', d.home.shekel && 'prices in shekels', [d.phone, d.whatsapp].some((p) => p?.startsWith('972')) && 'Israeli phone'].filter(Boolean) as string[];
  add('israeli', il.length ? 5 : 0, 5, il.length ? il.join(', ') : 'nothing Israeli found');

  // chain
  const chain = d.home.storeLocator ? 'a branch locator' : d.franchiseOf ? `the local site of ${d.franchiseOf}` : n != null && n >= 2000 ? `${n}+ products: a chain's catalogue` : null;
  if (chain) add('chain', -25, 0, chain);

  // What a store sells must be allowed on WhatsApp Business (Meta's commerce policy): adult products, tobacco and
  // vapes, weapons and drugs are not, so Toran cannot serve the store at all. Alcohol is restricted (age and country
  // rules): a penalty and a note for the owner, not a rejection.
  const restricted = restrictedCategory(d);
  if (restricted?.level === 'alcohol') add('restricted', -10, 0, restricted.evidence);

  const score = Math.max(0, b.reduce((s, f) => s + f.points, 0));

  if (restricted && restricted.level !== 'alcohol') reject = `sells what WhatsApp Business does not allow (${restricted.evidence})`;
  else if (d.platform === 'unknown' && !d.productCount) reject = 'not an online store (no platform, cart or products found)';
  else if (n === 0) reject = 'the store has no products';
  else if (he < 0.15 && !heLang && !il.length) reject = 'not an Israeli Hebrew store';
  else if (!d.email && !d.whatsapp && !d.phone) reject = 'no way to reach the owner (no email, WhatsApp or phone on the site)';

  return { score, breakdown: b, qualified: !reject && score >= QUALIFY_AT, reject };
}

/** A phone number with its middle hidden, for evidence lines that end up in logs. */
export const mask = (intl: string) => (intl.length > 7 ? `${intl.slice(0, 5)}•••${intl.slice(-2)}` : '•••');

const RESTRICTED: [string, RegExp][] = [
  ['adult products', /\b(sex ?toys?|vibrators?|dildos?|erotic|bdsm)\b|צעצועי מין|אביזרי מין|ויברטור|דילדו|ארוטי/i],
  ['tobacco or vapes', /\b(vapes?|vaping|e-?cigs?|e-liquids?|hookahs?|shisha|tobacco|cigars?|cigarettes?)\b|ווייפ|וייפ|סיגריות|סיגריה אלקטרונית|טבק|נרגילה|נרגילות/i],
  ['weapons', /\b(firearms?|ammunition|ammo|pistols?|rifles?)\b|תחמושת|כלי נשק|אקדחים|רובים/i],
  ['drugs', /\b(cannabis|thc|marijuana|kratom)\b|קנאביס|מריחואנה/i],
  ['alcohol', /\b(wines?|whiske?y|vodka|gin|rum|tequila|liquor|spirits|craft beer)\b|יינות|ויסקי|וודקה|ליקר|אלכוהול|בירות/i],
];

/** A category Meta restricts on WhatsApp Business, from the store's own titles and copy, or null. */
export function restrictedCategory(d: Detection): { level: string; evidence: string } | null {
  const text = [d.home.title, d.home.description, ...(d.catalogSample || [])].filter(Boolean).join('\n');
  for (const [what, re] of RESTRICTED) {
    const hits = text.match(new RegExp(re.source, 'gi')) || [];
    // One stray word is not a category: two mentions, or one in the store's own title or description.
    const inHead = re.test(`${d.home.title} ${d.home.description || ''}`);
    if (hits.length >= 2 || inHead) return { level: what === 'alcohol' ? 'alcohol' : 'banned', evidence: `${what}: "${hits[0] || ''}"` };
  }
  return null;
}

