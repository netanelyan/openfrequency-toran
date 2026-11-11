// Not sent since 2026-11-02 (the owner: "managing teder through whatsapp, only through the dashboard"): every one of
// them is about the owner's Teder account, and nothing of Teder's goes to WhatsApp now (owners/notify.ts
// TEDER_ON_WHATSAPP). They stay here as the record of what was approved at Meta, until they are deleted there.
//
// The WhatsApp templates the owner line sends outside the 24 hours after the owner's last message, when Meta allows
// nothing else. All of them are utility templates in Hebrew (he), each about the owner's own Teder account, and each
// asks for a one-word reply that opens the window, so the full message (the covers, the images, the caption) goes out
// as an ordinary answer after it.
//
// The text is what is submitted to Meta (docs/whatsapp-templates.md, made from this file). Twilio keeps an approved
// template as a Content SID (HX...); TWILIO_TEMPLATES maps each name to its SID ("teder_posts_ready=HX...,..."). On
// Meta's Cloud API (META_OWNER_PHONE_ID) a template goes by its name, and META_TEMPLATES lists the names Meta
// approved. A template not set for the provider in use is not sent, and the attempt is recorded as skipped
// ('no_template').
//
// The footer carries the disclosure and the way out, so every template message says it comes from a digital
// assistant and how to stop it.

export const FOOTER = 'העוזר הדיגיטלי של OpenFrequency · להפסקה כתבו הפסק';

export type Template = { name: string; body: string; example: string[]; buttons?: string[] };

export const TEMPLATES: Record<string, Template> = {
  teder_posts_ready: {
    name: 'teder_posts_ready',
    body: 'יש בתדר {{1}} לאישור שלכם. כתבו "הצג" ואשלח לכאן את מה שמחכה, עם מספרים.',
    example: ['3 מצגות חדשות'],
    buttons: ['הצג'],
  },
  teder_post_reminder: {
    name: 'teder_post_reminder',
    body: 'הגיע הזמן להעלות את "{{1}}" ל{{2}}. כתבו "שלח" ואשלח לכאן את התמונות ואת הכיתוב.',
    example: ['5 טעויות בבחירת נעלי ריצה', 'טיקטוק'],
    buttons: ['שלח'],
  },
  teder_post_unposted: {
    name: 'teder_post_unposted',
    body: 'הפוסט "{{1}}" עוד לא עלה ל{{2}}. כתבו "שלח" ואשלח לכאן את כל התמונות ואת הכיתוב, מוכנים להעלאה.',
    example: ['5 טעויות בבחירת נעלי ריצה', 'אינסטגרם'],
    buttons: ['שלח'],
  },
  teder_quota_low: {
    name: 'teder_quota_low',
    body: 'בתדר נשארו לכם החודש {{1}}. בתחילת החודש הבא המונה מתחיל מחדש.',
    example: ['8 מתוך 40 הצעות למצגות'],
  },
  teder_weekly_summary: {
    name: 'teder_weekly_summary',
    body: 'הסיכום השבועי מתדר, {{1}}: {{2}}. כתבו "סטטוס" ואשלח את כל הפרטים.',
    example: ['18.10 עד 24.10', 'עלו 9 פוסטים, עם 48,210 צפיות'],
    buttons: ['סטטוס'],
  },
};

/**
 * Toran's own, to a store owner's number about their own store (owners/notify.ts waitingToOwners; the audit of
 * 2026-11-12, P1-6: the owner heard of a waiting customer by email only, at most three a day). Written here for the
 * owner to submit in WhatsApp Manager; not submitted. Until Meta approves it and its name is in META_TEMPLATES, an
 * owner hears on WhatsApp only inside the 24 hours after they last wrote to our number (a plain message then). Its URL
 * button opens the conversation: {{1}} of the button is the path after Toran's address (chat/123).
 */
export type UrlButton = { text: string; base: string; example: string };
export const TORAN_TEMPLATES: Record<string, Template & { url?: UrlButton }> = {
  toran_customer_waiting: {
    name: 'toran_customer_waiting',
    body: 'לקוח של {{1}} מחכה לתשובה שלכם.\nהוא כתב: "{{2}}"\n\nעונים לו מהשיחה בתורן, בכפתור למטה.',
    example: ['כלי חרס של נורית', 'אפשר לאסוף מהסטודיו בשבת?'],
    url: { text: 'לשיחה', base: 'https://toran.openfrequency.co.il/', example: 'chat/123' },
  },
};

/** The submission sheet for Toran's own (docs/whatsapp-templates.md, before the owner line's). */
export function toranTemplatesDoc(): string {
  return Object.values(TORAN_TEMPLATES).map((t) => [
    `### ${t.name}`,
    '',
    '| | |',
    '|---|---|',
    `| Name | ${t.name} |`,
    '| Category | Utility |',
    '| Language | Hebrew (he) |',
    '| Header | none |',
    `| Footer | ${FOOTER} |`,
    `| Variables (sample) | ${t.example.map((e, i) => `{{${i + 1}}} = ${e}`).join('; ')} |`,
    ...(t.url ? [`| Button | URL, "${t.url.text}", dynamic: ${t.url.base}{{1}} (sample: ${t.url.example}) |`] : []),
    '',
    'The body, exactly:',
    '',
    '```',
    t.body,
    '```',
    '',
    `As the owner reads it: ${filled(t, t.example).replace(/\n+/g, ' / ')}`,
    '',
  ].join('\n')).join('\n');
}

/**
 * What a template is sent by, on the provider the owner line is on: on Meta's Cloud API (channels/lines.ts) its own
 * name, once META_TEMPLATES lists it as approved ("teder_posts_ready,teder_post_reminder,..."); on Twilio its SID.
 */
export function templateRef(env: Record<string, string | undefined>, kind: string, name: string): string | null {
  if (kind === 'meta_line') return String(env.META_TEMPLATES || '').split(/[,\s]+/).includes(name) ? name : null;
  return templateSid(env, name);
}

/** The SID Twilio gave each approved template, from TWILIO_TEMPLATES. */
export function templateSid(env: Record<string, string | undefined>, name: string): string | null {
  for (const pair of String(env.TWILIO_TEMPLATES || '').split(/[,\s]+/)) {
    const [k, v] = pair.split('=');
    if (k === name && /^HX[0-9a-f]{32}$/i.test(String(v || ''))) return v;
  }
  return null;
}

/** A template's text with its variables filled in, as the owner reads it (the record and the tests). */
export const filled = (t: Template, vars: string[]) => `${t.body.replace(/\{\{(\d+)\}\}/g, (_, i) => vars[Number(i) - 1] ?? '')}\n${FOOTER}`;

/** The submission sheet for Meta, written from TEMPLATES (docs/whatsapp-templates.md). */
export function templatesDoc(): string {
  const rows = Object.values(TEMPLATES).map((t) => [
    `### ${t.name}`,
    '',
    '| | |',
    '|---|---|',
    '| Category | Utility |',
    '| Language | Hebrew (he) |',
    `| Body | ${t.body} |`,
    `| Footer | ${FOOTER} |`,
    `| Variables (sample) | ${t.example.map((e, i) => `{{${i + 1}}} = ${e}`).join('; ')} |`,
    `| Quick reply buttons | ${t.buttons?.join(', ') || 'none'} |`,
    '',
    `As the owner reads it: ${filled(t, t.example).replace('\n', ' / ')}`,
    '',
  ].join('\n'));
  return rows.join('\n');
}
