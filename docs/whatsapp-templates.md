# WhatsApp templates

What Toran sends from our own number when WhatsApp allows nothing but a template Meta approved: outside the 24 hours
after the person last wrote to us. Four sets:

- **The operator's alert, `operator_alert`**, sent since 2026-11-03: each of Toran's and Teder's alerts, to the
  operator's own number (`TORAN_ALERT_WA`), from `src/ops/alert.ts`. It goes as this template always, inside the 24
  hours too, so it is never refused for the window.
- **The owner line's five**, not sent since 2026-11-02, kept below as the record of what was approved.
- **The payment reminder, `payment_reminder`**: accounts' reminders to pay for the new month, to a workspace owner's
  number accounts verified and to the number a workspace last paid from, from `src/billing/remind.ts`. Not created in
  WhatsApp Manager yet: see its section.
- **The pitches to leads, `toran_pitch`, `toran_pitch_reminder`, `teder_pitch`, `teder_pitch_reminder`**, since
  2026-11-08: the first message to a lead and its one reminder, from `src/ops/outreach.ts`. Not created yet: see
  their section.

This file is written from `src/ops/alert.ts`, `src/billing/remind.ts`, `src/ops/outreach.ts` and
`src/owners/templates.ts`. Change the
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

## Pitches to leads

The owner, 2026-11-08: "if i press the send button to a demo suggestion, i want it to go to whatsapp, so toran should
send it", and on the risk: "i dont think people will report that, especially with something legit and an option to
be removed from the advertising list. build that". Until then the first message to a lead and its one reminder went
from the operator's own phone. Now the "send now" button (the operator's dashboard, Toran's lead and follow-up pages,
Teder's /leads through `POST /internal/outreach/send`) sends them from our number as these four **Marketing**
templates, from `src/ops/outreach.ts`. Meta's rules they follow (developers.facebook.com/docs/whatsapp/
business-management-api/message-templates, and its components page): the body does not start or end with a variable;
the URL button takes one variable, at the end of its address (the page's slug after `/s/`); quick reply buttons and
the others are two groups, so the URL button is first and the quick reply after it (`index` 1 when sending).

**Why the guardrails** (all in `src/ops/outreach.ts`). Meta asks for a person's opt-in before a business writes to them
first (developers.facebook.com/docs/whatsapp/overview/getting-opt-in), and a lead's number comes from its own site.
Meta approves a template's wording only: after that, a template people block or report falls in quality and is paused
for 3 hours, then 6, then disabled, and the number's own rating falls with it. Our number is also the demo, support,
the alerts and the payment reminders, so: the way out is on the message ("הסירו אותי", and a
"לא" or "הסר" reply), and a number that uses it gets no pitch of either product again (`outreach_stops`); at most
`TORAN_OUTREACH_DAILY` (10) a day, both products together; never at night, on Shabbat or a holiday; and before each
send the number's quality and the template's are read from Meta (ten minutes at a time): anything but GREEN, a template
not APPROVED, or Meta pausing one, stops the pitches until it is green again, with one alert a day. The law's line is
the one it always was (section 30A, `src/outreach.ts`): one approach that says who writes and how to stop, and one
reminder.

**To do in WhatsApp Manager**, or with the commands below, on our WhatsApp account (2477118039396394, `META_WABA_ID`):
create the four, then set `META_WABA_ID` in Toran's `.env` so the template's own status and score are read too.
Nothing else is set when Meta approves them: until then each send is refused (code 132001) and said on the page.

**Submitted 2026-11-08** through the API from the server, the four bodies below exactly, with `META_SYSTEM_TOKEN` and
`META_WABA_ID` from Toran's `.env` (set that day): toran_pitch 1444525310439161, toran_pitch_reminder
1472889768241947, teder_pitch 1713644520160356, teder_pitch_reminder 1823784592265147, each answered PENDING, MARKETING.

### toran_pitch

| | |
|---|---|
| Name | toran_pitch |
| Category | Marketing |
| Language | Hebrew (he) |
| Header, footer | none |
| Buttons | a URL button, "לנסות את תורן", to https://toran.openfrequency.co.il/s/{{1}} (sample nurit-ceramics); then a quick reply, "הסירו אותי" |
| Variables (sample) | {{1}} = לכלי חרס של נורית |

The body, exactly:

```
היי, כאן OpenFrequency. בנינו {{1}} תורן, שעונה ללקוחות שלכם בוואטסאפ על מחירים ומלאי לפי מה שכתוב באתר שלכם. אפשר לנסות אותו עכשיו מהטלפון, בכפתור כאן למטה.

אם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. לא רלוונטי? לוחצים על "הסירו אותי" ולא נכתוב שוב.
```

As the store reads it: היי, כאן OpenFrequency. בנינו לכלי חרס של נורית תורן, שעונה ללקוחות שלכם בוואטסאפ על מחירים ומלאי לפי מה שכתוב באתר שלכם. אפשר לנסות אותו עכשיו מהטלפון, בכפתור כאן למטה. / אם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. לא רלוונטי? לוחצים על "הסירו אותי" ולא נכתוב שוב. [לנסות את תורן] [הסירו אותי]

Submitted with (the token is META_SYSTEM_TOKEN, the account is our WhatsApp account, META_WABA_ID):

```sh
curl -sS -X POST "https://graph.facebook.com/v23.0/$META_WABA_ID/message_templates" \
  -H "Authorization: Bearer $META_SYSTEM_TOKEN" -H "Content-Type: application/json" \
  --data '{"name":"toran_pitch","language":"he","category":"MARKETING","components":[{"type":"BODY","text":"היי, כאן OpenFrequency. בנינו {{1}} תורן, שעונה ללקוחות שלכם בוואטסאפ על מחירים ומלאי לפי מה שכתוב באתר שלכם. אפשר לנסות אותו עכשיו מהטלפון, בכפתור כאן למטה.\n\nאם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. לא רלוונטי? לוחצים על \"הסירו אותי\" ולא נכתוב שוב.","example":{"body_text":[["לכלי חרס של נורית"]]}},{"type":"BUTTONS","buttons":[{"type":"URL","text":"לנסות את תורן","url":"https://toran.openfrequency.co.il/s/{{1}}","example":["https://toran.openfrequency.co.il/s/nurit-ceramics"]},{"type":"QUICK_REPLY","text":"הסירו אותי"}]}]}'
```

### toran_pitch_reminder

| | |
|---|---|
| Name | toran_pitch_reminder |
| Category | Marketing |
| Language | Hebrew (he) |
| Header, footer | none |
| Buttons | a URL button, "לנסות את תורן", to https://toran.openfrequency.co.il/s/{{1}} (sample nurit-ceramics); then a quick reply, "הסירו אותי" |
| Variables (sample) | {{1}} = לכלי חרס של נורית |

The body, exactly:

```
היי, יצא לכם להציץ בתורן שהכנו {{1}}? הוא מחכה לכם בכפתור כאן למטה.

זו ההודעה האחרונה שלנו בנושא. לא רלוונטי? לוחצים על "הסירו אותי".
```

As the store reads it: היי, יצא לכם להציץ בתורן שהכנו לכלי חרס של נורית? הוא מחכה לכם בכפתור כאן למטה. / זו ההודעה האחרונה שלנו בנושא. לא רלוונטי? לוחצים על "הסירו אותי". [לנסות את תורן] [הסירו אותי]

Submitted with (the token is META_SYSTEM_TOKEN, the account is our WhatsApp account, META_WABA_ID):

```sh
curl -sS -X POST "https://graph.facebook.com/v23.0/$META_WABA_ID/message_templates" \
  -H "Authorization: Bearer $META_SYSTEM_TOKEN" -H "Content-Type: application/json" \
  --data '{"name":"toran_pitch_reminder","language":"he","category":"MARKETING","components":[{"type":"BODY","text":"היי, יצא לכם להציץ בתורן שהכנו {{1}}? הוא מחכה לכם בכפתור כאן למטה.\n\nזו ההודעה האחרונה שלנו בנושא. לא רלוונטי? לוחצים על \"הסירו אותי\".","example":{"body_text":[["לכלי חרס של נורית"]]}},{"type":"BUTTONS","buttons":[{"type":"URL","text":"לנסות את תורן","url":"https://toran.openfrequency.co.il/s/{{1}}","example":["https://toran.openfrequency.co.il/s/nurit-ceramics"]},{"type":"QUICK_REPLY","text":"הסירו אותי"}]}]}'
```

### teder_pitch

| | |
|---|---|
| Name | teder_pitch |
| Category | Marketing |
| Language | Hebrew (he) |
| Header, footer | none |
| Buttons | a URL button, "לראות את המצגת", to https://teder.openfrequency.co.il/s/{{1}} (sample nurit-ceramics-a1b2c3); then a quick reply, "הסירו אותי" |
| Variables (sample) | {{1}} = לכלי חרס של נורית |

The body, exactly:

```
היי, כאן OpenFrequency. בנינו את תדר, שמכין לחנויות אונליין מצגות בעברית לטיקטוק ולאינסטגרם. הוא קורא את האתר של החנות, וכותב ומעצב מצגות על נושאים מהתחום שלה. כל מצגת מחכה לאישור שלכם לפני שהיא עולה.

הכנו {{1}} מצגת אחת לדוגמה, כדי שתראו איך זה ייראה אצלכם. היא בכפתור כאן למטה.

אם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. לא רלוונטי? לוחצים על "הסירו אותי" ולא נכתוב שוב.
```

As the store reads it: היי, כאן OpenFrequency. בנינו את תדר, שמכין לחנויות אונליין מצגות בעברית לטיקטוק ולאינסטגרם. הוא קורא את האתר של החנות, וכותב ומעצב מצגות על נושאים מהתחום שלה. כל מצגת מחכה לאישור שלכם לפני שהיא עולה. / הכנו לכלי חרס של נורית מצגת אחת לדוגמה, כדי שתראו איך זה ייראה אצלכם. היא בכפתור כאן למטה. / אם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. לא רלוונטי? לוחצים על "הסירו אותי" ולא נכתוב שוב. [לראות את המצגת] [הסירו אותי]

Submitted with (the token is META_SYSTEM_TOKEN, the account is our WhatsApp account, META_WABA_ID):

```sh
curl -sS -X POST "https://graph.facebook.com/v23.0/$META_WABA_ID/message_templates" \
  -H "Authorization: Bearer $META_SYSTEM_TOKEN" -H "Content-Type: application/json" \
  --data '{"name":"teder_pitch","language":"he","category":"MARKETING","components":[{"type":"BODY","text":"היי, כאן OpenFrequency. בנינו את תדר, שמכין לחנויות אונליין מצגות בעברית לטיקטוק ולאינסטגרם. הוא קורא את האתר של החנות, וכותב ומעצב מצגות על נושאים מהתחום שלה. כל מצגת מחכה לאישור שלכם לפני שהיא עולה.\n\nהכנו {{1}} מצגת אחת לדוגמה, כדי שתראו איך זה ייראה אצלכם. היא בכפתור כאן למטה.\n\nאם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. לא רלוונטי? לוחצים על \"הסירו אותי\" ולא נכתוב שוב.","example":{"body_text":[["לכלי חרס של נורית"]]}},{"type":"BUTTONS","buttons":[{"type":"URL","text":"לראות את המצגת","url":"https://teder.openfrequency.co.il/s/{{1}}","example":["https://teder.openfrequency.co.il/s/nurit-ceramics-a1b2c3"]},{"type":"QUICK_REPLY","text":"הסירו אותי"}]}]}'
```

### teder_pitch_reminder

| | |
|---|---|
| Name | teder_pitch_reminder |
| Category | Marketing |
| Language | Hebrew (he) |
| Header, footer | none |
| Buttons | a URL button, "לראות את המצגת", to https://teder.openfrequency.co.il/s/{{1}} (sample nurit-ceramics-a1b2c3); then a quick reply, "הסירו אותי" |
| Variables (sample) | {{1}} = לכלי חרס של נורית |

The body, exactly:

```
היי, יצא לכם להציץ במצגת שהכנו {{1}}? היא מחכה לכם בכפתור כאן למטה.

זו ההודעה האחרונה שלנו בנושא. לא רלוונטי? לוחצים על "הסירו אותי".
```

As the store reads it: היי, יצא לכם להציץ במצגת שהכנו לכלי חרס של נורית? היא מחכה לכם בכפתור כאן למטה. / זו ההודעה האחרונה שלנו בנושא. לא רלוונטי? לוחצים על "הסירו אותי". [לראות את המצגת] [הסירו אותי]

Submitted with (the token is META_SYSTEM_TOKEN, the account is our WhatsApp account, META_WABA_ID):

```sh
curl -sS -X POST "https://graph.facebook.com/v23.0/$META_WABA_ID/message_templates" \
  -H "Authorization: Bearer $META_SYSTEM_TOKEN" -H "Content-Type: application/json" \
  --data '{"name":"teder_pitch_reminder","language":"he","category":"MARKETING","components":[{"type":"BODY","text":"היי, יצא לכם להציץ במצגת שהכנו {{1}}? היא מחכה לכם בכפתור כאן למטה.\n\nזו ההודעה האחרונה שלנו בנושא. לא רלוונטי? לוחצים על \"הסירו אותי\".","example":{"body_text":[["לכלי חרס של נורית"]]}},{"type":"BUTTONS","buttons":[{"type":"URL","text":"לראות את המצגת","url":"https://teder.openfrequency.co.il/s/{{1}}","example":["https://teder.openfrequency.co.il/s/nurit-ceramics-a1b2c3"]},{"type":"QUICK_REPLY","text":"הסירו אותי"}]}]}'
```

### openfrequency_pitch

| | |
|---|---|
| Name | openfrequency_pitch |
| Category | Marketing |
| Language | Hebrew (he) |
| Header, footer | none |
| Buttons | two URL buttons: "לנסות את תורן", to https://toran.openfrequency.co.il/s/{{1}} (sample nurit-ceramics), and "לראות את המצגת", to https://teder.openfrequency.co.il/s/{{1}} (sample nurit-ceramics-a1b2c3); then a quick reply, "הסירו אותי" |
| Variables (sample) | {{1}} = לכלי חרס של נורית |

The body, exactly:

```
היי, כאן OpenFrequency. הכנו {{1}} שני דברים לנסות: תורן, שעונה ללקוחות שלכם בוואטסאפ על מחירים ומלאי לפי מה שכתוב באתר שלכם, ומצגת לדוגמה של תדר, שכותב ומעצב לחנויות מצגות בעברית לטיקטוק ולאינסטגרם. שניהם בכפתורים כאן למטה.

אם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. לא רלוונטי? לוחצים על "הסירו אותי" ולא נכתוב שוב.
```

As the store reads it: היי, כאן OpenFrequency. הכנו לכלי חרס של נורית שני דברים לנסות: תורן, שעונה ללקוחות שלכם בוואטסאפ על מחירים ומלאי לפי מה שכתוב באתר שלכם, ומצגת לדוגמה של תדר, שכותב ומעצב לחנויות מצגות בעברית לטיקטוק ולאינסטגרם. שניהם בכפתורים כאן למטה. / אם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. לא רלוונטי? לוחצים על "הסירו אותי" ולא נכתוב שוב. [לנסות את תורן] [לראות את המצגת] [הסירו אותי]

Submitted with (the token is META_SYSTEM_TOKEN, the account is our WhatsApp account, META_WABA_ID):

```sh
curl -sS -X POST "https://graph.facebook.com/v23.0/$META_WABA_ID/message_templates" \
  -H "Authorization: Bearer $META_SYSTEM_TOKEN" -H "Content-Type: application/json" \
  --data '{"name":"openfrequency_pitch","language":"he","category":"MARKETING","components":[{"type":"BODY","text":"היי, כאן OpenFrequency. הכנו {{1}} שני דברים לנסות: תורן, שעונה ללקוחות שלכם בוואטסאפ על מחירים ומלאי לפי מה שכתוב באתר שלכם, ומצגת לדוגמה של תדר, שכותב ומעצב לחנויות מצגות בעברית לטיקטוק ולאינסטגרם. שניהם בכפתורים כאן למטה.\n\nאם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. לא רלוונטי? לוחצים על \"הסירו אותי\" ולא נכתוב שוב.","example":{"body_text":[["לכלי חרס של נורית"]]}},{"type":"BUTTONS","buttons":[{"type":"URL","text":"לנסות את תורן","url":"https://toran.openfrequency.co.il/s/{{1}}","example":["https://toran.openfrequency.co.il/s/nurit-ceramics"]},{"type":"URL","text":"לראות את המצגת","url":"https://teder.openfrequency.co.il/s/{{1}}","example":["https://teder.openfrequency.co.il/s/nurit-ceramics-a1b2c3"]},{"type":"QUICK_REPLY","text":"הסירו אותי"}]}]}'
```

### openfrequency_pitch_reminder

| | |
|---|---|
| Name | openfrequency_pitch_reminder |
| Category | Marketing |
| Language | Hebrew (he) |
| Header, footer | none |
| Buttons | two URL buttons: "לנסות את תורן", to https://toran.openfrequency.co.il/s/{{1}} (sample nurit-ceramics), and "לראות את המצגת", to https://teder.openfrequency.co.il/s/{{1}} (sample nurit-ceramics-a1b2c3); then a quick reply, "הסירו אותי" |
| Variables (sample) | {{1}} = לכלי חרס של נורית |

The body, exactly:

```
היי, יצא לכם להציץ במה שהכנו {{1}}? תורן והמצגת של תדר מחכים לכם בכפתורים כאן למטה.

זו ההודעה האחרונה שלנו בנושא. לא רלוונטי? לוחצים על "הסירו אותי".
```

As the store reads it: היי, יצא לכם להציץ במה שהכנו לכלי חרס של נורית? תורן והמצגת של תדר מחכים לכם בכפתורים כאן למטה. / זו ההודעה האחרונה שלנו בנושא. לא רלוונטי? לוחצים על "הסירו אותי". [לנסות את תורן] [לראות את המצגת] [הסירו אותי]

Submitted with (the token is META_SYSTEM_TOKEN, the account is our WhatsApp account, META_WABA_ID):

```sh
curl -sS -X POST "https://graph.facebook.com/v23.0/$META_WABA_ID/message_templates" \
  -H "Authorization: Bearer $META_SYSTEM_TOKEN" -H "Content-Type: application/json" \
  --data '{"name":"openfrequency_pitch_reminder","language":"he","category":"MARKETING","components":[{"type":"BODY","text":"היי, יצא לכם להציץ במה שהכנו {{1}}? תורן והמצגת של תדר מחכים לכם בכפתורים כאן למטה.\n\nזו ההודעה האחרונה שלנו בנושא. לא רלוונטי? לוחצים על \"הסירו אותי\".","example":{"body_text":[["לכלי חרס של נורית"]]}},{"type":"BUTTONS","buttons":[{"type":"URL","text":"לנסות את תורן","url":"https://toran.openfrequency.co.il/s/{{1}}","example":["https://toran.openfrequency.co.il/s/nurit-ceramics"]},{"type":"URL","text":"לראות את המצגת","url":"https://teder.openfrequency.co.il/s/{{1}}","example":["https://teder.openfrequency.co.il/s/nurit-ceramics-a1b2c3"]},{"type":"QUICK_REPLY","text":"הסירו אותי"}]}]}'
```

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
