import { notOnShabbat, DAY } from './core/clock.ts';

// The two messages the owner sends by hand: the first one with the pitch link, and at
// most one reminder. The dashboard prepares them and copies them; nothing in Toran
// sends them. That is deliberate, and it is the law's line too: Israel's anti-spam
// rule (the Communications Law's section 30A) allows a business one approach to
// another business asking whether it wants to hear more, so the first message asks,
// says who is writing, and says how to stop; the reminder is the last one.
//
// Written in the hebrew-voice guide, as OpenFrequency (the company, "we"): the thing
// first, no slogans.

export const FOLLOWUP_DAYS = 4;

export function pitchUrl(env: Record<string, string | undefined>, slug: string): string {
  const base = String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || `http://localhost:${env.PORT || 4710}`;
  return `${base}/s/${slug}`;
}

/** "ל" joined to a Hebrew name, "ל־" before any other: "לכלי חרס של נורית", "ל־Nike". */
export const le = (name: string) => `${/^[א-ת]/.test(name) ? 'ל' : 'ל־'}${name}`;

export function firstMessage(o: { storeName: string; url: string }): string {
  return `היי, כאן OpenFrequency. בנינו ${le(o.storeName)} תורן שעונה ללקוחות שלכם על מחירים ומלאי, לפי מה שכתוב באתר שלכם. אפשר לנסות אותו עכשיו מהטלפון.
${o.url}

אם זה לא רלוונטי, אפשר לענות "לא" ולא נכתוב שוב.`;
}

export function reminderMessage(o: { storeName: string; url: string }): string {
  return `היי, יצא לכם להציץ בעמוד שהכנו ${le(o.storeName)}?
${o.url}

זו ההודעה האחרונה שלנו בנושא.`;
}

/** When the one reminder is due: four days after the first message, never on Shabbat. */
export const followupDue = (sentAt: number) => notOnShabbat(sentAt + FOLLOWUP_DAYS * DAY);

/** Where the owner sends it: the store's WhatsApp, else its email. The link opens the chat or the mail; the text is pasted by hand. */
export function contactTarget(s: { contact_whatsapp: string | null; contact_email: string | null; name?: string | null }): { kind: 'whatsapp' | 'email' | null; href: string | null; label: string } {
  if (s.contact_whatsapp) return { kind: 'whatsapp', href: `https://wa.me/${s.contact_whatsapp}`, label: 'להעתיק ולפתוח וואטסאפ' };
  if (s.contact_email) return { kind: 'email', href: `mailto:${s.contact_email}?subject=${encodeURIComponent(`תורן ${le(s.name || 'החנות')}`)}`, label: 'להעתיק ולפתוח מייל' };
  return { kind: null, href: null, label: 'להעתיק' };
}
