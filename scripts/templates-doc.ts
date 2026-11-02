// Writes docs/whatsapp-templates.md, the submission sheet for Meta, from src/owners/templates.ts.
import { writeFileSync } from 'node:fs';
import { templatesDoc } from '../src/owners/templates.ts';
const head = `# WhatsApp templates for the owner line

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

This file is written from \`src/owners/templates.ts\`. Change the templates there, then run
\`node scripts/templates-doc.ts\`; a test fails while the two differ.

`;
writeFileSync('docs/whatsapp-templates.md', `${head}${templatesDoc()}`);
