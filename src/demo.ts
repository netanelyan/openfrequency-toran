import { readFileSync } from 'node:fs';
import path from 'node:path';
import { examplesDir } from './core/paths.ts';
import { type Fetcher, FetchError } from './core/http.ts';

// The fictional store, kli-cheres.example ("כלי חרס של נורית"), served offline: the
// only store data in this repository, with fictional stores on the other platforms
// Toran reads, each a folder under examples/ whose site.json maps an address to what
// the store answers there (their shapes recorded from real stores):
//
//   tavlinim-ba-shuk.example   WooCommerce, read through its Store API (examples/woo-store)
//   beit-hasabon.example       WooCommerce with the Store API behind a firewall, read
//                              from its sitemap (examples/woo-sitemap-store)
//   www.quiet-candles.example  Wix (examples/wix-store)
//   www.etz-tzaatzuim.example  Cashcow (examples/cashcow-store)
//   noa-example.wixsite.com    a free Wix site under a path, /shop (examples/wixsite-store)
//
// A route may answer bytes (`base64`, for a logo) or land somewhere else (`redirect`,
// the path a redirect would end on).
//
// Tests, `npm run demo` and the screenshots run discovery, ingest, the agent and the
// pitch page against them with no network.

export const EXAMPLE_DOMAIN = 'kli-cheres.example';
export const EXAMPLE_URL = `https://${EXAMPLE_DOMAIN}/`;
const dir = path.join(examplesDir, 'store');
const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');

export const WOO_DOMAIN = 'tavlinim-ba-shuk.example';
export const WOO_SITEMAP_DOMAIN = 'beit-hasabon.example';
export const WIX_DOMAIN = 'quiet-candles.example';
export const CASHCOW_DOMAIN = 'etz-tzaatzuim.example';
export const WIXSITE_URL = 'https://noa-example.wixsite.com/shop';

type Route = { file?: string; text?: string; base64?: string; type?: string; headers?: Record<string, string>; first?: number; redirect?: string };
type Site = { host: string; dir: string; routes: Record<string, Route> };

function loadSites(): Map<string, Site> {
  const sites = new Map<string, Site>();
  for (const name of ['woo-store', 'woo-sitemap-store', 'wix-store', 'cashcow-store', 'wixsite-store']) {
    const d = path.join(examplesDir, name);
    const s = JSON.parse(readFileSync(path.join(d, 'site.json'), 'utf8'));
    sites.set(s.host.replace(/^www\./, ''), { host: s.host, dir: d, routes: s.routes });
  }
  return sites;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=UTF-8', '.json': 'application/json; charset=UTF-8', '.xml': 'application/xml; charset=UTF-8' };

/** What one of the other fictional stores answers at a URL, or null (a 404). A request to the bare domain lands on the www one, as a redirect would. */
function siteAnswer(site: Site, u: URL): { text: string; contentType: string; headers: Record<string, string>; url: string; bytes?: Uint8Array } | null {
  let p = u.pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* kept as sent */
  }
  const bare = p.replace(/\/$/, '') || '/';
  const keys = [p + u.search, bare + u.search, `${bare}/${u.search}`, ...(u.search ? [] : [p, bare, `${bare}/`])];
  let route = keys.map((k) => site.routes[k]).find(Boolean);
  route ||= Object.entries(site.routes).find(([k]) => k.endsWith('*') && p.startsWith(k.slice(0, -1)))?.[1];
  const url = `https://${site.host}${u.pathname}${u.search}`;
  // The Store API's single-product route, for the price check: the product (or variation) by its id.
  const one = /^\/wp-json\/wc\/store\/v1\/products\/(\d+)$/.exec(p);
  if (!route && one) {
    const all = ['store-api-products.json', 'store-api-variations.json'].flatMap((f) => {
      try {
        return JSON.parse(readFileSync(path.join(site.dir, f), 'utf8'));
      } catch {
        return [];
      }
    });
    const item = all.find((x: any) => String(x.id) === one[1]);
    return item ? { text: JSON.stringify(item), contentType: TYPES['.json'], headers: {}, url } : null;
  }
  if (!route) return null;
  const landed = route.redirect ? `https://${site.host}${route.redirect}` : url;
  if (route.base64) return { text: '', bytes: new Uint8Array(Buffer.from(route.base64, 'base64')), contentType: route.type || 'application/octet-stream', headers: route.headers || {}, url: landed };
  let text = route.file ? readFileSync(path.join(site.dir, route.file), 'utf8') : route.text || '';
  if (route.first) text = JSON.stringify(JSON.parse(text).slice(0, route.first));
  const contentType = route.type || (route.file ? TYPES[path.extname(route.file)] : null) || (/^\s*[[{]/.test(text) ? TYPES['.json'] : TYPES['.html']);
  return { text, contentType, headers: route.headers || {}, url: landed };
}

export function exampleFetcher(): Fetcher {
  const products = JSON.parse(read('products.json'));
  const policies: Record<string, string> = JSON.parse(read('policies.json'));
  const sites = loadSites();
  return async (url) => {
    const u = new URL(url);
    const ok = (text: string, contentType = 'text/html; charset=utf-8', headers: Record<string, string> = {}) => ({ url: u.toString(), status: 200, contentType, text, headers });
    const site = sites.get(u.hostname.replace(/^www\./, ''));
    if (site) {
      const a = siteAnswer(site, u);
      if (!a) throw new FetchError('HTTP 404', 'http', url, 404);
      return { url: a.url, status: 200, contentType: a.contentType, text: a.text, headers: a.headers, ...(a.bytes ? { bytes: a.bytes } : {}) };
    }
    if (u.hostname === 'wood-and-thread.example') {
      if (u.pathname === '/') return ok('<html lang="he"><head><title>עץ וחוט</title></head><body><p>חנות קטנה לעבודות עץ וטקסטיל. כל המוצרים בעבודת יד.</p></body></html>');
      throw new FetchError('HTTP 404', 'http', url, 404);
    }
    if (u.hostname !== EXAMPLE_DOMAIN) throw new FetchError('no such host', 'network', url);
    if (u.pathname === '/') return ok(read('home.html'), 'text/html; charset=utf-8', { 'x-shopid': '1' });
    if (u.pathname === '/robots.txt') return ok('User-agent: *\nDisallow: /cart\nDisallow: /checkout\n', 'text/plain');
    if (u.pathname === '/meta.json') return ok(read('meta.json'), 'application/json');
    if (u.pathname === '/products.json') {
      const page = Number(u.searchParams.get('page') || 1);
      return ok(JSON.stringify(page === 1 ? products : { products: [] }), 'application/json');
    }
    const js = /^\/products\/([\w-]+)\.js$/.exec(u.pathname);
    if (js) {
      const p = products.products.find((x: any) => x.handle === js[1]);
      if (!p) throw new FetchError('HTTP 404', 'http', url, 404);
      return ok(JSON.stringify({ ...p, variants: p.variants.map((v: any) => ({ ...v, price: Math.round(Number(v.price) * 100) })) }), 'application/json');
    }
    if (policies[u.pathname]) return ok(policies[u.pathname]);
    throw new FetchError('HTTP 404', 'http', url, 404);
  };
}
