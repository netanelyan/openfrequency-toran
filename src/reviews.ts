import type { App } from './app.ts';
import { audit, event } from './db/log.ts';
import { firstName } from './auto/messages.ts';

// Reviews collected in the conversation (migration 061; the owner, 2026-11-06, docs/todo.md: "a message a few days
// after delivery asking for a review; the review then shows on the store's site ... only with the customer's
// permission to show it").
//
//   1. the review request went out (auto/send.ts, kind review). The customer answers it, on the same channel, within
//      REPLY_DAYS, with a rating: a digit from 1 to 5 ("5", "4/5", "5 כוכבים") or stars ("⭐⭐⭐⭐"), and whatever
//      else they wrote is the review's words. Nothing that reads as no rating is taken: the agent answers it as any
//      message (it is told the store asked for a review).
//   2. Toran thanks them and asks once whether it may show the review on the store's site with their first name.
//   3. Their next message: a yes or a no is kept (publish), thanked in one line, and not answered by the agent;
//      anything else leaves publish unknown and goes to the agent as usual. One review a request.
//   4. The owner sees the reviews on Settings (with the customer's word) and approves one to show, or hides it. The
//      store's site shows only those both said yes to (web/widget.ts, the reviews block), newest first.
//
// Publishing into the platform's own reviews is not done here: Shopify has no product reviews API of its own (its
// reviews are apps'), and WooCommerce's (REST products/reviews) needs a Read/Write key and the order's product, which
// docs/todo.md leaves for later.

export const REPLY_DAYS = 14;

const DIGIT = /(?:^|[^\d])([1-5])(?:\s*(?:\/\s*5|מתוך\s*5|כוכבים?|כוכב|stars?|⭐|★))?(?!\d)/i;

/** The rating in a customer's answer, and the rest as the review's words; null when there is no clear rating. */
export function ratingOf(raw: string): { rating: number; text: string } | null {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 1500) return null;
  const stars = (text.match(/⭐|★/g) || []).length;
  if (stars >= 1 && stars <= 5) return { rating: stars, text: text.replace(/[⭐★]/g, '').replace(/\s+/g, ' ').trim().slice(0, 600) };
  // A digit that is a rating, not part of an order number or a price: on its own, or with "/5", "מתוך 5" or "כוכבים".
  const m = DIGIT.exec(text);
  if (!m) return null;
  // Marked ("4/5", "3 מתוך 5", "5 כוכבים") a digit is a rating anywhere; unmarked, only when the message opens with it
  // ("5", "4, הגיע מהר"), never inside a sentence ("שילמתי 3 פעמים", "הזמנה 1042").
  const marked = /[1-5]\s*(?:\/\s*5|מתוך\s*5|כוכב|stars?)/i.test(text);
  if (!marked && !/^\s*[1-5]\s*(?:[.,!:\-–]|$)/.test(text)) return null;
  // The customer's own words: the rating taken off when it opens the message, the sentence kept whole when it sits inside it.
  const rest = /^\s*[1-5]/.test(text) ? text.replace(m[0], ' ').replace(/\s+/g, ' ').replace(/^[\s,.:\-–]+|[\s,.:\-–]+$/g, '').trim() : text;
  return { rating: Number(m[1]), text: rest.slice(0, 600) };
}

const YES = /^\s*(?:כן|כן,?\s*בטח|בטח|ברור|אפשר|בשמחה|סבבה|אוקיי?|ok|okay|yes|👍)\s*[.!]*\s*$/i;
const NO = /^\s*(?:לא|לא,?\s*תודה|עדיף שלא|בלי|no)\s*[.!]*\s*$/i;

export const askLine = (store: string) => `תודה על הביקורת! אפשר להציג אותה באתר של ${store} עם השם הפרטי שלכם? אפשר לענות כן או לא.`;
// The store's site shows a review only once the owner approves it (step 4 above), so the customer is told it may, not
// that it will (the audit of 2026-11-12, P2-8: "הביקורת תופיע באתר").
const thanksYes = 'סגור, תודה. אם החנות תאשר אותה, הביקורת תופיע באתר שלה.';
const thanksNo = 'בסדר, היא תישאר רק אצל החנות. תודה שכתבתם!';

/**
 * A customer's message in a conversation where the store asked for a review: the line Toran says back, when the
 * message was a rating or the answer to "may we show it". Null when the message is anything else (the agent answers).
 */
export async function reviewTurn(app: App, storeId: number, conversationId: number, text: string, store: string): Promise<string | null> {
  const asked = await app.db.one<{ id: number }>("SELECT id FROM reviews WHERE conversation_id = $1 AND step = 'asked' ORDER BY id DESC LIMIT 1", [conversationId]);
  if (asked) {
    const word = YES.test(text) ? 'yes' : NO.test(text) ? 'no' : null;
    await app.db.query("UPDATE reviews SET step = 'done', publish = $2 WHERE id = $1", [asked.id, word || 'unknown']);
    if (!word) return null;
    await event(app.db, storeId, 'review_permission', { reviewId: asked.id, publish: word });
    return word === 'yes' ? thanksYes : thanksNo;
  }
  const req = await app.db.one<{ id: number; ref: string | null; contact: any }>(
    `SELECT e.id, e.ref, e.contact FROM auto_events e WHERE e.store_id = $1 AND e.conversation_id = $2 AND e.message = 'review' AND e.status = 'sent'
       AND e.sent_at > now() - make_interval(days => ${REPLY_DAYS}) AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.event_id = e.id)
     ORDER BY e.id DESC LIMIT 1`,
    [storeId, conversationId],
  );
  if (!req) return null;
  const r = ratingOf(text);
  if (!r) return null;
  const name = firstName(req.contact?.name);
  const row = await app.db.one<{ id: number }>(
    'INSERT INTO reviews (store_id, conversation_id, event_id, order_ref, rating, text, name) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING id',
    [storeId, conversationId, req.id, req.ref, r.rating, r.text, name === 'לכם' ? null : name],
  );
  if (!row) return null;
  await event(app.db, storeId, 'review_in', { reviewId: row.id, rating: r.rating });
  return askLine(store);
}

export type ReviewRow = { id: number; rating: number; text: string; name: string | null; publish: string; status: string; order_ref: string | null; created_at: string; conversation_id: number | null };

/** A store's reviews for the owner, newest first. */
export const reviewsOf = (app: App, storeId: number, limit = 30) =>
  app.db.query<ReviewRow>('SELECT id, rating, text, name, publish, status, order_ref, created_at, conversation_id FROM reviews WHERE store_id = $1 ORDER BY id DESC LIMIT $2', [storeId, limit]);

/** The owner's decision on one of the store's reviews: approved to show (only one the customer said yes to), or hidden. */
export async function decide(app: App, storeId: number, reviewId: number, what: 'approve' | 'hide', by: string): Promise<boolean> {
  const r = await app.db.one<{ publish: string }>('SELECT publish FROM reviews WHERE id = $1 AND store_id = $2', [reviewId, storeId]);
  if (!r || (what === 'approve' && r.publish !== 'yes')) return false;
  await app.db.query('UPDATE reviews SET status = $3, decided_by = $4, decided_at = now() WHERE id = $1 AND store_id = $2', [reviewId, storeId, what === 'approve' ? 'approved' : 'hidden', by]);
  await audit(app.db, { actor: by, action: `review_${what}`, storeId, detail: { reviewId } });
  return true;
}

/** What the store's site shows: the reviews both the customer and the owner said yes to, newest first, with a first name. */
export async function approvedReviews(app: App, storeId: number, limit = 12) {
  const rows = await app.db.query<{ rating: number; text: string; name: string | null; created_at: string }>(
    "SELECT rating, text, name, created_at FROM reviews WHERE store_id = $1 AND status = 'approved' AND publish = 'yes' ORDER BY id DESC LIMIT $2",
    [storeId, limit],
  );
  return rows.map((r) => ({ rating: Number(r.rating), text: r.text, name: r.name || 'לקוח', at: new Date(r.created_at).toISOString() }));
}
