// The WhatsApp templates the owner line sends outside the 24 hours after the owner's last message, when Meta allows
// nothing else. All of them are utility templates in Hebrew (he), each about the owner's own Teder account, and each
// asks for a one-word reply that opens the window, so the full message (the covers, the images, the caption) goes out
// as an ordinary answer after it.
//
// The text is what is submitted to Meta (docs/whatsapp-templates.md, made from this file). Twilio keeps an approved
// template as a Content SID (HX...); TWILIO_TEMPLATES maps each name to its SID ("teder_posts_ready=HX...,..."). A
// template with no SID set is not sent, and the attempt is recorded as skipped ('no_template').
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
    example: ['8 מתוך 40 הצעות לפוסטים'],
  },
  teder_weekly_summary: {
    name: 'teder_weekly_summary',
    body: 'הסיכום השבועי מתדר, {{1}}: נוצרו {{2}} פוסטים, אישרתם {{3}} ועלו {{4}}. כתבו "סטטוס" ואשלח את כל הפרטים.',
    example: ['18.10 עד 24.10', '9', '7', '6'],
    buttons: ['סטטוס'],
  },
};

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
