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

   Replies from the inbox go out from the number the person wrote to. Neither number is live yet. On Meta, our one
   number does all of this by itself once it is connected on this store's WhatsApp page: see "Toran on our own
   number" below.
5. **After a change on the site** (a price, a question, `support.json`): steps 1 and 2 again. The owner's own answers
   (the dashboard's questions, the inbox's "save the answer") are kept.

## Toran on our own number

OpenFrequency has one WhatsApp number: its public number, on the WhatsApp Business app on the operator's phone. It is
`DEMO_WA_NUMBER` and `TORAN_OWNER_WHATSAPP`, the number behind every pitch page's "try it on WhatsApp" button and the
website's. There is no second number and no Twilio. Once it is connected to Meta on this store's WhatsApp page
(coexistence, so it stays on the phone), Toran answers on it in three roles, with no other setting
(`src/channels/lines.ts` `oneNumber`). Each message is read in this order (`src/channels/demo.ts`):

| | Who | Who answers |
| --- | --- | --- |
| 1 | A message with a code: `REQ-...` (the website's demo form) or `DEMO-...` (a pitch page's button); a pitch page's own message to us ("take this page down", "about the page") | the demo request (Toran's or Teder's, one of each per number: docs/operator.md section 3), or the demo as that store; the page's message is kept for you. A code comes first, so a business owner who presses a pitch page's button still gets the demo |
| 2 | A business owner whose number accounts verified, or a `LINK-...` code from accounts | the owner's assistant (docs/owner-line.md), Teder's news included |
| 3 | A phone bound to a demo in the last 7 days | that store's demo agent |
| 4 | Anyone else | our support: this store, its prompt and its three tools |

Every answer, every reply from the inbox and every template of the owner line goes out from the same number, through
the Cloud API. The number is never answered as this store's own WhatsApp: that would skip rows 1 to 3. No other
store can connect it: its page says "זה המספר של OpenFrequency, ואי אפשר לחבר אותו לחנות", by the number's Meta id
or by the number Meta shows.

**A demo ends back into support.** When the person writes just "תמיכה" or "עזרה", or writes after the 7 days, the
demo's binding goes, one line says "סגרנו את הדמו. מעכשיו עונה לכם כאן התמיכה של OpenFrequency..." (after the 7 days:
"עברו 7 ימים מאז שהדמו התחיל, אז סגרנו אותו..."), and our support answers from then on; a question sent with it is
answered at once. "עזרה" inside a sentence is a question for the demo store. Pressing a page's button again starts a
new demo. The line is kept in the support conversation, so the inbox shows it.

**Answering from the phone.** When you answer someone from the WhatsApp Business app (Meta's `smb_message_echoes`),
the answer lands where that person is talking now, and Toran stops answering there for 12 hours:
- in a demo: the demo store's conversation with them;
- in support: this store's conversation with them;
- a business owner: their chat with the assistant, kept in `assistant_messages`; "הפסק" still works while it waits;
- someone who never wrote: a new support conversation, so their answer waits for you.
Where they wrote last wins. "להחזיר לתורן" in the inbox brings Toran back in a demo or support conversation; an
owner's pause ends by itself after the 12 hours.

**Where to see it.** This store's WhatsApp page and lead page say "זה המספר שלנו" and list the roles in order;
`GET /internal/ops` (accounts' /admin) has `ourNumber` with the number, its status and its roles.

### The steps, once App Review has passed

1. **Before:** this store is synced (step 2 above; store 95 in production), and Meta's settings of
   docs/connecting-channels.md step 2 are in `.env` (`META_APP_ID`, `META_APP_SECRET`, `META_WA_CONFIG_ID`,
   `META_WEBHOOK_VERIFY_TOKEN`, `TORAN_SECRETS_KEY`), with the webhook's fields `messages`, `smb_message_echoes` and
   `account_update` subscribed.
2. **`.env` on tiyul-vps**, then restart (docs/connecting-channels.md, "How to change a setting on the server"):
   ```
   TORAN_SUPPORT_STORE=openfrequency.co.il
   DEMO_WA_NUMBER=<our number, digits only>          # already set
   TORAN_OWNER_WHATSAPP=<the same number>            # already set
   TORAN_ASSISTANT_WA=<the same number>              # the owner line is this number too
   META_SYSTEM_TOKEN=<optional, recommended: connecting-channels.md step 3, item 4>
   ```
   In accounts, `OF_ASSISTANT_WA` is the same number, so its link page tells owners to send their code here. Leave
   `META_DEMO_PHONE_ID` and `META_OWNER_PHONE_ID` out: the connection in step 3 sets the number's id. (Setting them to
   its id does the same.)
3. **Connect:** open `/admin/toran/lead/95/whatsapp` and press "לחבר את הוואטסאפ של החנות". In Meta's window choose
   OpenFrequency's business, choose to connect the existing WhatsApp Business app number, and approve on the phone with
   the code Meta shows. The page says "המספר שלנו מחובר. מעכשיו תורן עונה בו לבעלי העסקים, לדמו ולתמיכה." and shows
   "מה המספר הזה עושה" with the three roles. No restart: it is on from this moment.
4. **The owner line's templates** (docs/whatsapp-templates.md): create them in WhatsApp Manager on this number's
   WhatsApp account; once Meta approves them, `META_TEMPLATES=teder_posts_ready,...` and restart. Until then Teder's
   news outside the 24 hours is skipped as `no_template`.
5. **Try each role**, from a personal phone:
   - **Support:** from a number accounts does not know, with no demo, write "כמה עולה תורן?". Our support answers, and
     the conversation is in this store's inbox.
   - **Demo:** open any pitch page and press its WhatsApp button. The store's welcome comes, and a question is answered
     as the store. Write "תמיכה": the line above comes, and the next question is support's.
   - **Owner:** from a number linked in accounts (or link one: a code from accounts, sent to our number), write
     "מה קורה?". The assistant answers.
   - **The phone:** answer one of these from the WhatsApp Business app. The answer shows in that conversation in the
     inbox, and the next message there waits for you.
6. **Undo:** "לנתק את הוואטסאפ מתורן" on the same page. Toran stops answering on the number at once; the phone keeps
   working as before.

## Checking it

```
npm run eval -- openfrequency.co.il       # 30 questions about the service, graded in code, on the subscription
npm run chat -- openfrequency.co.il       # talk to it in the terminal
```
