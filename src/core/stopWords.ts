// Asking us to stop, in the words people use (the owner, 2026-11-17, on our support's conversation 409, where "מהר הסר"
// was answered as a question and "חאלס", twice, with the link once more: our opt-outs read only a whole message of
// one word, "הסר"). A short message counts when, once the small words around the ask are taken away (please, quickly,
// me, from the list, more messages), all that is left is the ask itself:
//
//   asksRemoval    "remove me": הסר, הסירו, תסירו, להסיר, הסרה, stop, unsubscribe, remove; תורידו, תמחקו only with
//                  their "me" or "from the list" ("תוריד את המחיר" is another question); a "don't" before writing or
//                  sending ("אל תכתבו לי", "לא לשלוח יותר"), or "stop" before it ("תפסיקו לשלוח לי הודעות")
//   asksToStop     that, or "enough" alone: די, מספיק, חאלס, תפסיקו, עזבו, ספאם, enough, spam. Only where we wrote
//                  first (ops/outreach.ts outreachWord): to a store's own Toran "די" may close a question, and a store's
//                  opt-out stops its order updates too (auto/consent.ts), so there only asksRemoval stops
//
// "רוצה להסיר את המוצר מההזמנה" keeps its other words, and is a question like any other.

const REMOVE = new Set(['הסר', 'הסירו', 'הסירי', 'תסירו', 'תסיר', 'תסירי', 'להסיר', 'הסרה', 'stop', 'unsubscribe', 'unsub', 'remove', 'removed']);
/** Removal only with its "me" or "from the list" (OBJECT). */
const TAKE_OFF = new Set(['תורידו', 'תוריד', 'תורידי', 'הורידו', 'להוריד', 'תוציאו', 'תוציא', 'הוציאו', 'להוציא', 'תמחקו', 'תמחק', 'תמחקי', 'מחקו', 'למחוק']);
const OBJECT = new Set(['אותי', 'אותנו', 'המספר', 'מהרשימה', 'מהרשימות', 'מרשימת', 'מהתפוצה', 'מהדיוור', 'מההודעות', 'מהקבוצה', 'me', 'us']);
/** Writing or sending: removal after a "don't" (NEGATION) or a "stop" (ENOUGH), and nothing alone ("תשלחו" is a yes). */
const SEND = new Set(['תכתבו', 'תכתוב', 'תכתבי', 'לכתוב', 'תשלחו', 'תשלח', 'תשלחי', 'לשלוח', 'תפנו', 'לפנות', 'תתקשרו', 'להתקשר', 'תטרידו', 'להטריד', 'להציק', 'תציקו', 'write', 'send', 'message', 'text', 'contact']);
const NEGATION = new Set(['אל', 'לא', "don't", 'dont', 'never']);
const ENOUGH = new Set(['די', 'מספיק', 'חאלס', 'חלאס', "ח'לאס", 'ח׳לאס', 'תפסיקו', 'תפסיק', 'תפסיקי', 'הפסיקו', 'להפסיק', 'עזבו', 'עזוב', 'עזבי', 'תעזבו', 'תעזוב', 'ספאם', 'spam', 'enough']);
const FILLER = new Set([
  'בבקשה', 'מהר', 'דחוף', 'תודה', 'כבר', 'נו', 'עכשיו', 'מיד', 'מייד', 'את', 'שלי', 'שלנו', 'הזה', 'הזאת', 'מכאן', 'מפה', 'פה',
  'לי', 'לנו', 'אני', 'אנחנו', 'רוצה', 'רוצים', 'מבקש', 'מבקשת', 'מבקשים', 'אפשר', 'יותר', 'שוב', 'עוד', 'הודעות', 'ההודעות',
  'הודעה', 'זה', 'רק', 'גם', 'באמת', 'אחי', 'המספר', 'הזו', 'כאן', 'כל', 'אלינו', 'אליי', 'אלי', 'עצמי', 'שלכם', 'אצלכם',
  'please', 'pls', 'plz', 'now', 'asap', 'from', 'the', 'this', 'list', 'my', 'number', 'just', 'thanks', 'thank', 'you', 'your', 'ok', 'and', 'any', 'more',
  'messages', 'to', 'i', 'want', 'wanna', 'be', 'of',
  ...NEGATION, ...OBJECT,
]);

type Ask = { removal: boolean; stop: boolean };

/** What a short message asks, as the sets above read it; null when it says anything else. */
function ask(text: string): Ask | null {
  const words = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}'׳]+/gu, ' ').split(' ').map((w) => w.replace(/^['׳]+|['׳]+$/g, '')).filter(Boolean);
  if (!words.length || words.length > 10) return null;
  const has = (set: Set<string>) => words.some((w) => set.has(w));
  const object = has(OBJECT);
  const negation = has(NEGATION);
  // A word with its "ו" ("ותסירו", "ודי") is the word.
  const kind = (w: string): 'remove' | 'send' | 'enough' | 'filler' | null => {
    if (REMOVE.has(w) || (object && TAKE_OFF.has(w))) return 'remove';
    if (SEND.has(w)) return 'send';
    if (ENOUGH.has(w)) return 'enough';
    if (FILLER.has(w)) return 'filler';
    return w.length > 2 && w.startsWith('ו') ? kind(w.slice(1)) : null;
  };
  const kinds = words.map(kind);
  if (kinds.includes(null)) return null;
  const enough = kinds.includes('enough');
  const removal = kinds.includes('remove') || (kinds.includes('send') && (negation || enough));
  const stop = removal || (enough && !kinds.includes('send'));
  return removal || stop ? { removal, stop } : null;
}

/** "Remove me", in any short form: a store's own opt-out (auto/consent.ts) and ours (ops/outreach.ts). */
export const asksRemoval = (text: string): boolean => Boolean(ask(text)?.removal);

/** "Remove me", or "enough": where we wrote first, either one stops us (ops/outreach.ts outreachWord). */
export const asksToStop = (text: string): boolean => Boolean(ask(text)?.stop);
