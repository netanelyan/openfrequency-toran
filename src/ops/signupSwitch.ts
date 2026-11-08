import type { App } from '../app.ts';
import { call } from '../owners/identity.ts';
import { alertOperator } from './alert.ts';

// Is Toran on sale? One switch, in three places, as Teder's (openfrequency-teder src/web/signup-switch.js;
// TORAN-READINESS.md P1-14):
//
//   Toran     TORAN_SIGNUP_OPEN=1: Toran's cold pitch may go out (ops/outreach.ts) and its pitch pages show the plans
//             with "להצטרף" to accounts' sign-up (pitch/page.ts). Off, the pages keep "לכתוב לתורן" and no pitch
//             about Toran goes out ("בקרוב" on the site).
//   accounts  OF_SIGNUP=1 with toran in OF_SIGNUP_PRODUCTS: /signup takes it. Asked on this machine:
//             GET {OF_ACCOUNTS_INTERNAL}/internal/signup -> { open, products } (accounts docs/contracts/signup.json)
//   the site  "signup": { "toran": "open" } in what its build publishes: GET https://openfrequency.co.il/support.json
//
// Asked once a start, never waited for: when the three agree one quiet line says so; when they do not, or one cannot be
// asked, one loud line and one operator alert (a switch nobody can read is no better than one that disagrees).

export const SITE_EXPORT = 'https://openfrequency.co.il/support.json';
export const SITE_TIMEOUT_MS = 10_000;

/** Toran's own half of the switch. */
export const toranOnSale = (env: Record<string, string | undefined>) => String(env.TORAN_SIGNUP_OPEN || '').trim() === '1';

type Said = { open: boolean } | { error: string };
const why = (e: any) => (e?.name === 'TimeoutError' ? 'timed out' : String(e?.message || e).slice(0, 200));

/** accounts' half: does /signup take Toran? */
export async function accountsSays(app: App): Promise<Said> {
  const r = await call(app, 'GET', '/internal/signup');
  if (r.status !== 200 || !r.body || typeof r.body.open !== 'boolean') return { error: r.body?.error || `HTTP ${r.status}` };
  return { open: Boolean(r.body.open) && Array.isArray(r.body.products) && r.body.products.includes('toran') };
}

/** The site's half: support.json's signup.toran. */
export async function siteSays(url = SITE_EXPORT, fetchImpl: typeof fetch = fetch): Promise<Said> {
  try {
    const r = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(SITE_TIMEOUT_MS) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j: any = await r.json();
    const v = j?.signup?.toran;
    if (v !== 'open' && v !== 'closed') return { error: 'no signup.toran in it' };
    return { open: v === 'open' };
  } catch (e) {
    return { error: why(e) };
  }
}

/** The start-up check: the three halves side by side, said once, and alerted when they disagree. */
export async function checkSignupSwitch(app: App, { site = () => siteSays(String(app.env.TORAN_SITE_EXPORT_URL || SITE_EXPORT)) }: { site?: () => Promise<Said> } = {}): Promise<{ agree: boolean; line: string }> {
  const mine = toranOnSale(app.env);
  const [acc, web] = await Promise.all([accountsSays(app), site()]);
  const word = (s: Said) => ('error' in s ? `couldn't check (${s.error})` : s.open ? 'open' : 'closed');
  const agree = !('error' in acc) && !('error' in web) && acc.open === mine && web.open === mine;
  const line = agree
    ? `[signup] all three agree: ${mine ? 'open' : 'closed'}`
    : `[signup] !!! Toran's sign-up switch disagrees: Toran (TORAN_SIGNUP_OPEN) ${mine ? 'open' : 'closed'}, accounts (OF_SIGNUP_PRODUCTS) ${word(acc)}, the website (site.config.json signup) ${word(web)}. Turn all three together (docs/first-customer.md).`;
  app.log(line);
  if (!agree) await alertOperator(app, 'signup-switch', 'תורן: מתג ההרשמה לא תואם', line.replace('[signup] !!! ', ''), { everyMinutes: 10 }).catch((e) => app.log(`[signup] the alert failed: ${why(e)}`));
  return { agree, line };
}
