import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import type { App } from './app.ts';
import { audit } from './db/log.ts';
import { type FetchResult, getJson, hostAllowed } from './core/http.ts';
import { open, seal, secretsReady } from './core/secrets.ts';
import { readHome } from './leads/signals.ts';
import { shopMeta } from './ingest/shopify.ts';
import { checkKey, keepAccess, keyFitsSite, OrderConnectError, type Creds, type OrderPlatform } from './orders.ts';

// A customer proves a site is theirs before Toran takes it as their store (the audit's PRA-SEC-003). Anyone with a
// workspace could otherwise type a store's address at /start, take its knowledge and its pitch page, keep the real
// owner out ("already connected to another account"), and connect their own WhatsApp to answer as that store.
//
// /start keeps a claim (domain_claims, migrations 030 and 073): the workspace, the domain and a random token. The site
// is proven by any one of these, each checked by Toran itself:
//   - a DNS TXT record `toran-verify=<token>` on the domain itself, or on _toran-verify.<domain>
//   - a meta tag on the home page: <meta name="toran-verify" content="<token>">, fetched through the same fetcher as
//     every store page (core/http.ts, with its address rule)
//   - the store's own key (proveByKey): a Shopify app's key that works on the shop at this site (orders.ts
//     keyFitsSite), or a WooCommerce key the site's own REST API takes. Only the store's admin can make one. The key is
//     kept on the claim, sealed, and becomes the store's order key once the store exists (takeOrderKey), so the orders
//     step is done too
//   - a 6-digit code sent to an email address published on the site (sendCode, checkCode): the address is on the
//     business's own pages, so whoever reads its mail is the business. Someone else can't put an address on another
//     business's site. The code is kept only as a hash, lasts 30 minutes and takes 5 tries; 3 codes an hour per claim
// Only then is the store added (or an operator's lead moved into the workspace, web/pages/start.ts). A store the
// operator gave a workspace with workspace:assign is the operator's word and needs no claim; the operator releases a
// disputed domain from the lead's page (POST /lead/<id>/release).
//
// Most store owners can do neither DNS nor HTML (the owner, 2026-11-09: "any easier way to do that? many business
// owners dont know how to do that", about their own claim on a myshopify.com address, where nobody can add a TXT
// record; and "a native website can have the html tag, others should have an easier way. either way, a tutorial for
// setting up the tag"). So the page reads what the site is built on (siteOf) and offers the easiest way first: the key
// on Shopify and WooCommerce, else the code to an address on the site, else the tag with steps for each builder. The
// TXT record is hidden on an address on someone else's DNS (hostedDns).

export const TXT_HOST = '_toran-verify';
export const META = 'toran-verify';

export type SitePlatform = 'shopify' | 'woocommerce' | 'wordpress' | 'wix' | 'webflow' | 'other';
export type Claim = {
  id: number; workspace_id: number; domain: string; url: string; token: string; created_at: string; checked_at: string | null; proven_at: string | null; how: string | null;
  platform?: SitePlatform | null; platform_at?: string | null; order_creds?: string | null; code_hash?: string | null; code_to?: string | null; code_sent_at?: string | null; code_tries?: number;
};

/** A way that did not prove the site, with the Hebrew reason for the page and an HTTP status. */
export class ProofError extends Error {
  he: string;
  status: number;
  constructor(message: string, he: string, status = 422) {
    super(message);
    this.he = he;
    this.status = status;
  }
}

/** The tests' seam: the DNS lookups (the TXT record, and whether a WooCommerce site's address may be called). */
export const proofDeps = { resolveTxt: (host: string) => resolveTxt(host), hostAllowed: (url: string) => hostAllowed(url) };

/** The workspace's claim on a domain, new or as it was (its token kept, so instructions already followed stay right). */
export async function claimFor(app: App, workspaceId: number, domain: string, url: string): Promise<Claim> {
  await app.db.query('INSERT INTO domain_claims (workspace_id, domain, url, token) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, domain) DO UPDATE SET url = EXCLUDED.url', [workspaceId, domain, url, randomBytes(15).toString('base64url')]);
  return (await app.db.one<Claim>('SELECT * FROM domain_claims WHERE workspace_id = $1 AND domain = $2', [workspaceId, domain]))!;
}

/** The workspace's newest claim not yet proven, or null. */
export const pendingClaim = (app: App, workspaceId: number) => app.db.one<Claim>('SELECT * FROM domain_claims WHERE workspace_id = $1 AND proven_at IS NULL ORDER BY id DESC LIMIT 1', [workspaceId]);

/** Has this workspace proven this domain? */
export async function proven(app: App, workspaceId: number, domain: string): Promise<boolean> {
  return Boolean(await app.db.one('SELECT 1 FROM domain_claims WHERE workspace_id = $1 AND domain = $2 AND proven_at IS NOT NULL', [workspaceId, domain]));
}

const metaToken = (html: string) => {
  for (const m of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (name?.toLowerCase() !== META) continue;
    const content = /\bcontent\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (content) return content;
  }
  return null;
};

/** Look for the token now. Marks the claim proven, and says how, or why not. */
export async function checkClaim(app: App, claim: Claim): Promise<{ ok: boolean; how: 'dns' | 'meta' | null; why: string | null }> {
  const want = `${META}=${claim.token}`;
  let how: 'dns' | 'meta' | null = null;
  const why: string[] = [];
  for (const host of [claim.domain, `${TXT_HOST}.${claim.domain}`]) {
    try {
      if ((await proofDeps.resolveTxt(host)).some((parts) => parts.join('').trim() === want)) how = 'dns';
    } catch (e: any) {
      why.push(`dns ${host}: ${e?.code || e?.message || e}`);
    }
    if (how) break;
  }
  if (!how) {
    try {
      const r = await app.fetcher(claim.url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 });
      if (metaToken(r.text) === claim.token) how = 'meta';
    } catch (e: any) {
      why.push(`page: ${e?.code || e?.message || e}`);
    }
  }
  await app.db.query(`UPDATE domain_claims SET checked_at = now()${how ? ', proven_at = now(), how = $2' : ''} WHERE id = $1`, how ? [claim.id, how] : [claim.id]);
  return { ok: Boolean(how), how, why: how ? null : why.join('; ') || 'the token was not found' };
}

// ---- What the site is built on

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const hostOf = (url: string) => new URL(url).hostname.toLowerCase().replace(/\.$/, '');
const originOf = (url: string) => `https://${new URL(url).host}`;

/**
 * An address on someone else's DNS, where the owner can't add a TXT record: a shop's <name>.myshopify.com, a free
 * Wix, WordPress.com or Webflow address, and the like. The TXT way is not shown there.
 */
export function hostedDns(claim: Pick<Claim, 'domain' | 'url'>): boolean {
  const re = /(^|\.)(myshopify\.com|wixsite\.com|wixstudio\.com|wixstudio\.io|editorx\.io|wordpress\.com|webflow\.io|blogspot\.com|github\.io|netlify\.app|vercel\.app|pages\.dev|square\.site|weebly\.com|mystrikingly\.com|godaddysites\.com)$/;
  let host = '';
  try {
    host = hostOf(claim.url);
  } catch {
    /* the domain alone */
  }
  return re.test(claim.domain) || re.test(host);
}

/** The home page, or null when it does not answer. */
async function homeOf(app: App, claim: Claim): Promise<FetchResult | null> {
  try {
    return await app.fetcher(claim.url, { accept: 'text/html', maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 });
  } catch {
    return null;
  }
}

/**
 * What the site is built on, from its home page (one fetch, the same fetcher as the meta tag's) and the platform's own
 * public endpoint:
 *   shopify      a <name>.myshopify.com address, or /meta.json gives a myshopify_domain (ingest/shopify.ts shopMeta), or
 *                Shopify's headers and markers on the page
 *   woocommerce  WordPress, and /wp-json/ lists a wc/ namespace (the REST API's index lists its namespaces)
 *   wordpress    wp-content, a WordPress generator tag or the REST API's link
 *   wix          Wix's headers or markers, or a wixsite.com address
 *   webflow      Webflow's generator tag or its data-wf-site attribute
 * /meta.json is asked only when the page hints at Shopify or at nothing else (custom domains hide it well).
 */
export async function platformOf(app: App, claim: Claim, home?: FetchResult | null): Promise<SitePlatform> {
  const host = hostOf(claim.url);
  if (/\.myshopify\.com$/.test(host)) return 'shopify';
  const origin = originOf(claim.url);
  const page = home === undefined ? await homeOf(app, claim) : home;
  const html = page?.text || '';
  const headers = page?.headers || {};
  const hints = new Set(html ? readHome(html, page?.url || claim.url).platformHints : []);
  if (Object.keys(headers).some((k) => /^x-shopid$|^x-shopify-/i.test(k))) hints.add('shopify');
  if (Object.keys(headers).some((k) => /^x-wix-/i.test(k)) || /\.(wixsite|wixstudio)\.(com|io)$|\.editorx\.io$/.test(host) || /<meta[^>]*generator[^>]*Wix/i.test(html)) hints.add('wix');
  if (/<meta[^>]*generator[^>]*WordPress/i.test(html) || /rel="https:\/\/api\.w\.org\/"/.test(String(headers.link || ''))) hints.add('wordpress');
  if (/<meta[^>]*generator[^>]*Webflow|\bdata-wf-site=/i.test(html)) hints.add('webflow');

  const others = ['woocommerce', 'wordpress', 'wix', 'webflow', 'magento', 'konimbo', 'cashcow', 'bigcommerce'];
  if (hints.has('shopify') || ![...hints].some((h) => others.includes(h))) {
    if ((await shopMeta(app.fetcher, origin)).myshopify_domain) return 'shopify';
    if (hints.has('shopify')) return 'shopify';
  }
  if (hints.has('woocommerce') || hints.has('wordpress')) {
    try {
      const { data } = await getJson<{ namespaces?: string[] }>(app.fetcher, `${origin}/wp-json/`);
      if ((data?.namespaces || []).some((n) => /^wc\//.test(String(n)))) return 'woocommerce';
    } catch {
      /* the REST API is closed: the tag, with WordPress's steps */
    }
    return 'wordpress';
  }
  if (hints.has('wix')) return 'wix';
  if (hints.has('webflow')) return 'webflow';
  return 'other';
}

const MAX_EMAILS = 3;

/**
 * The email addresses the site itself publishes: mailto links and plain addresses on the home page and on up to 2
 * contact pages it links to (leads/signals.ts readHome: "צור קשר", /contact, /pages/contact and the like), the site's
 * own domain first, at most 3. Nothing is stored: the page keeps them for an hour in memory, and reads them again.
 */
export async function contactEmails(app: App, claim: Claim, home?: FetchResult | null): Promise<string[]> {
  const page = home === undefined ? await homeOf(app, claim) : home;
  if (!page?.text) return [];
  const sig = readHome(page.text, page.url || claim.url);
  const found = [...sig.emails];
  for (const link of sig.contactLinks.slice(0, 2)) {
    if (found.length >= MAX_EMAILS * 2) break;
    try {
      const c = await app.fetcher(link, { accept: 'text/html', maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 });
      found.push(...readHome(c.text, c.url || link).emails);
    } catch {
      /* a contact page that does not answer */
    }
  }
  const own = (e: string) => e.endsWith(`@${claim.domain}`) || e.endsWith(`.${claim.domain}`);
  return [...new Set(found)].sort((a, b) => Number(own(b)) - Number(own(a))).slice(0, MAX_EMAILS);
}

export type Site = { platform: SitePlatform; emails: string[]; hosted: boolean };
const seen = new Map<string, { at: number; emails: string[] }>();
const seenKey = (c: Claim) => `${c.id}|${c.token}|${c.url}`;

/** What the verify page needs: the platform (kept on the claim, read again after a day) and the addresses (an hour). */
export async function siteOf(app: App, claim: Claim): Promise<Site> {
  const fresh = claim.platform && claim.platform_at && Date.now() - new Date(claim.platform_at).getTime() < DAY_MS;
  const hit = seen.get(seenKey(claim));
  let platform: SitePlatform | null = fresh ? (claim.platform as SitePlatform) : null;
  let emails = hit && Date.now() - hit.at < HOUR_MS ? hit.emails : null;
  if (!platform || !emails) {
    const home = await homeOf(app, claim);
    if (!platform) {
      platform = await platformOf(app, claim, home);
      // A site that did not answer is asked again next time.
      if (home || platform === 'shopify') {
        await app.db.query('UPDATE domain_claims SET platform = $2, platform_at = now() WHERE id = $1', [claim.id, platform]);
        claim.platform = platform;
      }
    }
    if (!emails) {
      emails = home ? await contactEmails(app, claim, home) : [];
      if (home) seen.set(seenKey(claim), { at: Date.now(), emails });
      if (seen.size > 500) seen.delete(seen.keys().next().value!);
    }
  }
  return { platform, emails, hosted: hostedDns(claim) };
}

// ---- Proof by the store's key

/** The platforms whose key proves a site: the key is made in the store's own admin. */
export const keyPlatform = (p: string | null | undefined): p is 'shopify' | 'woocommerce' => p === 'shopify' || p === 'woocommerce';

const KEY_HE = {
  platform: 'אפשר לחבר כך רק חנות של Shopify או WooCommerce. אפשר לבחור דרך אחרת למטה.',
  away: 'לא הצלחנו להגיע לאתר כדי לבדוק את המפתח. אפשר לנסות שוב בעוד כמה דקות.',
  other: 'המפתח הזה של חנות Shopify אחרת, לא של האתר הזה. צריך את הפרטים של האפליקציה שמותקנת על החנות של האתר.',
};

/**
 * A working Shopify or WooCommerce key proves the site: tried once like the orders key (orders.ts checkKey), on
 * Shopify only when it is the shop at this site (keyFitsSite), on WooCommerce against the site's own address, so the key
 * is bound to it by where it works. The key stays on the claim, sealed, for takeOrderKey.
 */
export async function proveByKey(app: App, claim: Claim, form: Record<string, string>): Promise<{ how: 'shopify' | 'woo' }> {
  const platform = claim.platform;
  if (!keyPlatform(platform)) throw new ProofError(`no key way for ${platform}`, KEY_HE.platform);
  const origin = originOf(claim.url);
  // WooCommerce is called at the claimed address itself, with app.api (not the polite fetcher): never a private one.
  if (platform === 'woocommerce' && !(await proofDeps.hostAllowed(origin))) throw new ProofError(`${origin} is not called`, KEY_HE.away);
  let c: Creds;
  try {
    c = await checkKey(app, platform as OrderPlatform, origin, form);
  } catch (e) {
    if (e instanceof OrderConnectError) throw new ProofError(e.message, e.he);
    throw e;
  }
  if (platform === 'shopify' && !(await keyFitsSite(app, c, origin, true))) throw new ProofError(`the key is for ${c.shop}, not ${claim.domain}`, KEY_HE.other);
  const how = platform === 'shopify' ? 'shopify' : 'woo';
  const sealed = secretsReady(app.env) ? seal(app.env, JSON.stringify({ platform, creds: c })) : null;
  await app.db.query('UPDATE domain_claims SET checked_at = now(), proven_at = now(), how = $2, order_creds = $3 WHERE id = $1', [claim.id, how, sealed]);
  return { how };
}

/**
 * The key that proved the store's site, as its order key (orders.ts keepAccess), once the store exists and is the
 * workspace's: from /start for an operator's lead, from the worker's add_store for a new one. Cleared from the claim
 * either way; a store read as another platform than the key's keeps nothing.
 */
export async function takeOrderKey(app: App, storeId: number, by: string): Promise<boolean> {
  const row = await app.db.one<{ id: number; order_creds: string; platform: string }>(
    'SELECT c.id, c.order_creds, s.platform FROM domain_claims c JOIN stores s ON s.domain = c.domain AND s.workspace_id = c.workspace_id WHERE s.id = $1 AND c.order_creds IS NOT NULL AND c.proven_at IS NOT NULL ORDER BY c.id DESC LIMIT 1',
    [storeId],
  );
  if (!row) return false;
  await app.db.query('UPDATE domain_claims SET order_creds = NULL WHERE id = $1', [row.id]);
  try {
    const { platform, creds } = JSON.parse(open(app.env, row.order_creds));
    if (platform !== row.platform) return false;
    await keepAccess(app, storeId, platform, creds, by);
    return true;
  } catch (e: any) {
    app.log(`[proof] store ${storeId}: the key that proved the site was not kept: ${e?.message || e}`);
    return false;
  }
}

// ---- Proof by a code to the site's own address

export const CODE_MINUTES = 30;
export const CODE_TRIES = 5;
export const CODE_SENDS = 3; // an hour, per claim
/** Tries to send a code in an hour per claim, those that failed too: a mail that keeps failing is not tried forever. */
export const CODE_ATTEMPTS = 10;

/** in***@store.co.il: enough to tell the addresses apart, not to read them off the page. */
export function mask(email: string): string {
  const [local, domain] = String(email).split('@');
  return `${local.slice(0, local.length <= 2 ? 1 : 2)}***@${domain}`;
}

/** Whether a code can be sent here: email is on (app.mail), and in production it is Resend, not the simulator. */
export const mailReady = (app: App) => Boolean(app.mail) && (app.mail!.kind === 'resend' || app.env.TORAN_ENV !== 'prod');

const hashOf = (claim: Claim, code: string) => createHash('sha256').update(`${claim.token}:${code}`).digest('hex');
/** The code still waiting to be typed, if there is one. */
export const codeLive = (claim: Claim) => Boolean(claim.code_hash && claim.code_sent_at && Date.now() - new Date(claim.code_sent_at).getTime() < CODE_MINUTES * 60_000 && Number(claim.code_tries || 0) < CODE_TRIES);

export function codeMail(domain: string, code: string) {
  return {
    subject: `הקוד לאימות האתר ${domain}: ${code}`,
    text: `ביקשו לחבר את האתר ${domain} לתורן של OpenFrequency, ושלחו קוד לכתובת הזאת כדי לוודא שהאתר שלכם.

הקוד: ${code}

מקלידים אותו בדף שבו ביקשתם אותו. הוא בתוקף ${CODE_MINUTES} דקות.

לא אתם ביקשתם? אפשר להתעלם מהמייל, והאתר לא יתחבר.`,
  };
}

/**
 * A new code to one of the site's own addresses (`to` must be one contactEmails found). A send is counted before the
 * mail goes, so two at once can't both pass the limit; a mail that failed is written down as failed too, and is not
 * one of the 3 codes an hour (the audit's P2-7: a failed mail used one up, though no code ever arrived). Tries that
 * keep failing stop at CODE_ATTEMPTS an hour.
 */
export async function sendCode(app: App, claim: Claim, to: string, by: string): Promise<void> {
  if (!mailReady(app)) throw new ProofError('email is off here', 'שליחת מייל עוד לא פתוחה כאן. אפשר לבחור דרך אחרת.');
  const n = await app.db.one<{ sent: number; failed: number }>(
    "SELECT COUNT(*) FILTER (WHERE action = 'verify_email_send')::int AS sent, COUNT(*) FILTER (WHERE action = 'verify_email_failed')::int AS failed FROM audit WHERE action IN ('verify_email_send', 'verify_email_failed') AND detail->>'claim' = $1 AND at > now() - interval '1 hour'",
    [String(claim.id)],
  );
  const sent = n?.sent || 0;
  const failed = n?.failed || 0;
  if (sent - failed >= CODE_SENDS) throw new ProofError('too many codes this hour', 'כבר שלחנו כמה קודים בשעה האחרונה. אפשר לנסות שוב בעוד שעה, או לבחור דרך אחרת.', 429);
  if (sent >= CODE_ATTEMPTS) throw new ProofError('too many failed sends this hour', 'ניסינו לשלוח כמה פעמים בשעה האחרונה, והמייל לא יצא. אפשר לנסות שוב בעוד שעה, או לבחור דרך אחרת.', 429);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await app.db.query('UPDATE domain_claims SET code_hash = $2, code_to = $3, code_sent_at = now(), code_tries = 0 WHERE id = $1', [claim.id, hashOf(claim, code), to]);
  await audit(app.db, { actor: by, action: 'verify_email_send', detail: { workspace: claim.workspace_id, claim: claim.id, domain: claim.domain, to: mask(to) } });
  const m = codeMail(claim.domain, code);
  try {
    await app.mail!.notice(to, m.subject, m.text);
  } catch (e: any) {
    app.log(`[proof] the code for ${claim.domain} was not sent: ${e?.message || e}`);
    await app.db.query('UPDATE domain_claims SET code_hash = NULL WHERE id = $1', [claim.id]);
    await audit(app.db, { actor: by, action: 'verify_email_failed', detail: { workspace: claim.workspace_id, claim: claim.id, domain: claim.domain, why: String(e?.message || e).slice(0, 200) } });
    throw new ProofError(`the mail was refused: ${e?.message || e}`, 'לא הצלחנו לשלוח את המייל. אפשר לנסות שוב בעוד כמה דקות.', 502);
  }
}

/** The code the owner typed: proves the site, or says why not. Every try counts, the right one too. */
export async function checkCode(app: App, claim: Claim, typed: string): Promise<void> {
  if (!claim.code_hash || !claim.code_sent_at) throw new ProofError('no code was sent', 'קודם שולחים קוד למייל.');
  if (Number(claim.code_tries || 0) >= CODE_TRIES) throw new ProofError('no tries left', 'היו יותר מדי ניסיונות עם הקוד הזה. שולחים קוד חדש ומנסים שוב.', 429);
  if (Date.now() - new Date(claim.code_sent_at).getTime() >= CODE_MINUTES * 60_000) throw new ProofError('the code expired', 'הקוד כבר לא בתוקף. שולחים קוד חדש.');
  // One try, counted before it is compared, so two at once can't both slip past the limit.
  const left = await app.db.one<{ code_tries: number }>('UPDATE domain_claims SET code_tries = code_tries + 1 WHERE id = $1 AND code_tries < $2 RETURNING code_tries', [claim.id, CODE_TRIES]);
  if (!left) throw new ProofError('no tries left', 'היו יותר מדי ניסיונות עם הקוד הזה. שולחים קוד חדש ומנסים שוב.', 429);
  const digits = String(typed || '').replace(/\D/g, '');
  const ok = digits.length === 6 && timingSafeEqual(Buffer.from(hashOf(claim, digits)), Buffer.from(claim.code_hash));
  if (!ok) {
    const n = CODE_TRIES - left.code_tries;
    throw new ProofError('a wrong code', n ? `הקוד לא נכון. ${n === 1 ? 'נשאר עוד ניסיון אחד' : `נשארו עוד ${n} ניסיונות`}.` : 'הקוד לא נכון, וזה היה הניסיון האחרון. שולחים קוד חדש.');
  }
  await app.db.query("UPDATE domain_claims SET checked_at = now(), proven_at = now(), how = 'email', code_hash = NULL WHERE id = $1", [claim.id]);
}
