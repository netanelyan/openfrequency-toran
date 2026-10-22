import type { App } from '../app.ts';
import { brandColor, displayName } from '../ingest/brand.ts';
import { getOffer, offerReady, ofWhatsapp } from '../offer.ts';

// What a pitch page needs before anyone but the owner may see it. A page with a gap is
// never shown with a guess (a grey colour, the domain for a name, a sample answer built
// from a row, a made-up price): it waits in the review queue, which lists the gaps, and
// its approve button stays off until they are filled.
//
// Who may see a page: the owner always (a dashboard session, as a preview); anyone else
// only when it is approved, complete, not skipped and not taken down.

export type Gap = { key: 'name' | 'color' | 'products' | 'sample' | 'price' | 'of_number' | 'demo_number'; he: string };

const GAP_HE: Record<Gap['key'], string> = {
  name: 'אין שם לחנות. אפשר להוסיף אותו בעריכה, תחת "מותג".',
  color: 'לא נמצא צבע מותג באתר. אפשר לבחור צבע בעריכה, תחת "מותג".',
  products: 'לא נמצאו מוצרים באתר.',
  sample: 'אין שיחת דוגמה, כי תורן לא ענה על שתי השאלות בלי להעביר אליך. אפשר לבנות אותה שוב מהעריכה.',
  price: 'המחיר עוד לא נקבע. קובעים אותו בהגדרות.',
  of_number: 'אין מספר וואטסאפ של OpenFrequency (TORAN_OWNER_WHATSAPP), אז אי אפשר לבקש להוריד את העמוד.',
  demo_number: 'אין מספר דמו (DEMO_WA_NUMBER), אז הכפתור של תורן לא עובד.',
};

const gap = (key: Gap['key']): Gap => ({ key, he: GAP_HE[key] });

export type PitchStore = { id: number; name: string | null; brand: any; brand_override: any };

/** The gaps that hold a store's page back. Empty means it can be approved and shown. */
export async function pitchGaps(app: App, s: PitchStore): Promise<Gap[]> {
  const brand = { ...(s.brand || {}), ...(s.brand_override || {}) };
  const gaps: Gap[] = [];
  if (!displayName(s.brand_override?.name, s.brand?.name, s.name)) gaps.push(gap('name'));
  if (!brandColor(brand)) gaps.push(gap('color'));
  const n = await app.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM products WHERE store_id = $1 AND gone_at IS NULL', [s.id]);
  if (!n?.n) gaps.push(gap('products'));
  const pitch = await app.db.one<{ sample_chat: any[] }>('SELECT sample_chat FROM pitches WHERE store_id = $1', [s.id]);
  if ((pitch?.sample_chat || []).length < 4) gaps.push(gap('sample'));
  if (!offerReady(await getOffer(app.db))) gaps.push(gap('price'));
  if (!ofWhatsapp(app.env)) gaps.push(gap('of_number'));
  if (!String(app.env.DEMO_WA_NUMBER || '').replace(/\D/g, '')) gaps.push(gap('demo_number'));
  return gaps;
}

/** Whether a visitor without a dashboard session may open the page. */
export const isPublic = (s: { approved_at: any; taken_down_at: any; status: string }, gaps: Gap[]) => Boolean(s.approved_at) && !s.taken_down_at && s.status !== 'skipped' && gaps.length === 0;
