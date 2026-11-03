# WhatsApp templates

What Toran sends from our own number when WhatsApp allows nothing but a template Meta approved: outside the 24 hours
after the person last wrote to us. Two sets:

- **The operator's alert, `operator_alert`**, sent since 2026-11-03: each of Toran's and Teder's alerts, to the
  operator's own number (`TORAN_ALERT_WA`), from `src/ops/alert.ts`. It goes as this template always, inside the 24
  hours too, so it is never refused for the window.
- **The owner line's five**, not sent since 2026-11-02, kept below as the record of what was approved.

This file is written from `src/ops/alert.ts` and `src/owners/templates.ts`. Change the templates there, then run
`node scripts/templates-doc.ts`; a test fails while the two differ.

## The operator's alert

Submitted by hand on 2026-11-03 in WhatsApp Manager (Message templates), on the WhatsApp account that holds our number
(the one `META_DEMO_PHONE_ID` names), exactly as below: category **Utility** (it tells the business's own operator
about their own system, and sells nothing), no header, no footer, no buttons, the body's four lines and the two sample
values. It was **in review** that day. Meta's precheck called it Marketing, so it may be approved as Marketing (it is
still sent by its name, at Meta's Marketing rate) or rejected.

Nothing is set in Toran when Meta approves it: there is no list of approved names for it. Until then each try is
refused (Meta's code 132001, "template name does not exist"), and so is every try after a rejection: each refusal is a
loud line in the log, `[alert] !!! WhatsApp to …<last four digits> FAILED: ...`, no WhatsApp alert is tried for an
hour after it (each alert in that hour is `[alert] !!! ... NOT SENT: Meta refused one at ...`), and the first alert
after the approval goes. A message Meta takes and then cannot deliver (its webhook's failed status) is said the same
way. Changing the template means changing it here (`src/ops/alert.ts`) and in WhatsApp Manager together.

### operator_alert

| | |
|---|---|
| Name | operator_alert |
| Category | Utility |
| Language | Hebrew (he) |
| Header, footer, buttons | none |
| Variables (sample) | {{1}} = תדר: השירות הופעל מחדש אחרי תקלה; {{2}} = הבדיקה של 08:00 לא הצליחה להתחבר לשירות הפרסום. |

The body, four lines, exactly:

```
עדכון על החשבון שלכם ב-OpenFrequency:
{{1}}
{{2}}
את הפרטים המלאים אפשר לראות בלוח הבקרה של החשבון.
```

As the owner reads it: עדכון על החשבון שלכם ב-OpenFrequency: / תדר: השירות הופעל מחדש אחרי תקלה / הבדיקה של 08:00 לא הצליחה להתחבר לשירות הפרסום. / את הפרטים המלאים אפשר לראות בלוח הבקרה של החשבון.

## The owner line (not sent since 2026-11-02)

**Not sent since 2026-11-02.** The owner decided: "managing teder through whatsapp, only through the dashboard".
Every template here is about the owner's Teder account, and nothing of Teder's goes to WhatsApp now
(`src/owners/notify.ts` `TEDER_ON_WHATSAPP`), so none of them is sent, whatever `META_TEMPLATES` or
`TWILIO_TEMPLATES` say. The five were approved at Meta on 2026-10-31; they are kept below as the record of what
was submitted, until they are deleted in WhatsApp Manager.

What the owner line (docs/owner-line.md) sends outside the 24 hours after an owner's last message, when WhatsApp
allows nothing but a template Meta approved. Submit each one as below: in Meta's WhatsApp Manager (Message templates)
when the owner line is on Meta's Cloud API (`META_OWNER_PHONE_ID`), or in Twilio's Content Template Builder when it
is on Twilio. On Meta, once it is approved, add its name to `META_TEMPLATES`, for example
`teder_posts_ready,teder_post_reminder`. On Twilio, put its Content SID (HX...) in `TWILIO_TEMPLATES`, for example
`teder_posts_ready=HX...,teder_post_reminder=HX...`.

Each is a **Utility** template: it is about the owner's own Teder account, which they linked and agreed to hear about,
and it sells nothing. Each one asks for a one-word reply. That reply opens the 24 hours, so the full message (the
covers, the images, the caption) goes out as an ordinary answer after it. The footer carries the disclosure and the
way to stop.

### teder_posts_ready

| | |
|---|---|
| Category | Utility |
| Language | Hebrew (he) |
| Body | יש בתדר {{1}} לאישור שלכם. כתבו "הצג" ואשלח לכאן את מה שמחכה, עם מספרים. |
| Footer | העוזר הדיגיטלי של OpenFrequency · להפסקה כתבו הפסק |
| Variables (sample) | {{1}} = 3 מצגות חדשות |
| Quick reply buttons | הצג |

As the owner reads it: יש בתדר 3 מצגות חדשות לאישור שלכם. כתבו "הצג" ואשלח לכאן את מה שמחכה, עם מספרים. / העוזר הדיגיטלי של OpenFrequency · להפסקה כתבו הפסק

### teder_post_reminder

| | |
|---|---|
| Category | Utility |
| Language | Hebrew (he) |
| Body | הגיע הזמן להעלות את "{{1}}" ל{{2}}. כתבו "שלח" ואשלח לכאן את התמונות ואת הכיתוב. |
| Footer | העוזר הדיגיטלי של OpenFrequency · להפסקה כתבו הפסק |
| Variables (sample) | {{1}} = 5 טעויות בבחירת נעלי ריצה; {{2}} = טיקטוק |
| Quick reply buttons | שלח |

As the owner reads it: הגיע הזמן להעלות את "5 טעויות בבחירת נעלי ריצה" לטיקטוק. כתבו "שלח" ואשלח לכאן את התמונות ואת הכיתוב. / העוזר הדיגיטלי של OpenFrequency · להפסקה כתבו הפסק

### teder_post_unposted

| | |
|---|---|
| Category | Utility |
| Language | Hebrew (he) |
| Body | הפוסט "{{1}}" עוד לא עלה ל{{2}}. כתבו "שלח" ואשלח לכאן את כל התמונות ואת הכיתוב, מוכנים להעלאה. |
| Footer | העוזר הדיגיטלי של OpenFrequency · להפסקה כתבו הפסק |
| Variables (sample) | {{1}} = 5 טעויות בבחירת נעלי ריצה; {{2}} = אינסטגרם |
| Quick reply buttons | שלח |

As the owner reads it: הפוסט "5 טעויות בבחירת נעלי ריצה" עוד לא עלה לאינסטגרם. כתבו "שלח" ואשלח לכאן את כל התמונות ואת הכיתוב, מוכנים להעלאה. / העוזר הדיגיטלי של OpenFrequency · להפסקה כתבו הפסק

### teder_quota_low

| | |
|---|---|
| Category | Utility |
| Language | Hebrew (he) |
| Body | בתדר נשארו לכם החודש {{1}}. בתחילת החודש הבא המונה מתחיל מחדש. |
| Footer | העוזר הדיגיטלי של OpenFrequency · להפסקה כתבו הפסק |
| Variables (sample) | {{1}} = 8 מתוך 40 הצעות למצגות |
| Quick reply buttons | none |

As the owner reads it: בתדר נשארו לכם החודש 8 מתוך 40 הצעות למצגות. בתחילת החודש הבא המונה מתחיל מחדש. / העוזר הדיגיטלי של OpenFrequency · להפסקה כתבו הפסק

### teder_weekly_summary

| | |
|---|---|
| Category | Utility |
| Language | Hebrew (he) |
| Body | הסיכום השבועי מתדר, {{1}}: {{2}}. כתבו "סטטוס" ואשלח את כל הפרטים. |
| Footer | העוזר הדיגיטלי של OpenFrequency · להפסקה כתבו הפסק |
| Variables (sample) | {{1}} = 18.10 עד 24.10; {{2}} = עלו 9 פוסטים, עם 48,210 צפיות |
| Quick reply buttons | סטטוס |

As the owner reads it: הסיכום השבועי מתדר, 18.10 עד 24.10: עלו 9 פוסטים, עם 48,210 צפיות. כתבו "סטטוס" ואשלח את כל הפרטים. / העוזר הדיגיטלי של OpenFrequency · להפסקה כתבו הפסק
