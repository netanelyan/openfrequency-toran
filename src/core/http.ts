// Fetching other people's websites, politely.
//
// Every request to a store goes through here:
//   - an honest user agent that names the bot and where to read about it
//   - robots.txt, read once a day per host, obeyed for every path (Allow/Disallow,
//     longest match wins, * and $ understood). tiyul-social had none of this.
//   - one request at a time per host, at least HOST_GAP_MS apart
//   - a timeout, and a size cap enforced while reading (a chunked body with no
//     content-length cannot slip past it, which tiyul-social's could)
//   - typed failures: { code: timeout | http | network | too_large | robots | not_text }
//
// Nothing here ever POSTs. The engine reads stores; it does not act on them.
//
// The Fetcher type is the seam for tests: a fixture fetcher answers from files, so the
// whole discovery and ingest pipeline runs offline.

// An image (a store's logo, for its colour) is asked for with `binary`: its bytes come back as they were sent,
// and `text` is empty.
export type FetchResult = { url: string; status: number; contentType: string; text: string; headers: Record<string, string>; bytes?: Uint8Array };
export type Fetcher = (url: string, opts?: { accept?: string; maxBytes?: number; timeoutMs?: number; robots?: boolean; binary?: boolean }) => Promise<FetchResult>;

export class FetchError extends Error {
  code: string;
  status?: number;
  url: string;
  constructor(message: string, code: string, url: string, status?: number) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.url = url;
    this.status = status;
  }
}

export const USER_AGENT = `ToranBot/0.1 (+https://github.com/netanelyan/openfrequency-toran/blob/main/docs/bot.md)`;
const HOST_GAP_MS = 1200;
const ROBOTS_TTL_MS = 24 * 3_600_000;
const DEFAULT_MAX = 8 * 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- robots.txt

type Rule = { allow: boolean; path: string };

/** The rules that apply to us in a robots.txt: the group naming toranbot, else the * group. */
export function parseRobots(text: string, agent = 'toranbot'): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'disallow' && val) cur.rules.push({ allow: false, path: val });
    if (key === 'allow' && val) cur.rules.push({ allow: true, path: val });
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const pick = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return pick.flatMap((g) => g.rules);
}

const ruleRe = (p: string) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);

/** May we fetch this path (with its query)? Longest matching rule wins; Allow wins a tie. */
export function robotsAllows(rules: Rule[], pathAndQuery: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!ruleRe(r.path).test(pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------- the live fetcher

export function liveFetcher({ gapMs = HOST_GAP_MS, userAgent = USER_AGENT }: { gapMs?: number; userAgent?: string } = {}): Fetcher {
  const nextAt = new Map<string, number>();
  const robots = new Map<string, { at: number; rules: Rule[] }>();
  const chains = new Map<string, Promise<unknown>>();

  /** Run fn for a host after the host's previous request, and at least gapMs after it. */
  function perHost<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(host) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const wait = (nextAt.get(host) || 0) - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        nextAt.set(host, Date.now() + gapMs);
      }
    });
    chains.set(host, run);
    return run;
  }

  async function raw(url: string, { accept = 'text/html,application/json;q=0.9,*/*;q=0.5', maxBytes = DEFAULT_MAX, timeoutMs = 20_000, binary = false }: Parameters<Fetcher>[1] = {}): Promise<FetchResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'user-agent': userAgent, accept, 'accept-language': 'he-IL,he;q=0.9,en;q=0.6' }, redirect: 'follow', signal: ctrl.signal });
    } catch (e: any) {
      clearTimeout(timer);
      throw new FetchError(e?.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : `network: ${e?.cause?.code || e?.message || e}`, e?.name === 'AbortError' ? 'timeout' : 'network', url);
    }
    try {
      const len = Number(res.headers.get('content-length') || 0);
      if (len > maxBytes) throw new FetchError(`body of ${len} bytes is over the cap`, 'too_large', url, res.status);
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (res.body) {
        for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
          size += c.length;
          if (size > maxBytes) {
            ctrl.abort();
            throw new FetchError(`body over ${maxBytes} bytes`, 'too_large', url, res.status);
          }
          chunks.push(c);
        }
      }
      const buf = Buffer.concat(chunks);
      const contentType = res.headers.get('content-type') || '';
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      if (binary) return { url: res.url || url, status: res.status, contentType, text: '', headers, bytes: new Uint8Array(buf) };
      const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() || 'utf-8';
      let text: string;
      try {
        text = new TextDecoder(charset).decode(buf);
      } catch {
        text = buf.toString('utf8');
      }
      return { url: res.url || url, status: res.status, contentType, text, headers };
    } catch (e: any) {
      if (e instanceof FetchError) throw e;
      throw new FetchError(e?.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : `reading: ${e?.message || e}`, e?.name === 'AbortError' ? 'timeout' : 'network', url);
    } finally {
      clearTimeout(timer);
    }
  }

  async function rulesFor(origin: string, host: string): Promise<Rule[]> {
    const hit = robots.get(origin);
    if (hit && Date.now() - hit.at < ROBOTS_TTL_MS) return hit.rules;
    let rules: Rule[] = [];
    try {
      const r = await perHost(host, () => raw(`${origin}/robots.txt`, { accept: 'text/plain', maxBytes: 512 * 1024, timeoutMs: 10_000 }));
      // A missing robots.txt allows everything; a server error is read as "not now" (RFC 9309): we skip the host.
      if (r.status >= 500) rules = [{ allow: false, path: '/' }];
      else if (r.status < 400 && !/<html/i.test(r.text.slice(0, 400))) rules = parseRobots(r.text);
    } catch {
      rules = [];
    }
    robots.set(origin, { at: Date.now(), rules });
    return rules;
  }

  return async function get(url, opts = {}) {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new FetchError('only http(s)', 'network', url);
    if (opts.robots !== false) {
      const rules = await rulesFor(u.origin, u.host);
      if (!robotsAllows(rules, u.pathname + u.search)) throw new FetchError(`robots.txt disallows ${u.pathname}`, 'robots', url);
    }
    // One retry for a network failure or a timeout: a connection that timed out once usually connects the second time.
    let r: FetchResult;
    try {
      r = await perHost(u.host, () => raw(url, opts));
    } catch (e: any) {
      if (!(e instanceof FetchError) || !['network', 'timeout'].includes(e.code)) throw e;
      await sleep(2000);
      r = await perHost(u.host, () => raw(url, opts));
    }
    if (r.status >= 400) throw new FetchError(`HTTP ${r.status}`, 'http', url, r.status);
    return r;
  };
}

/** GET and parse JSON; a body that is not JSON is a 'not_json' failure (a Shopify store with the JSON feed turned off answers HTML). */
export async function getJson<T = any>(fetcher: Fetcher, url: string, opts: Parameters<Fetcher>[1] = {}): Promise<{ data: T; res: FetchResult }> {
  const res = await fetcher(url, { accept: 'application/json', ...opts });
  const t = res.text.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) throw new FetchError('not JSON', 'not_json', url, res.status);
  try {
    return { data: JSON.parse(t) as T, res };
  } catch {
    throw new FetchError('bad JSON', 'not_json', url, res.status);
  }
}

/**
 * A fetcher that answers from a map of URL -> body (or a function), for tests and the
 * demo. Unknown URLs are a 404, as a real site's would be.
 */
export function fixtureFetcher(routes: Record<string, string | { status?: number; text: string; contentType?: string; headers?: Record<string, string> } | ((url: string) => string | null)>): Fetcher {
  return async (url) => {
    const norm = url.replace(/\/$/, '');
    for (const [k, v] of Object.entries(routes)) {
      if (k.replace(/\/$/, '') !== norm && !(typeof v === 'function' && k === '*')) continue;
      const out = typeof v === 'function' ? v(url) : v;
      if (out == null) continue;
      const o = typeof out === 'string' ? { status: 200, text: out } : out;
      const status = o.status ?? 200;
      if (status >= 400) throw new FetchError(`HTTP ${status}`, 'http', url, status);
      const ct = (o as any).contentType || (o.text.trimStart().startsWith('{') || o.text.trimStart().startsWith('[') ? 'application/json' : 'text/html; charset=utf-8');
      return { url, status, contentType: ct, text: o.text, headers: (o as any).headers || {} };
    }
    throw new FetchError('HTTP 404', 'http', url, 404);
  };
}
