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
// and where "take this page down" goes. It must not be the demo number, or a takedown
// request would land in the demo router.

export type Offer = {
  monthly: number | null; // ₪ a month
  vat: 'included' | 'excluded' | null;
  setup: number | null; // ₪ once; 0 means no setup fee, null means not decided
  city: string; // the footer: "OpenFrequency, <city>"
};

export const OFFER_DEFAULT: Offer = { monthly: null, vat: null, setup: null, city: 'אשדוד' };
const KEY = 'offer';

export async function getOffer(db: Db): Promise<Offer> {
  const row = await db.one<{ value: any }>('SELECT value FROM settings WHERE key = $1', [KEY]);
  return { ...OFFER_DEFAULT, ...(row?.value || {}) };
}

export async function setOffer(db: Db, o: Offer): Promise<void> {
  await db.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [KEY, J(o)]);
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

/** OpenFrequency's WhatsApp number, in digits, or null when it is not set (or is the demo number by mistake). */
export function ofWhatsapp(env: Record<string, string | undefined>): string | null {
  const n = String(env.TORAN_OWNER_WHATSAPP || '').split(/[,\s]+/)[0].replace(/\D/g, '');
  const demo = String(env.DEMO_WA_NUMBER || '').replace(/\D/g, '');
  return n && n !== demo ? n : null;
}
