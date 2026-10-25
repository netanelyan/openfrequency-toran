# WhatsApp templates for the owner line

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

This file is written from `src/owners/templates.ts`. Change the templates there, then run
`node scripts/templates-doc.ts`; a test fails while the two differ.

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
