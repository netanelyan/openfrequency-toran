import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { App } from '../app.ts';
import { ensureDir, home } from '../core/paths.ts';
import { type Db, J, V } from '../db/index.ts';
import { event } from '../db/log.ts';
import { readHome } from '../leads/signals.ts';
import type { Fetcher } from '../core/http.ts';
import { siteBase } from '../core/urls.ts';
import { readBrand } from './brand.ts';
import { embed } from './embed.ts';
import { logoColors } from './logo.ts';
import { chunk, faqJsonLd, readPolicies, standardPaths } from './pages.ts';
import { INGESTIBLE_EN, canIngest, livePrice, readCatalogue } from './catalogue.ts';
import { pageLinks } from './sitemap.ts';

// Ingest: a store's URL in, its knowledge pack out. One normalized format for every
// store, in the database:
//
//   products   one row per product, variants with their own price and stock, the
//              search text; the owner's corrections in `override`, never touched here
//   policies   shipping, returns, payment, contact, about, FAQ, terms, as written
//   chunks     the policies cut to paragraphs, each with its embedding
//   faqs       questions found on the site, the site's answer when it gives one, and
//              a slot for the owner's answer
//   brand      logo, two colours, a tone sample in the store's own words
//
// Re-running it (the daily re-scrape) updates every scraped column, marks products
// that left the feed as gone, replaces policies and chunks, and keeps every override
// and every FAQ answer the owner wrote.
//
// Shopify, WooCommerce, Wix and Cashcow are read (catalogue.ts says how each one's
// products are read; the policies are found the same way on all four). Other platforms
// are detected, scored and listed, and stop here with a clear reason.
//
// A store whose site names no colour is given its logo's (logo.ts), when its logo is
// its mark and not a share photo; the review screen says where the colour came from.

export type IngestSummary = { storeId: number; domain: string; products: number; available: number; gone: number; policies: { kind: string; title: string; chars: number }[]; chunks: number; faqs: number; brand: { colors: string[]; logo: boolean; tone: boolean; colorsFrom: string | null }; currency: string; warnings: string[] };

export class IngestError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export async function ingestStore(app: App, storeId: number, { progress = (_m: string) => {} }: { progress?: (m: string) => void } = {}): Promise<IngestSummary> {
  const { db, fetcher } = app;
  const store = await db.one<any>('SELECT * FROM stores WHERE id = $1', [storeId]);
  if (!store) throw new IngestError('no such store', 'missing');
  if (store.platform === 'konimbo') throw new IngestError(`Konimbo answers a request with no referring page with a "go to the requested page" screen, so its stores cannot be read: Toran reads ${INGESTIBLE_EN} stores`, 'platform');
  if (!canIngest(store.platform)) throw new IngestError(`ingest for ${store.platform} is not built yet: Toran reads ${INGESTIBLE_EN} stores`, 'platform');
  const base = siteBase(store.url);

  const cat = await readCatalogue(fetcher, store.platform, base, progress);
  const warnings: string[] = [...cat.warnings];
  const rows = cat.rows;
  const currency = cat.currency || 'ILS';
  if (currency !== 'ILS') warnings.push(`the store's currency is ${currency}, not ILS`);
  if (!rows.length) throw new IngestError('the product feed is empty', 'empty');

  progress('קורא את דף הבית');
  const home = await fetcher(store.url, { accept: 'text/html' });
  const hs = readHome(home.text, home.url);
  const brand = readBrand(home.text, home.url, { name: cat.name || store.name, logo: hs.logo });
  if (!brand.colors?.length && brand.logo && brand.logoIsMark) {
    progress('קורא את הצבע מהלוגו');
    const fromLogo = await logoColorsAt(fetcher, brand.logo);
    if (fromLogo.length) Object.assign(brand, { colors: fromLogo, colorsFrom: 'logo' });
  }

  progress('קורא את המדיניות: משלוחים, החזרות, תשלום');
  // The home page's links first (their words name the page), then, off Shopify, the pages the sitemap lists.
  const links = [...(hs.policyLinks.length ? hs.policyLinks : store.signals?.policyLinks || []), ...(store.platform === 'shopify' ? [] : await pageLinks(fetcher, base, store.platform))];
  const read = await readPolicies(fetcher, base, links, { standard: standardPaths(store.platform) });
  const { pages, errors } = read;
  // A FAQPage the home page publishes (some themes put the questions there) counts as the FAQ's.
  const faqs = [...read.faqs, ...faqJsonLd(home.text, home.url).filter((f) => !read.faqs.some((x) => x.question === f.question))].slice(0, 40);
  if (!pages.some((p) => p.kind === 'shipping')) warnings.push('no shipping policy page found');
  if (!pages.some((p) => p.kind === 'returns')) warnings.push('no returns policy page found');
  for (const e of errors) warnings.push(`policy page ${e}`);

  progress('מכין את חיפוש המדיניות');
  // Each chunk carries its page's title (so "returns" text is found by a returns question), once: a page whose text
  // already opens with its title does not get it twice.
  const pieces = pages.flatMap((p, i) => chunk(p.text).map((text) => ({ page: i, kind: p.kind, text: text.startsWith(p.title) ? text : `${p.title}\n${text}` })));
  const vectors = await embed(pieces.map((p) => p.text), 'passage', app.env);
  if (!vectors) warnings.push('embeddings are off: get_policy matches words only');

  progress('שומר');
  let gone = 0;
  await db.tx(async (t) => {
    const ids: string[] = [];
    for (const r of rows) {
      ids.push(r.ext_id);
      await t.query(
        `INSERT INTO products (store_id, ext_id, handle, title, vendor, product_type, tags, url, image, currency, price_min, price_max, compare_at_max, available, variants, body_text, search_text, source_updated_at, image_count, scraped_at, gone_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,now(),NULL)
         ON CONFLICT (store_id, ext_id) DO UPDATE SET handle = EXCLUDED.handle, title = EXCLUDED.title, vendor = EXCLUDED.vendor, product_type = EXCLUDED.product_type, tags = EXCLUDED.tags,
           url = EXCLUDED.url, image = EXCLUDED.image, currency = EXCLUDED.currency, price_min = EXCLUDED.price_min, price_max = EXCLUDED.price_max, compare_at_max = EXCLUDED.compare_at_max,
           available = EXCLUDED.available, variants = EXCLUDED.variants, body_text = EXCLUDED.body_text, search_text = EXCLUDED.search_text, source_updated_at = EXCLUDED.source_updated_at, image_count = EXCLUDED.image_count, scraped_at = now(), gone_at = NULL`,
        [storeId, r.ext_id, r.handle, r.title, r.vendor, r.product_type, r.tags, r.url, r.image, r.currency, r.price_min, r.price_max, r.compare_at_max, r.available, J(r.variants), r.body_text, r.search_text, r.source_updated_at, r.image_count],
      );
    }
    const g = await t.query<{ id: number }>('UPDATE products SET gone_at = now() WHERE store_id = $1 AND gone_at IS NULL AND NOT (ext_id = ANY($2::text[])) RETURNING id', [storeId, ids]);
    gone = g.length;

    // Policies: replaced, except an owner's correction, which carries over by URL.
    const keep = new Map((await t.query<{ url: string; override_text: string | null }>('SELECT url, override_text FROM policies WHERE store_id = $1 AND override_text IS NOT NULL', [storeId])).map((r) => [r.url, r.override_text]));
    await t.query('DELETE FROM policies WHERE store_id = $1', [storeId]);
    const policyIds: number[] = [];
    for (const p of pages) {
      const row = await t.one<{ id: number }>('INSERT INTO policies (store_id, kind, title, url, text, override_text) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [storeId, p.kind, p.title.slice(0, 200), p.url, p.text, keep.get(p.url) ?? null]);
      policyIds.push(row!.id);
    }
    for (const [i, c] of pieces.entries()) {
      await t.query(`INSERT INTO chunks (store_id, policy_id, kind, text, embedding) VALUES ($1,$2,$3,$4,${vectors ? '$5::vector' : 'NULL'})`, vectors ? [storeId, policyIds[c.page], c.kind, c.text, V(vectors[i])] : [storeId, policyIds[c.page], c.kind, c.text]);
    }

    // FAQ: new questions are added; a question already there keeps the owner's answer.
    for (const f of faqs) {
      const have = await t.one('SELECT id FROM faqs WHERE store_id = $1 AND question = $2', [storeId, f.question]);
      if (have) await t.query('UPDATE faqs SET site_answer = $2, source_url = $3 WHERE id = $1', [have.id, f.site_answer, f.source_url]);
      else await t.query('INSERT INTO faqs (store_id, question, site_answer, source_url) VALUES ($1,$2,$3,$4)', [storeId, f.question, f.site_answer, f.source_url]);
    }

    await t.query(
      `UPDATE stores SET brand = $2::jsonb, name = COALESCE(NULLIF($3, ''), name), ingested_at = now(), updated_at = now(), config = config || $4::jsonb WHERE id = $1`,
      [storeId, J(brand), cat.name || '', J({ currency, moneyFormat: cat.moneyFormat })],
    );
  });
  const available = rows.filter((r) => r.available).length;
  const summary: IngestSummary = {
    storeId,
    domain: store.domain,
    products: rows.length,
    available,
    gone,
    policies: pages.map((p) => ({ kind: p.kind, title: p.title, chars: p.text.length })),
    chunks: pieces.length,
    faqs: faqs.length,
    brand: { colors: brand.colors || [], logo: Boolean(brand.logo), tone: Boolean(brand.tone), colorsFrom: brand.colorsFrom || null },
    currency,
    warnings,
  };
  await event(db, storeId, 'ingest', { source: cat.source, products: rows.length, available, gone, policies: pages.length, chunks: pieces.length, faqs: faqs.length, warnings });
  return summary;
}

/** The colours of the logo at a URL (logo.ts); [] when it does not load or has none. One request, 3 MB at most. */
async function logoColorsAt(fetcher: Fetcher, url: string): Promise<string[]> {
  try {
    const r = await fetcher(url, { accept: 'image/png,image/jpeg,image/svg+xml;q=0.9,image/*;q=0.5', binary: true, maxBytes: 3 * 1024 * 1024 });
    return logoColors(r.bytes ?? new TextEncoder().encode(r.text));
  } catch {
    return [];
  }
}

/**
 * The check behind "correct prices": for a sample of products, the price the store
 * shows now, from a different source than the one ingest read (catalogue.ts livePrice:
 * Shopify's /products/<handle>.js in agorot, WooCommerce's single-product route, a
 * Cashcow page's analytics price, a product page's JSON-LD), against what is stored. A
 * difference is a failed check.
 */
export async function verifyPrices(app: App, storeId: number, sample = 12): Promise<{ checked: number; ok: number; mismatches: { title: string; stored: number | null; live: number | null }[] }> {
  const store = await app.db.one<any>('SELECT url, platform FROM stores WHERE id = $1', [storeId]);
  const origin = siteBase(store.url);
  const rows = await app.db.query<any>('SELECT ext_id, title, handle, url, price_min::float AS price_min, variants FROM products WHERE store_id = $1 AND gone_at IS NULL ORDER BY random() LIMIT $2', [storeId, sample]);
  const mismatches: { title: string; stored: number | null; live: number | null }[] = [];
  let checked = 0;
  for (const r of rows) {
    const live = await livePrice(app.fetcher, store.platform, origin, r);
    if (!live) continue;
    checked++;
    const storedVariants = new Map((r.variants as any[]).map((v) => [String(v.id), v.price]));
    const variantOk = (live.variants || []).every((v) => !storedVariants.has(v.id) || Math.abs(Number(storedVariants.get(v.id)) - v.price) < 0.005);
    if (Math.abs(Number(r.price_min) - Number(live.price_min)) >= 0.005 || !variantOk) mismatches.push({ title: r.title, stored: r.price_min, live: live.price_min });
  }
  return { checked, ok: checked - mismatches.length, mismatches };
}

/** The pack as one JSON file in private/packs/, to read or diff. */
export async function exportPack(db: Db, storeId: number): Promise<string> {
  const store = await db.one<any>('SELECT id, domain, name, url, platform, brand, brand_override, config FROM stores WHERE id = $1', [storeId]);
  const products = await db.query<any>('SELECT ext_id, title, handle, url, image, currency, price_min::float, price_max::float, compare_at_max::float, available, variants, product_type, vendor, tags, override FROM products WHERE store_id = $1 AND gone_at IS NULL ORDER BY title', [storeId]);
  const policies = await db.query<any>('SELECT kind, title, url, COALESCE(override_text, text) AS text FROM policies WHERE store_id = $1 ORDER BY kind', [storeId]);
  const faqs = await db.query<any>('SELECT question, site_answer, answer FROM faqs WHERE store_id = $1 ORDER BY id', [storeId]);
  const file = path.join(ensureDir(path.join(home(), 'packs')), `${store.domain}.json`);
  writeFileSync(file, JSON.stringify({ store, products, policies, faqs }, null, 2));
  return file;
}
