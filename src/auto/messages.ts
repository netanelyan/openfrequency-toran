// Toran's automatic messages, what each one says, and the WhatsApp template it goes out as (docs/customer.md,
// docs/connecting-channels.md). Four kinds, each turned on by the store's owner in Settings and off until then:
//
//   cart      one reminder about an abandoned checkout, a delay after it (the owner picks; an hour by default)
//   payment   the payment arrived (paid), is waiting (pending: a bank transfer, a payment the store confirms), or
//             did not go through (failed)
//   shipping  the order left (shipped, with the tracking link), and arrived (delivered, where the carrier says so)
//   review    a request for a review, a few days after the delivery (or after the shipping, where the platform never
//             says delivered)
//
// A WhatsApp message a business starts is a template Meta approved on the store's own WhatsApp account, one per
// message here: payment and shipping are utility (about an order the customer placed), the cart and the review are
// marketing, and go only to a customer who agreed to hear from the store (consent.ts). The body names the store, so it
// is submitted per store (templates.ts); the variables are the customer's first name, the order number and a link.
// Meta refuses a body that starts or ends with a variable, so every body has words on both sides of each.
//
// Email needs no template: the same words, with a subject. A marketing message says how to stop, on both channels.

export const KIND_KEYS = ['cart', 'payment', 'shipping', 'review'] as const;
export type Kind = (typeof KIND_KEYS)[number];
export type MessageKey = 'cart' | 'paid' | 'pending' | 'failed' | 'shipped' | 'delivered' | 'review';
export type Category = 'UTILITY' | 'MARKETING';

export type KindDef = { he: string; what: string; messages: MessageKey[]; marketing: boolean; delay?: { default: number; options: { minutes: number; he: string }[]; he: string } };

const HOUR_M = 60;
const DAY_M = 24 * 60;

export const KINDS: Record<Kind, KindDef> = {
  cart: {
    he: 'עגלה נטושה',
    what: 'תזכורת אחת ללקוח שהשאיר מוצרים בעגלה ולא סיים להזמין, עם הלינק לעגלה שלו.',
    messages: ['cart'],
    marketing: true,
    delay: { default: HOUR_M, he: 'כמה זמן אחרי שהעגלה נשארה', options: [{ minutes: 30, he: 'חצי שעה' }, { minutes: HOUR_M, he: 'שעה' }, { minutes: 2 * HOUR_M, he: 'שעתיים' }, { minutes: 4 * HOUR_M, he: '4 שעות' }, { minutes: DAY_M, he: 'יום' }] },
  },
  payment: { he: 'תשלום', what: 'הודעה כשהתשלום על הזמנה התקבל, כשהוא עוד מחכה (למשל העברה בנקאית), או כשהוא לא עבר.', messages: ['paid', 'pending', 'failed'], marketing: false },
  shipping: { he: 'משלוח', what: 'הודעה כשההזמנה יוצאת, עם הלינק למעקב, וכשחברת המשלוחים מדווחת שהיא נמסרה.', messages: ['shipped', 'delivered'], marketing: false },
  review: {
    he: 'בקשה לביקורת',
    what: 'כמה ימים אחרי שההזמנה הגיעה, בקשה אחת לכתוב ביקורת, עם הלינק שתבחרו.',
    messages: ['review'],
    marketing: true,
    delay: { default: 3 * DAY_M, he: 'כמה ימים אחרי שההזמנה הגיעה', options: [{ minutes: 2 * DAY_M, he: 'יומיים' }, { minutes: 3 * DAY_M, he: '3 ימים' }, { minutes: 5 * DAY_M, he: '5 ימים' }, { minutes: 7 * DAY_M, he: 'שבוע' }] },
  },
};

export const kindOf = (m: MessageKey): Kind => (KIND_KEYS.find((k) => KINDS[k].messages.includes(m)) as Kind);
export const isKind = (k: unknown): k is Kind => (KIND_KEYS as readonly string[]).includes(String(k));

/** "ב" before a Hebrew name, "ב-" before anything else ("ב-Kli Shop"). */
const pre = (letter: string, name: string) => (/^[֐-׿]/.test(name) ? `${letter}${name}` : `${letter}-${name}`);

type Vars = { name: string; order: string; link: string };
type MessageDef = {
  he: string;
  template: string;
  /** The template's body for this store, with {{1}}, {{2}}... */
  body: (store: string) => string;
  /** Which of the vars fill {{1}}, {{2}}... in order. */
  vars: (keyof Vars)[];
  needs: (keyof Vars)[];
  subject: (store: string, v: Vars) => string;
  email: (store: string, v: Vars) => string;
};

const ASK = 'אם יש שאלה, אפשר לכתוב לנו כאן.';

export const MESSAGES: Record<MessageKey, MessageDef> = {
  cart: {
    he: 'תזכורת על עגלה',
    template: 'toran_cart_reminder',
    body: (s) => `שלום {{1}}, נשארו לכם מוצרים בעגלה ${pre('ב', s)}. אפשר להמשיך מאיפה שעצרתם כאן: {{2}}\nיש שאלה על מוצר או על המשלוח? אפשר לכתוב לנו כאן.`,
    vars: ['name', 'link'],
    needs: ['link'],
    subject: (s) => `נשארו לכם מוצרים בעגלה ${pre('ב', s)}`,
    email: (s, v) => `שלום ${v.name},\n\nנשארו לכם מוצרים בעגלה ${pre('ב', s)}. אפשר להמשיך מאיפה שעצרתם כאן:\n${v.link}\n\nיש שאלה על מוצר או על המשלוח? אפשר לענות למייל הזה.`,
  },
  paid: {
    he: 'התשלום התקבל',
    template: 'toran_order_paid',
    body: (s) => `שלום {{1}}, קיבלנו את התשלום על הזמנה {{2}} ${pre('ב', s)}. תודה שקניתם אצלנו. ${ASK}`,
    vars: ['name', 'order'],
    needs: ['order'],
    subject: (s, v) => `קיבלנו את התשלום על הזמנה ${v.order} ${pre('ב', s)}`,
    email: (s, v) => `שלום ${v.name},\n\nקיבלנו את התשלום על הזמנה ${v.order} ${pre('ב', s)}. תודה שקניתם אצלנו.\n\nאם יש שאלה על ההזמנה, אפשר לענות למייל הזה.`,
  },
  pending: {
    he: 'התשלום מחכה',
    template: 'toran_payment_pending',
    body: (s) => `שלום {{1}}, הזמנה {{2}} ${pre('ב', s)} התקבלה, והתשלום עליה עוד לא הושלם. ההזמנה תצא אחרי שהתשלום יעבור. ${ASK}`,
    vars: ['name', 'order'],
    needs: ['order'],
    subject: (s, v) => `הזמנה ${v.order} ${pre('ב', s)} מחכה לתשלום`,
    email: (s, v) => `שלום ${v.name},\n\nהזמנה ${v.order} ${pre('ב', s)} התקבלה, והתשלום עליה עוד לא הושלם. ההזמנה תצא אחרי שהתשלום יעבור.\n\nאם יש שאלה, אפשר לענות למייל הזה.`,
  },
  failed: {
    he: 'התשלום לא עבר',
    template: 'toran_payment_failed',
    body: (s) => `שלום {{1}}, התשלום על הזמנה {{2}} ${pre('ב', s)} לא עבר. אפשר לנסות שוב כאן: {{3}}\nאם משהו לא מסתדר, כתבו לנו כאן ונעזור.`,
    vars: ['name', 'order', 'link'],
    needs: ['order', 'link'],
    subject: (s, v) => `התשלום על הזמנה ${v.order} ${pre('ב', s)} לא עבר`,
    email: (s, v) => `שלום ${v.name},\n\nהתשלום על הזמנה ${v.order} ${pre('ב', s)} לא עבר. אפשר לנסות שוב כאן:\n${v.link}\n\nאם משהו לא מסתדר, אפשר לענות למייל הזה ונעזור.`,
  },
  shipped: {
    he: 'ההזמנה יצאה',
    template: 'toran_order_shipped',
    body: (s) => `שלום {{1}}, הזמנה {{2}} ${pre('מ', s)} יצאה אליכם. אפשר לעקוב אחרי המשלוח כאן: {{3}}\n${ASK}`,
    vars: ['name', 'order', 'link'],
    needs: ['order', 'link'],
    subject: (s, v) => `הזמנה ${v.order} ${pre('מ', s)} יצאה אליכם`,
    email: (s, v) => `שלום ${v.name},\n\nהזמנה ${v.order} ${pre('מ', s)} יצאה אליכם.${v.link ? ` אפשר לעקוב אחרי המשלוח כאן:\n${v.link}` : ''}\n\nאם יש שאלה, אפשר לענות למייל הזה.`,
  },
  delivered: {
    he: 'ההזמנה נמסרה',
    template: 'toran_order_delivered',
    body: (s) => `שלום {{1}}, לפי חברת המשלוחים הזמנה {{2}} ${pre('מ', s)} נמסרה. אם משהו לא הגיע כמו שצריך, כתבו לנו כאן.`,
    vars: ['name', 'order'],
    needs: ['order'],
    subject: (s, v) => `הזמנה ${v.order} ${pre('מ', s)} נמסרה`,
    email: (s, v) => `שלום ${v.name},\n\nלפי חברת המשלוחים הזמנה ${v.order} ${pre('מ', s)} נמסרה. אם משהו לא הגיע כמו שצריך, אפשר לענות למייל הזה.`,
  },
  review: {
    he: 'בקשה לביקורת',
    template: 'toran_review_request',
    body: (s) => `שלום {{1}}, מקווים שהזמנה {{2}} ${pre('מ', s)} הגיעה בשלום. נשמח לשמוע מה דעתכם כאן: {{3}}\nתודה שקניתם אצלנו.`,
    vars: ['name', 'order', 'link'],
    needs: ['order', 'link'],
    subject: (s) => `איך היה ${pre('ב', s)}?`,
    email: (s, v) => `שלום ${v.name},\n\nמקווים שהזמנה ${v.order} ${pre('מ', s)} הגיעה בשלום. נשמח לשמוע מה דעתכם כאן:\n${v.link}\n\nתודה שקניתם אצלנו.`,
  },
};

export const categoryOf = (m: MessageKey): Category => (KINDS[kindOf(m)].marketing ? 'MARKETING' : 'UTILITY');

/** A marketing template's footer and its one button: the way to stop, which a press of sends as "הסר" (consent.ts). */
export const STOP_FOOTER = 'לא רוצים עוד הודעות כאלה? כתבו הסר';
export const STOP_BUTTON = 'הסר';
const STOP_EMAIL = 'לא רוצים עוד מיילים כאלה? אפשר לענות למייל הזה במילה הסר.';

/** The customer's first name for "שלום ...", or "לכם" ("שלום לכם,") when the order has none worth using. */
export function firstName(s: unknown): string {
  const w = String(s ?? '').trim().split(/\s+/)[0] || '';
  return /^[\p{L}][\p{L}'׳-]{0,24}$/u.test(w) ? w : 'לכם';
}

export const SAMPLE: Vars = { name: 'דנה', order: '#1042', link: 'https://your-store.example/...' };

/** What one message says on WhatsApp: the template's parameters in order, and the text as the customer reads it. */
export function waText(m: MessageKey, store: string, v: Vars): { params: string[]; text: string } {
  const d = MESSAGES[m];
  const params = d.vars.map((k) => v[k]);
  let text = d.body(store).replace(/\{\{(\d+)\}\}/g, (_, i) => params[Number(i) - 1] ?? '');
  if (KINDS[kindOf(m)].marketing) text = `${text}\n\n${STOP_FOOTER}`;
  return { params, text };
}

/** What one message says by email: its subject and text, signed with the store's name. */
export function emailText(m: MessageKey, store: string, v: Vars): { subject: string; text: string } {
  const d = MESSAGES[m];
  const stop = KINDS[kindOf(m)].marketing ? `\n\n${STOP_EMAIL}` : '';
  return { subject: d.subject(store, v), text: `${d.email(store, v)}\n\n${store}${stop}` };
}

/** Is every variable this message needs there? (A shipment with no tracking link has nothing to put in {{3}}.) */
export const complete = (m: MessageKey, v: Partial<Vars>) => MESSAGES[m].needs.every((k) => String(v[k] || '').trim());

/** The template as it is submitted to the store's WhatsApp account (Graph API, POST /<WABA>/message_templates). */
export function templateRequest(m: MessageKey, store: string) {
  const d = MESSAGES[m];
  const marketing = categoryOf(m) === 'MARKETING';
  const example = d.vars.map((k) => SAMPLE[k]).map((x, i) => (d.vars[i] === 'link' ? 'https://www.example.com/c/1042' : x));
  return {
    name: d.template,
    language: 'he',
    category: categoryOf(m),
    components: [
      { type: 'BODY', text: d.body(store), example: { body_text: [example] } },
      ...(marketing ? [{ type: 'FOOTER', text: STOP_FOOTER }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: STOP_BUTTON }] }] : []),
    ],
  };
}
