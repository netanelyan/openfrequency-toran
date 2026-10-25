# Our own support: a company store

Toran answers the people who write to OpenFrequency about Toran and Teder, the way it answers a store's customers:
from what our site says, with the same tools, guard and inbox. The store it answers as is a **company store**
(`src/company.ts`): platform and status `company`, no workspace (the operator's), never found, scored, ingested or
pitched, and left out of the leads, the queue, the follow-ups and the funnel.

## Where its knowledge comes from

One JSON file, made by the website repository from the same config and page modules the site is built from:

```
openfrequency-web$ npm run support -- <file.json>
```

| In the file | What the agent does with it |
| --- | --- |
| `plans` | a product row each; `get_plans` quotes each plan's sentence (price, VAT, what it covers, setup fee) |
| `faq` | the questions of /faq; the answer the agent reads is `support.json`'s for that question when it has one, else the site's |
| `pages` | what Toran does today, who we are, the /toran and /teder price sections, terms, privacy, security, accessibility; `get_policy` searches them |
| `status` | what Toran does today and what not yet: in the agent's prompt, above everything else |

The site still describes the product at launch (every channel live, the store's own WhatsApp number, abandoned
carts). `openfrequency-web/support.json` says what is true today: its `today` list and its answers replace the site's
for the agent only, and the site itself is not changed. Delete an entry once the site and the product agree. An
answer whose question is no longer on /faq stops the export.

## The agent

`src/agent/prompt.ts` `COMPANY_PROMPT` and `companyBlock`, `src/agent/tools.ts` `COMPANY_TOOLS` (`get_plans`,
`get_policy`, `handoff`). The same voice and grounding as a store's. What differs:

- What does not work yet is never said to work, even when a page says it does.
- A person's own account, bill, invoice, payment or cancellation is handed off, never answered.
- A demo or a sign-up: it asks for the store's address and hands it off (reason `demo` or `join`).
- The guard's honest lines say "someone from us" instead of "the store", and "not available yet" is not a stock claim.
- It is never a demo, wherever the message came from.

Handoffs land in the operator's inbox like any store's.

## Setting it up

1. **Make the file**, on the development machine:
   ```
   cd openfrequency-web && npm run support -- ../openfrequency-toran/private/support/openfrequency.json
   ```
2. **Copy it to the server and sync:**
   ```
   scp openfrequency-toran/private/support/openfrequency.json tiyul-vps:/opt/toran/private/support/
   ssh tiyul-vps 'cd /opt/toran && sudo -u toran npm run company -- sync private/support/openfrequency.json'
   ```
   It prints the store's id and its email address. `npm run company -- show` lists what it holds.
3. **Email:** on `/admin/toran/lead/<id>`, "לחבר מייל" gives it `support@in.openfrequency.co.il`. Mail to that
   address is answered by the agent (docs/connecting-channels.md, step 1).
4. **WhatsApp (optional):** `TORAN_SUPPORT_STORE=openfrequency.co.il` in `private/.env`, then restart. Two of our
   numbers then answer as support where they could not answer before:
   - the demo number, which is also our public number (TORAN_OWNER_WHATSAPP, DEMO_WA_NUMBER): a phone with no demo
     gets the support agent instead of "press the button on the page". A demo code still binds as before.
   - the owner line (`TORAN_ASSISTANT_WA`): a number no workspace linked gets the support agent instead of "this
     number is not linked". Owners still get their assistant.

   Replies from the inbox go out from the number the person wrote to. Neither number is live yet (Twilio or Meta,
   docs/connecting-channels.md), so this waits for them.
5. **After a change on the site** (a price, a question, `support.json`): steps 1 and 2 again. The owner's own answers
   (the dashboard's questions, the inbox's "save the answer") are kept.

## Checking it

```
npm run eval -- openfrequency.co.il       # 30 questions about the service, graded in code, on the subscription
npm run chat -- openfrequency.co.il       # talk to it in the terminal
```
