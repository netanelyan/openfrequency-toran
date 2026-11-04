# WhatsApp templates

What Toran sends from our own number when WhatsApp allows nothing but a template Meta approved: outside the 24 hours
after the person last wrote to us. Three sets:

- **The operator's alert, `operator_alert`**, sent since 2026-11-03: each of Toran's and Teder's alerts, to the
  operator's own number (`TORAN_ALERT_WA`), from `src/ops/alert.ts`. It goes as this template always, inside the 24
  hours too, so it is never refused for the window.
- **The owner line's five**, not sent since 2026-11-02, kept below as the record of what was approved.
- **The payment reminder, `payment_reminder`**: accounts' reminders to pay for the new month, to a workspace owner's
  number accounts verified and to the number a workspace last paid from, from `src/billing/remind.ts`. Not created in
  WhatsApp Manager yet: see its section.

This file is written from `src/ops/alert.ts`, `src/billing/remind.ts` and `src/owners/templates.ts`. Change the
templates there, then run `node scripts/templates-doc.ts`; a test fails while the two differ.

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

## The payment reminder

The owner, 2026-11-03: "add a reminder to pay for the new month, whatsapp, email and dashboard. A user has 72 hours to
pay for a new month once their subscription has ended". openfrequency-accounts' daily run decides who gets one and when
(its docs/setup.md, the daily job): the last paid day, the first day after it and the last day of the grace, to each
number its owners verified and to the number the workspace last paid from (its latest receipt marked paid), once
each, beside the email. It hands each one to Toran on this machine
(`POST /internal/pay/remind`, accounts' docs/contracts/pay-remind.json), and Toran sends this template from our
number.

**To do in WhatsApp Manager** (Message templates, Create template, on the WhatsApp account that holds our number, the
one `META_DEMO_PHONE_ID` names): category **Utility** (it is about the customer's own subscription and sells
nothing), name `payment_reminder`, language Hebrew, no header, no footer, the body below exactly, its four sample
values, and one button of the type **Quick reply** with the text below. Nothing is set in Toran when Meta approves it,
as with `operator_alert`: until then each try is refused (Meta's code 132001), one loud line,
`[remind] !!! WhatsApp to …<last four digits> (workspace <id>, <kind>) FAILED: ...`, and no payment reminder is tried
for 60 minutes after it; the customer still gets the email. Should Meta file it as Marketing, it is
still sent by its name, at Meta's Marketing rate.

The button's payload is the workspace's payment code (`PAY-XXXXXX`), set on each message and never shown. Pressed, it
comes back to our number with the code, and Toran answers with the amount and the transfer's details, then takes the
transfer's picture as the receipt, as when the customer presses "לתשלום בוואטסאפ" in their account. A phone gets at
most 3 reminders in 7 days, and the same one never twice. A number that writes "הפסק" to us
after a reminder gets none until it writes "התחל" (`pay_remind_stops`); the emails go on.

### payment_reminder

| | |
|---|---|
| Name | payment_reminder |
| Category | Utility |
| Language | Hebrew (he) |
| Header, footer | none |
| Buttons | one quick reply: לתשלום |
| Variables (sample) | {{1}} = תדר; {{2}} = מאפיית השכונה; {{3}} = 21.11.2026; {{4}} = יום שלישי, 24.11.2026 |

The body, two paragraphs with an empty line between them, exactly:

```
המנוי ל{{1}} בחשבון של {{2}} ב-OpenFrequency שולם עד {{3}}. התשלום על החודש הבא צריך להגיע אלינו עד סוף {{4}}. אם הוא לא יגיע עד אז, השירות ייעצר עד שנקבל אותו.

כדי לשלם, לוחצים על הכפתור ונשלח לכם כאן את הסכום ואת פרטי ההעברה. כבר שילמתם? אפשר להתעלם מההודעה הזו.
```

As the customer reads it: המנוי לתדר בחשבון של מאפיית השכונה ב-OpenFrequency שולם עד 21.11.2026. התשלום על החודש הבא צריך להגיע אלינו עד סוף יום שלישי, 24.11.2026. אם הוא לא יגיע עד אז, השירות ייעצר עד שנקבל אותו. / כדי לשלם, לוחצים על הכפתור ונשלח לכם כאן את הסכום ואת פרטי ההעברה. כבר שילמתם? אפשר להתעלם מההודעה הזו. [לתשלום]

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
