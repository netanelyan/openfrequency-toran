# Our own support: a company store

Toran answers the people who write to OpenFrequency about Toran and Teder, the way it answers a store's customers:
from what our site says, with the same tools, guard and inbox. The store it answers as is a **company store**
(`src/company.ts`): platform and status `company`, no workspace (the operator's), never found, scored, ingested or
pitched, and left out of the leads, the queue, the follow-ups and the funnel.

## Where its knowledge comes from

One JSON file, made by the website repository from the same config and page modules the site is built from
(openfrequency-web `src/support.mjs`). Its real build publishes it beside the pages, so every deploy of the site puts
it at `https://openfrequency.co.il/support.json`, and Toran reads it there by itself ("It re-reads the site by itself"
below). The same file, by hand:

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
- The guard's honest lines say the bot is not sure and passed it to "someone from our team" (נציג שלנו) instead of the store's, and "not available yet" is not a stock claim. The bot is "תורן" (src/agent/intro.ts).
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
   ssh tiyul-vps 'cd /opt/toran && sudo -u toran env TORAN_HOME=/opt/toran/private TORAN_ENV=prod NODE_ENV=production /opt/node24/bin/node scripts/company.ts sync private/support/openfrequency.json'
   ```
   It prints the store's id and its email address. The same with `show` in place of `sync private/...` lists what it
   holds. On the server, `npm run company` does not work: npm runs the system's Node 20 (`/usr/bin/node`), which
   cannot load a .ts file (ERR_UNKNOWN_FILE_EXTENSION, 2026-11-05), and it would not have the service's TORAN_HOME;
   the service itself runs `/opt/node24/bin/node` (deploy/toran.service). Locally `npm run company` is fine.
3. **Email:** on `/admin/toran/lead/<id>`, "לחבר מייל" gives it `support@in.openfrequency.co.il`. Mail to that
   address is answered by the agent (docs/connecting-channels.md, step 1).
4. **WhatsApp (optional):** `TORAN_SUPPORT_STORE=openfrequency.co.il` in `private/.env`, then restart. Two of our
   numbers then answer as support where they could not answer before:
   - the demo number, which is also our public number (TORAN_OWNER_WHATSAPP, DEMO_WA_NUMBER): a phone with no demo
     gets the support agent instead of "press the button on the page". A demo code still binds as before.
   - the owner line (`TORAN_ASSISTANT_WA`): a number no workspace linked gets the support agent instead of "this
     number is not linked". Owners still get their assistant.

   Replies from the inbox go out from the number the person wrote to. Our number has been live on Meta since 2026-10-31 (docs/connecting-channels.md, "What production runs"). On Meta, our one
   number does all of this by itself once it is connected on this store's WhatsApp page: see "Toran on our own
   number" below.
5. **After a change on the site** (a price, a question, `support.json`): deploy the site. With
   `TORAN_SUPPORT_EXPORT_URL` set (below), the store follows by itself, at the next Israel day or the next start of
   Toran; without it, steps 1 and 2 again. Either way the owner's own answers (the dashboard's questions, the inbox's
   "save the answer") are kept.

## It re-reads the site by itself

Customers' stores are re-scraped every day; this store re-reads the site's export instead (`src/jobs/reread.ts`,
the `company_reread` job). It is off until `.env` names the file:

```
TORAN_SUPPORT_EXPORT_URL=https://openfrequency.co.il/support.json
```

There is no default, so a laptop's worker or a test never reads the live site.

- **When:** the worker queues the read once an Israel day (the first minute after midnight, as the retention pass),
  and once soon after each start, so a restart of Toran picks up the site at once. One read at a time.
- **What it does:** a GET of the URL (https only, 15 seconds, at most 1 MB; the file is about 50 KB), through the
  same fetcher as every store's pages, robots.txt included: a draft of the site disallows everything and is never
  read. The file is checked exactly as `npm run company -- sync` checks it (`parseExport`), and must be for a company
  store that is already here, by its domain (the first sync is by hand, step 2), and for `TORAN_SUPPORT_STORE`'s domain
  when that is set.
- **Only when it changed:** each sync keeps the export's hash in the store's `config.company.hash` (the whole file but
  `generatedAt`, which every build of the site changes). The same hash, and nothing is written. A new one, and the same
  sync as by hand runs (`syncCompany`), then the store's prompt is forgotten, so the next answer reads the new file.
  A file synced by hand is not synced again by the next read. The chunks' embeddings are made on this machine's CPU
  (no paid API), but loading the model and rewriting every page is why the read skips a day the site did not change.
- **When it fails** (the site down, a timeout, an HTTP error, over the cap, not JSON, not an export, another domain,
  no such store): one line in the log, `[reread] <url>: not read (<why>); the store keeps what it had`, and the store
  keeps every plan, question and page it had. Nothing is written before the whole file has passed, and the sync is
  one transaction. The next try is the next Israel day, or the next start.
- **Where to see it:** each read writes one `company_reread` event (`changed`, or `ok: false` with the `error`) and
  one `[reread]` log line; a sync also writes `company_sync` with `from`, the URL or `file`. `npm run company -- show`
  says where the last sync came from and its hash. To read the site now, restart Toran.

## Toran on our own number

OpenFrequency has one WhatsApp number: its public number, on the WhatsApp Business app on the operator's phone. It is
`DEMO_WA_NUMBER` and `TORAN_OWNER_WHATSAPP`, the number behind every pitch page's "try it on WhatsApp" button and the
website's. There is no second number and no Twilio. Once it is connected to Meta on this store's WhatsApp page
(coexistence, so it stays on the phone), Toran answers on it in three roles, with no other setting
(`src/channels/lines.ts` `oneNumber`). Each message is read in this order (`src/channels/demo.ts`):

| | Who | Who answers |
| --- | --- | --- |
| 1 | A message with a code: `REQ-...` (the website's demo form) or `DEMO-...` (a pitch page's button); a pitch page's own message to us ("take this page down", "about the page") | the demo request (Toran's or Teder's, one of each per number: docs/operator.md section 3), or the demo as that store; the page's message is kept for you. A code comes first, so a business owner who presses a pitch page's button still gets the demo |
| 2 | A message with a `PAY-...` code (accounts' "לתשלום אוטומטי בוואטסאפ" button), or a photo or a document from a phone that sent one in the last 7 days | the payment (`src/channels/pay.ts`, docs/operator.md section 7): the amount and the transfer's details from accounts, then the receipt handed to accounts. A PAY code is read right after a `REQ-` code, and a receipt before the owner routing, so a business owner who pays gets this, not their assistant. A text from that phone goes on to the rows below |
| 3 | A business owner whose number accounts verified, or a `LINK-...` code from accounts | the owner of a Toran store: their assistant (docs/owner-line.md), with Toran's tools only. An owner with Teder and no Toran store: our support, as in row 5 (since 2026-11-02 Teder is managed on its dashboard only, and none of its news goes to WhatsApp) |
| 4 | A phone bound to a demo in the last 7 days | that store's demo agent |
| 5 | Anyone else | our support: this store, its prompt and its three tools |

Every answer, every reply from the inbox and every template of the owner line goes out from the same number, through
the Cloud API. The number is never answered as this store's own WhatsApp: that would skip rows 1 to 4. No other
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
4. **The owner line's templates:** none since 2026-11-02. All five were about Teder, and none of Teder's news goes to
   WhatsApp now (docs/owner-line.md, first section); `META_TEMPLATES` can stay empty, and the five approved on
   2026-10-31 can be deleted in WhatsApp Manager.
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

## A company store answered elsewhere: על הקו

על הקו (alhakav) is a second company store: a service for Israeli tradespeople (plumbers, electricians, AC
technicians, locksmiths). When they miss a call, the caller gets a WhatsApp message from the tradesperson's "assistant
number", which asks what happened and where, and the tradesperson gets a summary. The people who write to על הקו's own
WhatsApp number found its website, or are tradespeople it wrote to first, or are paying customers, and Toran answers
them as על הקו.

The conversations do not come through Toran's channels. על הקו's own service, on the same machine, owns its number on
Meta's Cloud API and its webhook. For each message it asks Toran for the answer over an internal route
(`src/channels/external.ts`), and sends the reply itself, from its own number. **Toran sends nothing to WhatsApp, or to
any other channel, for these conversations, and raises no alert of its own for their handoffs**: the answer carries
the handoff, and על הקו tells its own people (on the operator's phone through `POST /internal/ops/alert` with
`"product": "alhakav"`, below). The one alert Toran still raises itself is the one every store has: more than 200
answers at the store in an hour (`TORAN_STORE_TURNS_PER_HOUR`), a flood.

### What is different from our support

- **People join in the chat.** The export says so: `"start": { "kind": "join", "text": "<one or two sentences in the
  company's words on how to start>" }`. `start` may be left out (or null) and may be `"demo"`: both are OpenFrequency's
  way, unchanged (`COMPANY_PROMPT`). Anything else, a text that is empty or longer than 600 characters, or a start
  that is not an object, stops the export (`readExport`, "not a company export: start"). A sync keeps it in the store's
  `config.company.start`, beside `status`, and a sync without it takes it away.
- **Its own prompt and tools** (`src/agent/prompt.ts` `COMPANY_JOIN_PROMPT`, `src/agent/tools.ts`
  `COMPANY_JOIN_TOOLS`), for a company store whose start is `"join"`: the same hard rules, grounding and voice as ours,
  and nothing of OpenFrequency's own (no demo asked for on the website, no "# A store we wrote to" with its LEAD block,
  no Toran or Teder in the examples). The COMPANY block adds "How to start" with `start.text`, which backs a claim for
  the guard as `status` does.
- **Joining.** When someone wants to join, start, sign up or pay, the agent asks for the business's name as the people
  who call them should see it ("אבי אינסטלציה"), unless it has it, then calls `handoff` with reason `join` and the name
  in `business`, and says in one short sentence that the amount and the transfer details come in the next message.
  `handoff` refuses a join without a name ("ask the person for it"). It never asks for card details and never says
  when the service will be set up. The company handoff takes `business` on our support too, and keeps it.
- **Who the person is** comes from על הקו, in the request's `context` ("A paying customer: business אבי אינסטלציה,
  paid until 24.12.2026."): it rides in the turn's SERVER CONTEXT, and is never stored or shown.
- **The bot's line** is "היי, אני תורן, הבוט של על הקו." (src/agent/intro.ts). A name given on the store's "מה תורן
  יודע" page replaces "תורן".

### The route

`POST /internal/company/answer`, from this machine only, with `Authorization: Bearer <OF_INTERNAL_TOKEN>` and never
through Caddy, as `/internal/ops/alert`: `503 not_configured` (no token set here), `403 forbidden` (another machine,
or an `X-Forwarded-For`), `401 bad_token`, then `405 method_not_allowed` for a GET, `400 bad_request` for a body that is
not a request, and `404 no_store` when the domain is not a company store here.

```json
{
  "domain": "alhakav.example.co.il",
  "phone": "972500000000",
  "name": "אבי",
  "messages": [{ "id": "wamid.X", "text": "כמה זה עולה?", "at": "2026-11-21T10:00:00.000Z" }],
  "operator": [{ "text": "היי אבי, עוד רגע עונים לך", "at": "2026-11-21T09:58:00.000Z" }],
  "context": "A tradesperson we wrote to first; they pressed 'כן, שלחו' and already got our explanation."
}
```

| Field | |
| --- | --- |
| `domain` | the company store's domain, as its export has it |
| `phone` | the person, international digits only, 8 to 15 of them |
| `name` | their WhatsApp profile name, or null (kept on a new conversation, for the inbox) |
| `messages` | their new messages since the last call, oldest first: 1 to 20, each with its id (no spaces, up to 200 characters, once in a call), its words (up to 4096 characters) and its time |
| `operator` | what a person of על הקו answered them by hand since the last call: 0 to 20, each with its words and its time. May be left out |
| `context` | על הקו's own line about who this is, up to 2000 characters, or null |

The answer, 200:

```json
{ "reply": "היי, אני תורן, הבוט של על הקו.\n\n...", "handoff": null, "conversationId": 812 }
{ "reply": "רשמתי. בהודעה הבאה יגיעו הסכום ופרטי ההעברה.", "handoff": { "reason": "join", "summary": "רוצה להצטרף", "business": "אבי אינסטלציה" }, "conversationId": 812 }
{ "reply": null, "handoff": null, "conversationId": 812, "duplicate": true }
```

`reply` is the exact text to send, the bot's line and the guard included, or null when Toran does not answer.
`handoff` is the one Toran kept in the conversation during the call, its reason one of the company handoff's
(`unknown`, `demo`, `join`, `account`, `billing`, `cancel`, `discount`, `complaint`, `human_requested`, `stop`, `bot`,
`other`), with `business` when a person gave it to join, else null. What Toran does, by what came in:

| What came in | `reply` | `handoff` |
| --- | --- | --- |
| a question Toran answers | its answer | the model's, when it handed off (a join, an account question, no answer in the tools) |
| a stop word alone ("הסר", "STOP", "תסירו אותי"; core/stopWords.ts) | the store's one line: "בסדר, לא נשלח לכם יותר הודעות אוטומטיות מעל הקו. אם תכתבו לנו כאן, נענה כרגיל." | `stop` |
| "די" or "לא מעוניינים", which the model hears as a stop | the model's one sentence that we will not write again | `stop` |
| another business's bot (pace.ts, or the model) | null | `bot`, the first time only |
| a person of על הקו answered in the last 12 hours (theirs in `operator`, by its time) | null | null |
| a person's answer is the newest thing in the call | null | null |
| a thanks or a thumbs-up after our answer | null | null |
| past 6 answers in the conversation in an hour, 20 to this person in a day, or 200 at the store in an hour | null | `other` |
| past a spend cap, or no answer from the model in time | "כרגע אני לא מצליח לענות, אז העברתי את ההודעה לנציג שלנו. הוא יחזור אליך כאן." | `other` |
| a message id already answered | null, `duplicate: true` | null |

Each message is kept under its id (as `ext:<store>:<id>`), so the same call made again answers nothing twice; two at
once wait for each other, and the second is a duplicate. When a call brings several messages, the last one is
answered and the ones before it are kept with it, so the model reads them all. What a person answered in `operator` is
kept once by its words and time, in the order it was written among the person's messages, as a person's answer from
the inbox is: Toran stays quiet in the conversation for 12 hours from it, and the bot's next answer opens "זה שוב תורן,
הבוט של על הקו." A conversation is the same until a week of silence, as on every WhatsApp.

The model's turn has up to 60 seconds (`TURN_DEADLINE_MS`), so על הקו waits at least 75 for the answer.

### In the inbox

The conversation is the company store's, on WhatsApp, with the person by phone, on one channel account of kind
`external` (`external:<domain>`, made by the first call). It is in the store's inbox like any other, and waits there
after a handoff until a person of על הקו answers (it comes back in `operator`) or it is marked handled. In place of the
reply box it says "השיחה הזו בוואטסאפ של על הקו, ומשם יוצאות גם התשובות של תורן. עונים לה מהמערכת של על הקו, ומה
שכותבים שם מופיע כאן." (`replyState` reason `elsewhere`; a reply from the inbox or from the owner's assistant is refused
the same way, and nothing is sent). A person's answer from על הקו shows as "הצוות של על הקו", "נשלח מהמערכת של על
הקו". "להחזיר לתורן" still ends the 12 hours. No email, push or operator alert is made for it (owners/waiting.ts).

### Its alerts on the operator's phone

על הקו hands its own operator alerts to Toran as Teder does, `POST /internal/ops/alert` with `"product": "alhakav"`
(docs/operator.md section 6): someone new wrote, someone wants to join, a handoff, a transfer's screenshot came. Its
keys are kept as `alhakav:<key>`, its title goes to the phone as it wrote it, and no command runs. Left out, product is
`"teder"`, so Teder sends nothing new. All three sources share the phone's limits: one key once an hour, ten an hour.

### Setting it up

1. **Make the file**, on the development machine, by hand or from על הקו's own repository, in the export's shape
   (`domain`, `url`, `name`, `status`, `tone`, `contact`, `plans`, `faq`, `pages`, and `"start": { "kind": "join",
   "text": ... }`), at `private/support/alhakav.json` (private/ is never committed). Try it on a local database first:
   ```
   npm run company -- sync private/support/alhakav.json --slug alhakav
   npm run chat -- <its domain>
   ```
2. **Copy it to the server and sync**, as for ours (step 2 of "Setting it up" above), with its own slug: without
   `--slug`, it asks for `support`, which is ours, and gets none.
   ```
   scp openfrequency-toran/private/support/alhakav.json tiyul-vps:/opt/toran/private/support/
   ssh tiyul-vps 'cd /opt/toran && sudo -u toran env TORAN_HOME=/opt/toran/private TORAN_ENV=prod NODE_ENV=production /opt/node24/bin/node scripts/company.ts sync private/support/alhakav.json --slug alhakav'
   ```
   It prints the store's id. Nothing else to set on Toran, and no restart: `TORAN_SUPPORT_STORE` stays ours, and the
   `external` account is made by the first call.
3. **On על הקו's side:** Toran is `http://127.0.0.1:4710/internal/company/answer` (docs/deploy.md), with the same
   `OF_INTERNAL_TOKEN` as accounts and Teder, never through Caddy, waiting at least 75 seconds.
4. **After a change** (a price, a question, how to start): steps 1 and 2 again. Toran does not re-read it by itself:
   the daily read (`TORAN_SUPPORT_EXPORT_URL`) is our site's, and takes only `TORAN_SUPPORT_STORE`'s domain.

## Checking it

```
npm run eval -- openfrequency.co.il       # 30 questions about the service, graded in code, on the subscription
npm run chat -- openfrequency.co.il       # talk to it in the terminal
npm run chat -- <על הקו's domain>         # על הקו's, on its own prompt
```
