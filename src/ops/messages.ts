import { le } from '../outreach.ts';

// The messages the operator's dashboard prepares beyond outreach.ts's two (the first message, the one reminder). The
// same line holds: a store gets one approach and one reminder, and after the reminder nothing more is sent unless they
// write. Each message here takes one of those two places, never a third. Written in the hebrew-voice guide, as
// OpenFrequency (the company, "we").

/** The link to a Toran demo someone asked for on the website, sent on the demo number where they asked (request.ts). */
export const requestedLink = (o: { storeName: string; url: string }) =>
  `הדמו של תורן ${le(o.storeName)} מוכן. פותחים את הלינק, ומשם לוחצים על הכפתור שמתחיל שיחה עם תורן:
${o.url}`;

/** The same, from the operator's own WhatsApp, once the 24 hours on the demo number are over. */
export const requestedLinkLater = (o: { storeName: string; url: string }) =>
  `היי, כאן OpenFrequency. ביקשתם באתר דמו של תורן, והוא מוכן ${le(o.storeName)}. אפשר לנסות אותו עכשיו מהטלפון:
${o.url}

אם זה כבר לא רלוונטי, אפשר לענות "לא" ולא נכתוב שוב.`;

/** In the reminder's place, for a store that tried the demo: asking how it went. */
export const triedDemo = (o: { storeName: string }) =>
  `היי, ראינו שניסיתם את הדמו של תורן ${le(o.storeName)}. איך היה? אם תרצו, נקבע שיחה קצרה ונראה לכם איך הוא עובד עם הלקוחות של החנות.

אם זה לא רלוונטי, אפשר לענות "לא" ולא נכתוב שוב.`;

/** A Teder demo someone asked for on the website: its page. */
export const tederFirst = (o: { storeName: string; url: string }) =>
  `היי, כאן OpenFrequency. ביקשתם באתר דמו של טדר, אז הכנו ${le(o.storeName)} מצגת לדוגמה על נושא מהתחום של החנות, בגדלים של טיקטוק ואינסטגרם:
${o.url}

אם זה כבר לא רלוונטי, אפשר לענות "לא" ולא נכתוב שוב.`;

/** The one reminder for a Teder demo. */
export const tederReminder = (o: { storeName: string; url: string }) =>
  `היי, יצא לכם להציץ במצגת שהכנו ${le(o.storeName)}?
${o.url}

זו ההודעה האחרונה שלנו בנושא.`;

/** Why a store said no, as the operator picks it. */
export const LOST_REASONS: Record<string, string> = {
  not_interested: 'לא מעוניינים',
  price: 'יקר להם',
  has_solution: 'יש להם פתרון אחר',
  no_answer: 'לא עונים',
  not_fit: 'לא מתאים לחנות',
  other: 'אחר',
};
