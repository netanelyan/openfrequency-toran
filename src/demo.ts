import { readFileSync } from 'node:fs';
import path from 'node:path';
import { examplesDir } from './core/paths.ts';
import { type Fetcher, FetchError } from './core/http.ts';

// The fictional store, kli-cheres.example ("כלי חרס של נורית"), served offline: the
// only store data in this repository. Tests, `npm run demo` and the screenshots run
// discovery, ingest, the agent and the pitch page against it with no network.

export const EXAMPLE_DOMAIN = 'kli-cheres.example';
export const EXAMPLE_URL = `https://${EXAMPLE_DOMAIN}/`;
const dir = path.join(examplesDir, 'store');
const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');

export function exampleFetcher(): Fetcher {
  const products = JSON.parse(read('products.json'));
  const policies: Record<string, string> = JSON.parse(read('policies.json'));
  return async (url) => {
    const u = new URL(url);
    const ok = (text: string, contentType = 'text/html; charset=utf-8', headers: Record<string, string> = {}) => ({ url: u.toString(), status: 200, contentType, text, headers });
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
