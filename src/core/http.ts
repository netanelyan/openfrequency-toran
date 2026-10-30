// Fetching other people's websites, politely, and never our own machine.
//
// Every request to a store goes through here:
//   - an honest user agent that names the bot and where to read about it
//   - robots.txt, read once a day per host, obeyed for every path (Allow/Disallow,
//     longest match wins, * and $ understood), on every hop of a redirect. tiyul-social had none of this.
//   - one request at a time per host, at least HOST_GAP_MS apart
//   - a timeout, and a size cap enforced while reading (a chunked body with no
//     content-length cannot slip past it, which tiyul-social's could)
//   - typed failures: { code: timeout | http | network | too_large | robots | not_text | blocked }
//
// THE ADDRESS RULE (the audit's PRA-SEC-001). A store's address is typed by a stranger and its pages may redirect
// anywhere, so every hop is checked where it connects, not where it was typed. Redirects are followed by hand (at most
// MAX_HOPS); each hop's host is resolved and refused ('blocked') when any of its addresses is loopback, private
// (RFC 1918), link-local (169.254/16 with the cloud metadata address, fe80::/10), CGNAT (100.64/10), unique-local
// (fc00::/7), unspecified, multicast, reserved or documentation space, or an IPv4 address wrapped in IPv6
// (::ffff:127.0.0.1, 64:ff9b::/96). The address checked is the one the connection uses (the request's own lookup), so
// a name that answers a public address to the check and 127.0.0.1 to the connection cannot slip through. A redirect
// from https down to http is refused. The URL parser has turned 2130706433 and 0x7f.1 into 127.0.0.1 before the host
// is read. The headless browser (browser.ts) asks the same question of every request a page makes.
//
// Nothing here ever POSTs. The engine reads stores; it does not act on them.
//
// The Fetcher type is the seam for tests: a fixture fetcher answers from files, so the
// whole discovery and ingest pipeline runs offline.

import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

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

const MAX_HOPS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the address rule

const BLOCKED = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) BLOCKED.addSubnet(net, bits, 'ipv6');

/** The IPv4 address inside an IPv6 one that carries it (::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d), or null. */
function v4Inside(addr: string): string | null {
  const a = addr.toLowerCase();
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** Is this address one we never fetch from: our own machine, a private network, a reserved range? */
export function isBlockedAddress(addr: string): boolean {
  const ip = String(addr || '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const kind = isIP(ip);
  if (!kind) return true;
  if (kind === 6) {
    const inner = v4Inside(ip);
    if (inner) return isBlockedAddress(inner);
    return BLOCKED.check(ip, 'ipv6');
  }
  return BLOCKED.check(ip, 'ipv4');
}

type Lookup = (hostname: string, options: { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/** A lookup that refuses a name with any blocked address: the connection uses what it returns, so the check holds. */
function guardedLookup(resolve: Lookup) {
  return (hostname: string, options: any, cb: (...a: any[]) => void) => {
    resolve(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      const bad = (addrs || []).find((a) => isBlockedAddress(a.address));
      if (bad || !addrs?.length) return cb(Object.assign(new Error(`${hostname} resolves to ${bad?.address || 'nothing'}, which is not fetched`), { code: 'EBLOCKED' }));
      if (options?.all) return cb(null, addrs);
      const pick = addrs.find((a) => !options?.family || a.family === options.family) || addrs[0];
      cb(null, pick.address, pick.family);
    });
  };
}

/** May a page's request go to this URL's host? For the headless browser, which resolves names itself: checked, not pinned. */
export async function hostAllowed(url: string, resolve: Lookup = dnsLookup as unknown as Lookup): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return true; // data:, blob: and about: never leave the browser
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return !isBlockedAddress(host);
  return new Promise((ok) => resolve(host, { all: true }, (err, addrs) => ok(!err && !!addrs?.length && !addrs.some((a) => isBlockedAddress(a.address)))));
}

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

// resolve: the name lookup (dns.lookup; a test passes its own); trusted: hosts ("host:port") the address rule lets
// through, for a test's own local server alone.
export function liveFetcher({ gapMs = HOST_GAP_MS, userAgent = USER_AGENT, resolve = dnsLookup as unknown as Lookup, trusted = new Set<string>() }: { gapMs?: number; userAgent?: string; resolve?: Lookup; trusted?: Set<string> } = {}): Fetcher {
  const nextAt = new Map<string, number>();
  const robots = new Map<string, { at: number; rules: Rule[] }>();
  const chains = new Map<string, Promise<unknown>>();
  const lookup = guardedLookup(resolve);

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

  /** One request, one hop: a redirect comes back as it is (its Location in headers), never followed here. */
  async function raw(url: string, { accept = 'text/html,application/json;q=0.9,*/*;q=0.5', maxBytes = DEFAULT_MAX, timeoutMs = 20_000, binary = false }: Parameters<Fetcher>[1] = {}): Promise<FetchResult> {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const free = trusted.has(`${host}:${port}`);
    if (!free && isIP(host) && isBlockedAddress(host)) throw new FetchError(`${host} is not fetched (a private, loopback or reserved address)`, 'blocked', url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const mod = u.protocol === 'https:' ? https : http;
    try {
      const res = await new Promise<http.IncomingMessage>((ok, fail) => {
        const req = mod.request(u, { method: 'GET', headers: { 'user-agent': userAgent, accept, 'accept-language': 'he-IL,he;q=0.9,en;q=0.6', 'accept-encoding': 'gzip, deflate, br' }, signal: ctrl.signal, ...(free ? {} : { lookup: lookup as any }) }, ok);
        req.on('error', fail);
        req.end();
      });
      const status = res.statusCode || 0;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v != null) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
      const contentType = headers['content-type'] || '';
      if (status >= 300 && status < 400 && headers.location) {
        res.resume();
        return { url, status, contentType, text: '', headers };
      }
      const len = Number(headers['content-length'] || 0);
      if (len > maxBytes) {
        res.destroy();
        throw new FetchError(`body of ${len} bytes is over the cap`, 'too_large', url, status);
      }
      const enc = String(headers['content-encoding'] || '').toLowerCase();
      const body: Readable = enc === 'gzip' || enc === 'x-gzip' ? res.pipe(zlib.createGunzip()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of body as AsyncIterable<Buffer>) {
        size += c.length;
        if (size > maxBytes) {
          res.destroy();
          throw new FetchError(`body over ${maxBytes} bytes`, 'too_large', url, status);
        }
        chunks.push(c);
      }
      const buf = Buffer.concat(chunks);
      if (binary) return { url, status, contentType, text: '', headers, bytes: new Uint8Array(buf) };
      const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() || 'utf-8';
      let text: string;
      try {
        text = new TextDecoder(charset).decode(buf);
      } catch {
        text = buf.toString('utf8');
      }
      return { url, status, contentType, text, headers };
    } catch (e: any) {
      if (e instanceof FetchError) throw e;
      if (e?.code === 'EBLOCKED') throw new FetchError(e.message, 'blocked', url);
      const aborted = e?.name === 'AbortError' || ctrl.signal.aborted;
      throw new FetchError(aborted ? `timed out after ${timeoutMs} ms` : `network: ${e?.code || e?.message || e}`, aborted ? 'timeout' : 'network', url);
    } finally {
      clearTimeout(timer);
    }
  }

  async function rulesFor(origin: string, host: string): Promise<Rule[]> {
    const hit = robots.get(origin);
    if (hit && Date.now() - hit.at < ROBOTS_TTL_MS) return hit.rules;
    let rules: Rule[] = [];
    try {
      // robots.txt is read with its own redirects followed under the same rule, a hop at a time.
      const r = await hops(`${origin}/robots.txt`, { accept: 'text/plain', maxBytes: 512 * 1024, timeoutMs: 10_000, robots: false });
      // A missing robots.txt allows everything; a server error is read as "not now" (RFC 9309): we skip the host.
      if (r.status >= 500) rules = [{ allow: false, path: '/' }];
      else if (r.status < 400 && !/<html/i.test(r.text.slice(0, 400))) rules = parseRobots(r.text);
    } catch (e: any) {
      if (e instanceof FetchError && e.code === 'blocked') throw e;
      rules = [];
    }
    robots.set(origin, { at: Date.now(), rules });
    return rules;
  }

  /** One hop, with its robots.txt and one retry for a network failure or a timeout (a connection that timed out once usually connects the second time). */
  async function hop(url: string, opts: Parameters<Fetcher>[1] = {}): Promise<FetchResult> {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new FetchError('only http(s)', 'network', url);
    if (opts.robots !== false) {
      const rules = await rulesFor(u.origin, u.host);
      if (!robotsAllows(rules, u.pathname + u.search)) throw new FetchError(`robots.txt disallows ${u.pathname}`, 'robots', url);
    }
    try {
      return await perHost(u.host, () => raw(url, opts));
    } catch (e: any) {
      if (!(e instanceof FetchError) || !['network', 'timeout'].includes(e.code)) throw e;
      await sleep(2000);
      return perHost(u.host, () => raw(url, opts));
    }
  }

  /** Follow redirects by hand, each hop checked as the first: its address, its robots.txt, no step down to http. */
  async function hops(url: string, opts: Parameters<Fetcher>[1] = {}): Promise<FetchResult> {
    let at = url;
    for (let i = 0; ; i++) {
      const r = await hop(at, opts);
      if (!(r.status >= 300 && r.status < 400 && r.headers.location)) return { ...r, url: at };
      if (i >= MAX_HOPS) throw new FetchError(`more than ${MAX_HOPS} redirects`, 'http', url, r.status);
      let next: URL;
      try {
        next = new URL(r.headers.location, at);
      } catch {
        throw new FetchError(`a redirect to "${r.headers.location}", which is not an address`, 'http', at, r.status);
      }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new FetchError(`a redirect to ${next.protocol}, not http(s)`, 'blocked', at, r.status);
      if (new URL(at).protocol === 'https:' && next.protocol === 'http:') throw new FetchError(`a redirect from https down to http (${next.host})`, 'blocked', at, r.status);
      at = next.toString();
    }
  }

  return async function get(url, opts = {}) {
    const r = await hops(url, opts);
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
