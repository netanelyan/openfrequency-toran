// Writes docs/whatsapp-templates.md, the submission sheet for Meta, from src/ops/alert.ts (the operator's alert) and
// src/owners/templates.ts (the owner line's).
import { writeFileSync } from 'node:fs';
import { alertTemplateDoc } from '../src/ops/alert.ts';
import { templatesDoc } from '../src/owners/templates.ts';
const head = `# WhatsApp templates

What Toran sends from our own number when WhatsApp allows nothing but a template Meta approved: outside the 24 hours
after the person last wrote to us. Two sets:

- **The operator's alert, \`operator_alert\`**, sent since 2026-11-03: each of Toran's and Teder's alerts, to the
  operator's own number (\`TORAN_ALERT_WA\`), from \`src/ops/alert.ts\`. It goes as this template always, inside the 24
  hours too, so it is never refused for the window.
- **The owner line's five**, not sent since 2026-11-02, kept below as the record of what was approved.

This file is written from \`src/ops/alert.ts\` and \`src/owners/templates.ts\`. Change the templates there, then run
\`node scripts/templates-doc.ts\`; a test fails while the two differ.

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
