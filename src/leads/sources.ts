import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { home } from '../core/paths.ts';
import { canonicalDomain } from '../core/urls.ts';
import type { Fetcher } from '../core/http.ts';
import type { Db } from '../db/index.ts';
import { usage } from '../db/log.ts';
import { readHome } from './signals.ts';

// Where candidate stores come from. Every source yields { url, source, detail }; the
// discovery run decides what is new.
//
//   storecensus  the public directory of Shopify stores based in Israel
//                (storecensus.com/stores/country/israel?page=N; its robots.txt allows
//                it). Read a page at a time, politely.
//   brave        the Brave Search API (an official API, never Google's results page),
//                Hebrew store queries rotated by day. Needs BRAVE_API_KEY.
//   seeds        private/seeds.txt: a store URL a line, or "dir: <url>" for a directory
//                page whose outbound links are all candidates.
//   crawl        the links between stores: every qualified store's home page links to
//                partners, makers and stockists; those sites are candidates at depth 1.
//
// No Instagram, by rule: Instagram stays manual.

export type Candidate = { url: string; source: string; detail: Record<string, unknown> };

// ---------------------------------------------------------------- StoreCensus
export async function* storecensus(fetcher: Fetcher, { fromPage = 1, pages = 3 }: { fromPage?: number; pages?: number } = {}): AsyncGenerator<Candidate> {
  for (let p = fromPage; p < fromPage + pages; p++) {
    const url = `https://www.storecensus.com/stores/country/israel?page=${p}`;
    let r;
    try {
      r = await fetcher(url, { accept: 'text/html' });
    } catch {
      continue; // a directory page that does not answer today: the next one may
    }
    const domains = new Set<string>();
    for (const m of r.text.matchAll(/storecensus\.com\/stores\/([a-z0-9][a-z0-9.-]+\.[a-z]{2,})(?=["'\/?#\\])/gi)) {
      if (/^country$/i.test(m[1])) continue;
      domains.add(m[1].toLowerCase());
    }
    if (!domains.size) return;
    for (const d of domains) yield { url: `https://${d}/`, source: 'storecensus', detail: { page: p } };
  }
}

// ---------------------------------------------------------------- Brave Search
// Categories Israeli online stores sell in, and query shapes that surface a store's own
// site rather than a marketplace or an article. Rotated by day so each run asks new ones.
export const CATEGORIES = ['תכשיטים', 'בגדי נשים', 'בגדי ילדים', 'קוסמטיקה טבעית', 'קרמיקה', 'עיצוב הבית', 'צעצועים', 'ציוד לכלבים', 'קפה', 'תה', 'יין', 'שוקולד', 'מתנות', 'נרות', 'תיקים', 'נעליים', 'ספורט', 'יודאיקה', 'צמחים', 'כלי מטבח', 'ספרים', 'בגדי ים', 'הלבשה תחתונה', 'משחקי קופסה', 'אביזרי טלפון', 'טיפוח לגבר', 'מוצרי תינוקות', 'כלי כתיבה', 'אופניים', 'תבלינים'];
const SHAPES = ['חנות אונליין {c} משלוחים לכל הארץ', '{c} קנייה אונליין חנות ישראלית', 'חנות {c} באתר משלוח עד הבית'];

export function braveQueries(day: number, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = CATEGORIES[(day * n + i) % CATEGORIES.length];
    const s = SHAPES[(day + i) % SHAPES.length];
    out.push(s.replace('{c}', c));
  }
  return out;
}

const MARKETPLACES = /(^|\.)(zap|ksp|ivory|bug|shufersal|ebay|aliexpress|amazon|etsy|facebook|instagram|tiktok|youtube|wikipedia|ynet|walla|mako|calcalist|themarker|globes|haaretz|maariv|ice|tripadvisor|easy|d|b144|rest|10bis|wolt|yad2|madlan|google|pinterest|reddit|linkedin|terminalx|next|asos|shein|temu|lastprice|ace|homecenter|superpharm|be|golfco|fox|castro|h-m|zara)\.(co\.il|com|co|net|org)$/i;

export async function* brave(db: Db, { apiKey, queries, perQuery = 20, fetchImpl = fetch }: { apiKey: string; queries: string[]; perQuery?: number; fetchImpl?: typeof fetch }): AsyncGenerator<Candidate> {
  for (const q of queries) {
    const u = new URL('https://api.search.brave.com/res/v1/web/search');
    u.searchParams.set('q', q);
    u.searchParams.set('count', String(perQuery));
    u.searchParams.set('search_lang', 'he');
    u.searchParams.set('country', 'ALL'); // Brave rejects country=IL (found in tiyul-social)
    const res = await fetchImpl(u, { headers: { accept: 'application/json', 'x-subscription-token': apiKey } });
    await usage(db, { kind: 'search', backend: 'brave', units: 1, usd: 0.005, tag: 'discovery' });
    if (res.status === 401 || res.status === 403) throw new Error(`Brave refused the key (${res.status})`);
    if (res.status === 429) throw new Error('Brave rate limit reached');
    if (!res.ok) continue;
    const data: any = await res.json();
    for (const r of data?.web?.results || []) {
      const d = canonicalDomain(r.url);
      if (!d || MARKETPLACES.test(d)) continue;
      yield { url: `https://${new URL(r.url).hostname}/`, source: 'brave', detail: { query: q, title: String(r.title || '').slice(0, 120) } };
    }
    await new Promise((r) => setTimeout(r, 1100)); // Brave's free tier allows one query a second
  }
}

// ---------------------------------------------------------------- the seed file
export async function* seeds(fetcher: Fetcher, file = path.join(home(), 'seeds.txt')): AsyncGenerator<Candidate> {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const dir = /^dir:\s*(\S+)/i.exec(line);
    if (!dir) {
      yield { url: line, source: 'seed', detail: {} };
      continue;
    }
    try {
      const r = await fetcher(dir[1], { accept: 'text/html' });
      for (const ext of readHome(r.text, r.url).externalLinks) yield { url: ext, source: 'seed', detail: { directory: dir[1] } };
    } catch {
      /* a directory that does not answer today */
    }
  }
}

// ---------------------------------------------------------------- crawling between stores
/** Add a qualified store's outbound links to the frontier (depth = the store's depth + 1, at most 2). */
export async function addToFrontier(db: Db, fromDomain: string, links: string[], depth = 1) {
  if (depth > 2) return;
  for (const l of links) {
    const d = canonicalDomain(l);
    if (!d || d === fromDomain || MARKETPLACES.test(d)) continue;
    await db.query('INSERT INTO crawl_frontier (url, domain, depth, found_from) VALUES ($1, $2, $3, $4) ON CONFLICT (url) DO NOTHING', [l, d, depth, fromDomain]);
  }
}

export async function* crawl(db: Db, { limit = 40 }: { limit?: number } = {}): AsyncGenerator<Candidate> {
  const rows = await db.query<{ url: string; depth: number; found_from: string }>("SELECT url, depth, found_from FROM crawl_frontier WHERE status = 'todo' ORDER BY depth, added_at LIMIT $1", [limit]);
  for (const r of rows) {
    await db.query("UPDATE crawl_frontier SET status = 'done', visited_at = now() WHERE url = $1", [r.url]);
    yield { url: r.url, source: 'crawl', detail: { from: r.found_from, depth: r.depth } };
  }
}

