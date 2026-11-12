import { J, type Db } from './db/index.ts';

// What Toran costs and who sells it: the one place the offer lives. The pitch page,
// the review queue and the settings page read it from here, and no template types a
// number. It is a row in the settings table, edited on /settings, because the price is a
// business decision that changes without a release.
//
// There is no free period and no trial, anywhere. Until the price, VAT and setup fee are
// set, every pitch page is held back (pitch/ready.ts) rather than shown with a guess.
//
// OpenFrequency's own WhatsApp number (TORAN_OWNER_WHATSAPP) is the "write to us" button
// and where "take this page down" goes. It may be the demo number too (one number for
// support and the demos): the demo router knows the page's two messages by their words
// and the page's link, and hands them to the operator (channels/demo.ts, pageMessage).

export type Offer = {
  monthly: number | null; // ₪ a month
  vat: 'included' | 'excluded' | null;
  setup: number | null; // ₪ once; 0 means no setup fee, null means not decided
  city: string; // the footer: "OpenFrequency, <city>"
  // The big plan's ₪ a month (plans.ts "חנות גדולה", 1,500 conversations), shown beside the store plan on a pitch page
  // once Toran is on sale (pitch/page.ts). Null: the page shows the store plan alone.
  bigMonthly?: number | null;
  /** The operator's own price, set on purpose on /settings, in place of the plans (ACCOUNTS_PLANS). */
  override?: boolean;
};

/**
 * Toran's plans as openfrequency-accounts sells and bills them (its src/accounts/subscriptions.js PLANS.toran), before
 * VAT: the one price list, which accounts bills, the website shows and the pitch pages quote. test/offer.test.ts holds
 * this copy to accounts' file when accounts' checkout is beside this one. A row in the settings table no longer sets
 * the price by being there (the parent's check of 2026-11-12: every demo page said "449 ₪" with no big plan, from a
 * row typed before the plans existed, while accounts bills 590 ₪ and 1,190 ₪).
 */
export const ACCOUNTS_PLANS = {
  store: { monthly: 590, setup: 990, conversations: 300 },
  big: { monthly: 1190, setup: 990, conversations: 1500 },
} as const;

/** What the pitch pages quote while the operator set no price of their own: the plans. */
export const PLANS_OFFER: Offer = { monthly: ACCOUNTS_PLANS.store.monthly, bigMonthly: ACCOUNTS_PLANS.big.monthly, vat: 'excluded', setup: ACCOUNTS_PLANS.store.setup, city: 'אשדוד' };

export const OFFER_DEFAULT: Offer = { monthly: null, vat: null, setup: null, city: 'אשדוד' };
const KEY = 'offer';

/**
 * The price a pitch page quotes: the plans (ACCOUNTS_PLANS), unless the operator set a price of their own on purpose
 * (`override`, the settings page's "מחיר אחר בדפי הדמו"); the city is the operator's either way.
 */
export async function getOffer(db: Db): Promise<Offer> {
  const row = (await db.one<{ value: any }>('SELECT value FROM settings WHERE key = $1', [KEY]))?.value || {};
  if (row.override === true) return { ...OFFER_DEFAULT, ...row };
  return { ...PLANS_OFFER, city: typeof row.city === 'string' && row.city.trim() ? row.city : PLANS_OFFER.city };
}

/** The operator's row as it is kept, for the settings form (their own price, even while the plans win). */
export async function savedOffer(db: Db): Promise<Offer> {
  const row = await db.one<{ value: any }>('SELECT value FROM settings WHERE key = $1', [KEY]);
  return { ...OFFER_DEFAULT, ...(row?.value || {}) };
}

/**
 * The founders' offer as accounts says it (its src/accounts/founders.js: no setup fee for the next OF_FOUNDERS_SPOTS
 * workspaces that sign up), read from its public GET /public/founders.json: { spots, left }. Kept ten minutes; anything
 * that is not that answer within two seconds is null, and the page then says the setup fee as it is (the parent,
 * 2026-11-12: "mention the founders' offer only if you can read it reliably").
 */
export type Founders = { spots: number; left: number };
const FOUNDERS_MS = 10 * 60_000;
let founders: { at: number; value: Founders | null } | null = null;
export async function foundersOffer(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<Founders | null> {
  if (founders && Date.now() - founders.at < FOUNDERS_MS) return founders.value;
  const base = String(env.OF_ACCOUNTS_URL || '').trim().replace(/\/+$/, '');
  let value: Founders | null = null;
  if (/^https:\/\//.test(base)) {
    try {
      const r = await fetchImpl(`${base}/public/founders.json`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
      const b: any = r.ok ? await r.json() : null;
      if (b && Number.isInteger(b.spots) && Number.isInteger(b.left) && b.spots > 0 && b.left >= 0 && b.left <= b.spots) value = { spots: b.spots, left: b.left };
    } catch {
      value = null;
    }
  }
  founders = { at: Date.now(), value };
  return value;
}
/** For the tests: forget the kept answer. */
export const forgetFounders = () => {
  founders = null;
};

/**
 * Saved over what is there: a field the form does not carry (bigMonthly on an older form) stays as it was. A price saved
 * is the operator's own on purpose (override) unless it says otherwise; the settings form always says. A row saved
 * before 2026-11-12 has no override, so the plans win over it.
 */
export async function setOffer(db: Db, o: Partial<Offer>): Promise<void> {
  const now = await savedOffer(db);
  const override = o.override ?? (o.monthly != null ? true : now.override);
  await db.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [KEY, J({ ...now, ...o, override: Boolean(override) })]);
}

export const offerReady = (o: Offer) => o.monthly != null && o.monthly > 0 && o.vat != null && o.setup != null;

const ils = (n: number) => `${n.toLocaleString('he-IL')} ₪`;

/**
 * The price sentence, as the pitch page says it: "זה 249 ₪ לחודש, לא כולל מע״מ, ועוד 500 ₪ דמי הקמה, פעם אחת."
 * A part that is not decided yet comes out through `missing` (a visible [placeholder] in the owner's preview).
 */
export function priceSentence(o: Offer, missing: (label: string) => string, esc: (s: string) => string = (s) => s): string {
  const monthly = o.monthly != null && o.monthly > 0 ? esc(ils(o.monthly)) : missing('[המחיר] ₪');
  const vat = o.vat === 'included' ? 'כולל מע״מ' : o.vat === 'excluded' ? 'לא כולל מע״מ' : missing('[כולל או לא כולל מע״מ]');
  const setup = o.setup == null ? `, ${missing('[דמי הקמה, אם יש]')}` : o.setup > 0 ? `, ועוד ${esc(ils(o.setup))} דמי הקמה, פעם אחת` : '';
  return `זה ${monthly} לחודש, ${vat}${setup}.`;
}

/** How the page's two messages to us begin: "write to us" and "take this page down". Each ends with the page's link. */
export const PAGE_ABOUT = 'היי, לגבי העמוד שהכנתם';
export const PAGE_DOWN = 'היי, אפשר להוריד את העמוד שהכנתם';

/** OpenFrequency's WhatsApp number, in digits, or null when it is not set. */
export function ofWhatsapp(env: Record<string, string | undefined>): string | null {
  const n = String(env.TORAN_OWNER_WHATSAPP || '').split(/[,\s]+/)[0].replace(/\D/g, '');
  return n || null;
}
