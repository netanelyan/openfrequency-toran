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

/** The link to a Teder demo someone asked for on the website, sent on the demo number where they asked (request.ts). */
export const tederRequestedLink = (o: { storeName: string; url: string }) =>
  `הדמו של תדר ${le(o.storeName)} מוכן. הכנו לחנות מצגת לדוגמה על נושא מהתחום שלה, בגדלים של טיקטוק ואינסטגרם:
${o.url}`;

/** A Teder demo someone asked for on the website: its page, from the operator's own WhatsApp. */
export const tederFirst = (o: { storeName: string; url: string }) =>
  `היי, כאן OpenFrequency. ביקשתם באתר דמו של תדר, אז הכנו ${le(o.storeName)} מצגת לדוגמה על נושא מהתחום של החנות, בגדלים של טיקטוק ואינסטגרם:
${o.url}

אם זה כבר לא רלוונטי, אפשר לענות "לא" ולא נכתוב שוב.`;

/** The one reminder for a Teder demo. */
export const tederReminder = (o: { storeName: string; url: string }) =>
  `היי, יצא לכם להציץ במצגת שהכנו ${le(o.storeName)}?
${o.url}

זו ההודעה האחרונה שלנו בנושא.`;

// The messages of the shared lead dashboard (ops/leadsAdmin.ts) that the operator copies and sends from their own
// WhatsApp when our number cannot (the owner, 2026-11-11: "the message that is suggested being sent to the phone number
// on whatsapp should be according to that", the demo chosen: Toran, Teder or both). Toran's own are outreach.ts's
// firstMessage and reminderMessage. These are the same approach in its two places, with each demo's link in the text,
// where the message from our number has a button.

/**
 * The first message for Teder's demo alone, to a store that did not ask for one: Teder's own (openfrequency-teder
 * src/leads/messages.js TEDER_COLD_FIRST) word for word, without the slideshow's topic, which Toran is not told.
 */
export const tederColdFirst = (o: { storeName: string; url: string }) =>
  `היי, כאן OpenFrequency. בנינו את תדר, שמכין לחנויות אונליין מצגות בעברית לטיקטוק ולאינסטגרם. הוא קורא את האתר של החנות, וכותב ומעצב מצגות על נושאים מהתחום שלה. כל מצגת מחכה לאישור שלכם לפני שהיא עולה.

הכנו ${le(o.storeName)} מצגת אחת לדוגמה, כדי שתראו איך זה ייראה אצלכם:
${o.url}

אם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. אם לא, אפשר לענות "לא" ולא נכתוב שוב.`;

/** The first message with both demos: the words of the template openfrequency_pitch (ops/outreach.ts), the two links in place of its buttons. */
export const bothFirst = (o: { storeName: string; toranUrl: string; tederUrl: string }) =>
  `היי, כאן OpenFrequency. הכנו ${le(o.storeName)} שני דברים לנסות: תורן, שעונה ללקוחות שלכם בוואטסאפ על מחירים ומלאי לפי מה שכתוב באתר שלכם, ומצגת לדוגמה של תדר, שכותב ומעצב לחנויות מצגות בעברית לטיקטוק ולאינסטגרם.

את תורן אפשר לנסות עכשיו מהטלפון:
${o.toranUrl}

והמצגת כאן:
${o.tederUrl}

אם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. אם לא, אפשר לענות "לא" ולא נכתוב שוב.`;

/** The one reminder for both demos. */
export const bothReminder = (o: { storeName: string; toranUrl: string; tederUrl: string }) =>
  `היי, יצא לכם להציץ במה שהכנו ${le(o.storeName)}?
תורן: ${o.toranUrl}
המצגת של תדר: ${o.tederUrl}

זו ההודעה האחרונה שלנו בנושא.`;

/**
 * To a store that already has Toran, not outreach: its WhatsApp has to be connected again (channels/waStore.ts),
 * before its token ends (`ends`) or after it ended (no `ends`).
 */
export const reconnectWhatsapp = (o: { storeName: string; url: string; ends: string | null }) =>
  o.ends
    ? `היי, כאן OpenFrequency. החיבור של הוואטסאפ של ${o.storeName} לתורן מסתיים ב-${o.ends}, ואחרי זה תורן לא יוכל לענות בו. צריך לחבר אותו מחדש, זה לוקח דקה:
${o.url}

הוואטסאפ בטלפון לא משתנה, והשיחות נשארות.`
    : `היי, כאן OpenFrequency. החיבור של הוואטסאפ של ${o.storeName} לתורן הסתיים, ותורן לא עונה בו עכשיו. ההודעות של הלקוחות מחכות לכם בשיחות בדשבורד. כדי שתורן יחזור לענות, מחברים מחדש כאן:
${o.url}`;

// To someone who asked for a demo on the website and has no link yet (queue.ts stuckRequests), from the operator's own
// WhatsApp. Not outreach: they asked, and they are waiting for an answer.

const PRODUCT_HE = { toran: 'תורן', teder: 'תדר' } as const;

/** Their demo is still being built (or checked): the link comes once it is ready. */
export const stuckWaiting = (o: { product: 'toran' | 'teder'; storeName: string }) =>
  `היי, כאן OpenFrequency. ביקשתם באתר דמו של ${PRODUCT_HE[o.product]} ${le(o.storeName)}. הוא עוד בבנייה, ונשלח לכם את הלינק כשיהיה מוכן.`;

/** Their demo could not be built: the site was not read, the build failed, or Teder did not take the request. */
export const stuckFailed = (o: { product: 'toran' | 'teder'; storeName: string }) =>
  `היי, כאן OpenFrequency. ביקשתם באתר דמו של ${PRODUCT_HE[o.product]} ${le(o.storeName)}, ולא הצלחנו לבנות אותו. אם יש שאלה, אפשר לענות כאן.`;

/** A Toran demo for a store on a platform Toran does not read (`supported` is ingest/catalogue.ts INGESTIBLE_HE). */
export const stuckPlatform = (o: { storeName: string; platform: string; supported: string }) =>
  `היי, כאן OpenFrequency. ביקשתם באתר דמו של תורן ${le(o.storeName)}. תורן בונה דמו רק לחנויות ${o.supported}, והחנות על ${o.platform}, אז לא יכולנו לבנות אותו. אם יש שאלה, אפשר לענות כאן.`;

/** Why a store said no, as the operator picks it. */
export const LOST_REASONS: Record<string, string> = {
  not_interested: 'לא מעוניינים',
  opted_out: 'ביקשו שנסיר אותם',
  price: 'יקר להם',
  has_solution: 'יש להם פתרון אחר',
  no_answer: 'לא עונים',
  not_fit: 'לא מתאים לחנות',
  other: 'אחר',
};
