// Writes docs/whatsapp-templates.md, the submission sheet for Meta, from src/ops/alert.ts (the operator's alert),
// src/billing/remind.ts (the payment reminder) and src/owners/templates.ts (the owner line's).
import { writeFileSync } from 'node:fs';
import { alertTemplateDoc } from '../src/ops/alert.ts';
import { REMIND_HOLD_MINUTES, REMIND_WEEK_DAYS, REMIND_WEEK_MAX, reminderTemplateDoc } from '../src/billing/remind.ts';
import { templatesDoc } from '../src/owners/templates.ts';
const head = `# WhatsApp templates

What Toran sends from our own number when WhatsApp allows nothing but a template Meta approved: outside the 24 hours
after the person last wrote to us. Three sets:

- **The operator's alert, \`operator_alert\`**, sent since 2026-11-03: each of Toran's and Teder's alerts, to the
  operator's own number (\`TORAN_ALERT_WA\`), from \`src/ops/alert.ts\`. It goes as this template always, inside the 24
  hours too, so it is never refused for the window.
- **The payment reminder, \`payment_reminder\`**: accounts' reminders to pay for the new month, to a workspace owner's
  number accounts verified, from \`src/billing/remind.ts\`. Not created in WhatsApp Manager yet: see its section.
- **The owner line's five**, not sent since 2026-11-02, kept below as the record of what was approved.

This file is written from \`src/ops/alert.ts\`, \`src/billing/remind.ts\` and \`src/owners/templates.ts\`. Change the
templates there, then run \`node scripts/templates-doc.ts\`; a test fails while the two differ.

## The operator's alert

Submitted by hand on 2026-11-03 in WhatsApp Manager (Message templates), on the WhatsApp account that holds our number
(the one \`META_DEMO_PHONE_ID\` names), exactly as below: category **Utility** (it tells the business's own operator
about their own system, and sells nothing), no header, no footer, no buttons, the body's four lines and the two sample
values. It was **in review** that day. Meta's precheck called it Marketing, so it may be approved as Marketing (it is
still sent by its name, at Meta's Marketing rate) or rejected.

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
number its owners verified, once each, beside the email. It hands each one to Toran on this machine
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
most ${REMIND_WEEK_MAX} reminders in ${REMIND_WEEK_DAYS} days, and the same one never twice.

${reminderTemplateDoc()}
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
