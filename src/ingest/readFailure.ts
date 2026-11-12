import { INGESTIBLE_HE } from './catalogue.ts';

// Why reading a store's site failed, in the owner's words. The reason used to stay in the job ("האתר לא נכנס כליד: not
// an online store..."), and the owner read only "לא הצלחנו לקרוא את האתר", tried again and failed the same way (the
// pre-launch audit, 2026-11-12, P1-25). It reads the failed job's last_error, as the worker writes it:
//
//   add_store (jobs/worker.ts)   "האתר לא נכנס כליד: <reason>", the reason discovery kept for the domain
//                                (leads/discover.ts markSeen): a reject of leads/score.ts ("not an online store (no
//                                platform, cart or products found)", "not an Israeli Hebrew store", "sells what WhatsApp
//                                Business does not allow (...)"), "redirects to <domain>" (a domain already known), or a
//                                fetch error of core/http.ts ("timed out after N ms", "network: <code>", "HTTP <status>",
//                                "robots.txt disallows <path>", "<host> is not fetched (a private ...)", a redirect it
//                                refused); "האתר לא נמצא או לא ענה" when nothing was kept; "the store is already another
//                                workspace's"
//   ingest, rescrape             ingest/pack.ts ("the product feed is empty", "... Toran reads <platforms> stores"), or a
//                                fetch error as above
//
// Each kind says what happened and what to do next; anything else is a try that failed, with the way to us. Every
// line stands on its own: Today's banner, /start and accounts' /setup checklist all show it.

export type ReadFailure = 'not_store' | 'no_answer' | 'not_hebrew' | 'blocked' | 'moved' | 'taken' | 'platform' | 'other';

const KINDS: [ReadFailure, RegExp][] = [
  ['taken', /already another workspace/i],
  ['not_hebrew', /not an Israeli Hebrew store/i],
  ['not_store', /not an online store|the store has no products|the product feed is empty/i],
  ['platform', /Toran reads .+ stores|is not built yet/i],
  ['moved', /\bredirects to [a-z0-9.-]+\.[a-z]{2,}/i],
  ['blocked', /robots\.txt disallows|\bHTTP 40[13]\b/i],
  ['no_answer', /timed out|network:|\bHTTP \d{3}\b|לא נמצא או לא ענה|is not fetched|redirect|ECONN|ENOTFOUND|EAI_AGAIN/i],
];

/** Which kind of failure the job's error is. */
export function readFailureKind(error: string | null | undefined): ReadFailure {
  const e = String(error || '');
  return KINDS.find(([, re]) => re.test(e))?.[0] || 'other';
}

/** Whether trying again can help: a site that did not answer, another address, or a try that failed for no reason we know. */
const RETRY: Record<ReadFailure, boolean> = { not_store: true, no_answer: true, moved: true, not_hebrew: false, blocked: false, taken: false, platform: false, other: true };

/**
 * The owner's line for a failed read, from the job's last_error. `store`: the store exists already (its first read
 * failed, or a later one), so there is no other address to type at /start. `retry`: whether a "לנסות שוב" button is
 * worth showing beside it.
 */
export function readFailure(error: string | null | undefined, { store = false }: { store?: boolean } = {}): { kind: ReadFailure; text: string; retry: boolean } {
  const kind = readFailureKind(error);
  const to = /\bredirects to ([a-z0-9.-]+\.[a-z]{2,})/i.exec(String(error || ''))?.[1]?.toLowerCase() || '';
  const text: Record<ReadFailure, string> = {
    not_store: store
      ? 'לא מצאנו באתר מוצרים. אם יש בחנות מוצרים שמופיעים באתר, כתבו לנו ונבדוק.'
      : 'לא מצאנו באתר הזה מוצרים או עגלת קניות. אם החנות בכתובת אחרת, כותבים אותה ומנסים שוב. אם היא כאן, כתבו לנו ונבדוק.',
    no_answer: store
      ? 'האתר לא ענה לנו. כדאי לבדוק שהוא פתוח, ולנסות שוב בעוד כמה דקות.'
      : 'האתר לא ענה לנו. כדאי לבדוק שהכתובת נכונה ושהאתר פתוח, ולנסות שוב בעוד כמה דקות.',
    moved: `הכתובת הזו מעבירה לאתר אחר, ${to}. אם שם החנות שלכם, כותבים את הכתובת הזו ומנסים שוב.`,
    not_hebrew: 'האתר הזה לא בעברית, ותורן עונה כרגע רק בחנויות בעברית. כתבו לנו ונבדוק יחד.',
    blocked: 'האתר לא נתן לנו לקרוא אותו. כתבו לנו ונבדוק יחד.',
    taken: 'החנות הזאת כבר מחוברת לחשבון אחר. כתבו לנו ונבדוק.',
    platform: `כרגע תורן קורא רק חנויות ${INGESTIBLE_HE}. כתבו לנו.`,
    other: store
      ? 'לא הצלחנו לקרוא את האתר. אפשר לנסות שוב, ואם זה חוזר, כתבו לנו.'
      : 'לא הצלחנו לקרוא את האתר. כדאי לבדוק שהכתובת נכונה ולנסות שוב, ואם זה חוזר, כתבו לנו.',
  };
  // A store that exists has its address already: "another address" is not a try it can make from here.
  return { kind, text: text[kind], retry: RETRY[kind] && !(store && (kind === 'not_store' || kind === 'moved')) };
}

/** The line alone (readFailure). */
export const readFailureHe = (error: string | null | undefined, opts: { store?: boolean } = {}) => readFailure(error, opts).text;
