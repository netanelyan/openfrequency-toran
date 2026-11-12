// Writes docs/whatsapp-templates.md, the submission sheet for Meta, from src/ops/alert.ts (the operator's alert),
// src/billing/remind.ts (the payment reminder), src/ops/outreach.ts (the pitches to leads) and src/owners/templates.ts
// (the owner line's).
import { writeFileSync } from 'node:fs';
import { alertTemplateDoc } from '../src/ops/alert.ts';
import { REMIND_HOLD_MINUTES, REMIND_WEEK_DAYS, REMIND_WEEK_MAX, reminderTemplateDoc } from '../src/billing/remind.ts';
import { templatesDoc, toranTemplatesDoc } from '../src/owners/templates.ts';
import { PUSHES_PER_DAY } from '../src/owners/notify.ts';
import { DAILY_DEFAULT, OUTREACH_TEMPLATES, outreachTemplateDoc } from '../src/ops/outreach.ts';
const head = `# WhatsApp templates

What Toran sends from our own number when WhatsApp allows nothing but a template Meta approved: outside the 24 hours
after the person last wrote to us. Four sets:

- **The operator's alert, \`operator_alert\`**, sent since 2026-11-03: each of Toran's and Teder's alerts, to the
  operator's own number (\`TORAN_ALERT_WA\`), from \`src/ops/alert.ts\`. It goes as this template always, inside the 24
  hours too, so it is never refused for the window.
- **The owner line's five**, not sent since 2026-11-02, kept below as the record of what was approved.
- **The payment reminder, \`payment_reminder\`**: accounts' reminders to pay for the new month, to a workspace owner's
  number accounts verified and to the number a workspace last paid from, from \`src/billing/remind.ts\`. Submitted, in
  review at Meta since 2026-11-04 (STATUS.md): see its section.
- **The pitches to leads, \`toran_pitch_2\`, \`toran_pitch_reminder_2\`, \`teder_pitch_2\`, \`teder_pitch_reminder_2\`**, and
  the combined \`openfrequency_pitch_2\` two: the first message to a lead and its one reminder, from
  \`src/ops/outreach.ts\`. Written 2026-11-12 with each demo's address in the words as well as on its button, and Toran
  and Teder said as the website says them (the owner: "urls have to be present, in case buttons dont show. also, toran is
  much more than a bot that answers about prices and quantity"). Each replaces the one without the \`_2\`, approved on
  2026-11-08, which goes until Meta approves the new one (\`liveTemplate\`, asked by name with META_WABA_ID).
  toran_launch, Toran's opening to its waitlist, is not submitted yet: see their section.
- **A customer waits, \`toran_customer_waiting\`**: to a store owner's own number, when a customer of their store waits
  for their answer, from \`src/owners/notify.ts\`. **Not submitted yet**: written 2026-11-12 for the owner to submit; see
  its section.

This file is written from \`src/ops/alert.ts\`, \`src/billing/remind.ts\`, \`src/ops/outreach.ts\` and
\`src/owners/templates.ts\`. Change the
templates there, then run \`node scripts/templates-doc.ts\`; a test fails while the two differ.

## The operator's alert

Submitted by hand on 2026-11-03 in WhatsApp Manager (Message templates), on the WhatsApp account that holds our number
(the one \`META_DEMO_PHONE_ID\` names), exactly as below: category **Utility** (it tells the business's own operator
about their own system, and sells nothing), no header, no footer, no buttons, the body's four lines and the two sample
values. Meta approved it, filing it as Marketing (STATUS.md, 2026-11-04): it is sent by its name, at Meta's Marketing
rate.

Nothing is set in Toran when Meta approves it: there is no list of approved names for it. Until then each try is
refused (Meta's code 132001, "template name does not exist"), and so is every try after a rejection: each refusal is a
loud line in the log, \`[alert] !!! WhatsApp to …<last four digits> FAILED: ...\`, no WhatsApp alert is tried for an
hour after it (each alert in that hour is \`[alert] !!! ... NOT SENT: Meta refused one at ...\`), and the first alert
after the approval goes. A message Meta takes and then cannot deliver (its webhook's failed status) is said the same
way. Changing the template means changing it here (\`src/ops/alert.ts\`) and in WhatsApp Manager together.

${alertTemplateDoc()}
## The payment reminder

The owner, 2026-11-03: "add a reminder to pay for the new month, whatsapp, email and dashboard. A user has 72 hours to
pay for a new month once their subscription has ended". openfrequency-accounts' daily run decides who gets one and when
(its docs/setup.md, the daily job): the last paid day, the first day after it and the last day of the grace, to each
number its owners verified and to the number the workspace last paid from (its latest receipt marked paid), once
each, beside the email. It hands each one to Toran on this machine
(\`POST /internal/pay/remind\`, accounts' docs/contracts/pay-remind.json), and Toran sends this template from our
number.

**To do in WhatsApp Manager** (Message templates, Create template, on the WhatsApp account that holds our number, the
one \`META_DEMO_PHONE_ID\` names): category **Utility** (it is about the customer's own subscription and sells
nothing), name \`payment_reminder\`, language Hebrew, no header, no footer, the body below exactly, its four sample
values, and one button of the type **Quick reply** with the text below. Nothing is set in Toran when Meta approves it,
as with \`operator_alert\`: until then each try is refused (Meta's code 132001), one loud line,
\`[remind] !!! WhatsApp to …<last four digits> (workspace <id>, <kind>) FAILED: ...\`, and no payment reminder is tried
for ${REMIND_HOLD_MINUTES} minutes after it; the customer still gets the email. Should Meta file it as Marketing, it is
still sent by its name, at Meta's Marketing rate.

The button's payload is the workspace's payment code (\`PAY-XXXXXX\`), set on each message and never shown. Pressed, it
comes back to our number with the code, and Toran answers with the amount and the transfer's details, then takes the
transfer's picture as the receipt, as when the customer presses "לתשלום בוואטסאפ" in their account. A phone gets at
most ${REMIND_WEEK_MAX} reminders in ${REMIND_WEEK_DAYS} days, and the same one never twice. A number that writes "הפסק" to us
after a reminder gets none until it writes "התחל" (\`pay_remind_stops\`); the emails go on.

${reminderTemplateDoc()}
## Pitches to leads

The owner, 2026-11-08: "if i press the send button to a demo suggestion, i want it to go to whatsapp, so toran should
send it", and on the risk: "i dont think people will report that, especially with something legit and an option to
be removed from the advertising list. build that". Until then the first message to a lead and its one reminder went
from the operator's own phone. Now the "send now" button (the operator's dashboard, Toran's lead and follow-up pages,
Teder's /leads through \`POST /internal/outreach/send\`) sends them from our number as these four **Marketing**
templates, from \`src/ops/outreach.ts\`. Meta's rules they follow (developers.facebook.com/docs/whatsapp/
business-management-api/message-templates, and its components page): the body does not start or end with a variable;
the URL button takes one variable, at the end of its address (the page's slug after \`/s/\`); quick reply buttons and
the others are two groups, so the URL button is first and the quick reply after it (\`index\` 1 when sending).

**Why the guardrails** (all in \`src/ops/outreach.ts\`). Meta asks for a person's opt-in before a business writes to them
first (developers.facebook.com/docs/whatsapp/overview/getting-opt-in), and a lead's number comes from its own site.
Meta approves a template's wording only: after that, a template people block or report falls in quality and is paused
for 3 hours, then 6, then disabled, and the number's own rating falls with it. Our number is also the demo, support,
the alerts and the payment reminders, so: the way out is on the message ("${OUTREACH_TEMPLATES.toran_first.stop}", and a
"לא" or "הסר" reply), and a number that uses it gets no pitch of either product again (\`outreach_stops\`); at most
\`TORAN_OUTREACH_DAILY\` (${DAILY_DEFAULT}) a day, both products together; never at night, on Shabbat or a holiday; and before each
send the number's quality and the template's are read from Meta (ten minutes at a time): anything but GREEN, a template
not APPROVED, or Meta pausing one, stops the pitches until it is green again, with one alert a day. The law's line is
the one it always was (section 30A, \`src/outreach.ts\`): one approach that says who writes and how to stop, and one
reminder.

**To do in WhatsApp Manager**, or with the commands below, on our WhatsApp account (2477118039396394, \`META_WABA_ID\`):
create the four, then set \`META_WABA_ID\` in Toran's \`.env\` so the template's own status and score are read too.
Nothing else is set when Meta approves them: until then each send is refused (code 132001) and said on the page.

**Submitted 2026-11-08** through the API from the server, the four bodies below exactly, with \`META_SYSTEM_TOKEN\` and
\`META_WABA_ID\` from Toran's \`.env\` (set that day): toran_pitch 1444525310439161, toran_pitch_reminder
1472889768241947, teder_pitch 1713644520160356, teder_pitch_reminder 1823784592265147, each answered PENDING, MARKETING;
all four were APPROVED the same day. The combined two, the same way later that day: openfrequency_pitch
29610503958636110 and openfrequency_pitch_reminder 1601974991130160, PENDING, MARKETING (Meta took the two URL buttons
with the quick reply after them).

${outreachTemplateDoc()}
## A customer waits (to the store's owner)

The audit of 2026-11-12 (P1-6): a store owner heard of a customer waiting for them by email only, at most three of
that kind a day (accounts' limit), and by a browser notification where they turned one on. Now the waiting digest
(\`src/owners/waiting.ts\`) also writes to each of the workspace's WhatsApp numbers that accounts verified and that agreed
to hear from Toran (the owner line's consent: "הפסק" stops it, "התחל" starts it again), under the owner line's rules
(\`src/owners/notify.ts\`): at most ${PUSHES_PER_DAY} messages a number in 24 hours, never between 22:00 and 07:00 (the digest waits
for the morning), and each start of a wait once. Inside the 24 hours after the owner last wrote to our number it goes
as a plain message. After them WhatsApp takes only an approved template, this one.

**To do in WhatsApp Manager** (Message templates, Create template, on the WhatsApp account that holds our number, the
one the owner line sends from): category **Utility** (it is about the owner's own store, which they connected, and
sells nothing), name \`toran_customer_waiting\`, language Hebrew, no header, the footer below, the body below exactly with
its two sample values, and one button of the type **Visit website**, dynamic, with the text and address below. Once
Meta approves it, add its name to \`META_TEMPLATES\` in Toran's \`.env\` (beside any already there) and restart Toran;
until then nothing is tried outside the 24 hours, and the owner still gets the email and the notification.

${toranTemplatesDoc()}
## The owner line (not sent since 2026-11-02)

**Not sent since 2026-11-02.** The owner decided: "managing teder through whatsapp, only through the dashboard".
Every template here is about the owner's Teder account, and nothing of Teder's goes to WhatsApp now
(\`src/owners/notify.ts\` \`TEDER_ON_WHATSAPP\`), so none of them is sent, whatever \`META_TEMPLATES\` or
\`TWILIO_TEMPLATES\` say. The five were approved at Meta on 2026-10-31; they are kept below as the record of what
was submitted, until they are deleted in WhatsApp Manager.

What the owner line (docs/owner-line.md) sends outside the 24 hours after an owner's last message, when WhatsApp
allows nothing but a template Meta approved. Submit each one as below: in Meta's WhatsApp Manager (Message templates)
when the owner line is on Meta's Cloud API (\`META_OWNER_PHONE_ID\`), or in Twilio's Content Template Builder when it
is on Twilio. On Meta, once it is approved, add its name to \`META_TEMPLATES\`, for example
\`teder_posts_ready,teder_post_reminder\`. On Twilio, put its Content SID (HX...) in \`TWILIO_TEMPLATES\`, for example
\`teder_posts_ready=HX...,teder_post_reminder=HX...\`.

Each is a **Utility** template: it is about the owner's own Teder account, which they linked and agreed to hear about,
and it sells nothing. Each one asks for a one-word reply. That reply opens the 24 hours, so the full message (the
covers, the images, the caption) goes out as an ordinary answer after it. The footer carries the disclosure and the
way to stop.

`;
writeFileSync('docs/whatsapp-templates.md', `${head}${templatesDoc()}`);
