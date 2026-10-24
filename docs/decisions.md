# Decisions

Each entry gives what was decided, the alternatives, and why. Newest at the bottom.

## 2026-10-21: a separate repository, not apps/toran

**Alternatives:** a folder inside open-frequency.

**Why:**

- Teder's network rules forbid WhatsApp writes, and that is Toran's whole job.
- The two products' private data differ, and so do their public checks.
- The shared code is about six files, which were copied (see audit.md).

## 2026-10-21: no Next.js, no Redis

**Alternatives:** Next.js for the dashboard and pitch pages; BullMQ on Redis for jobs.

**Why:**

- The dashboard must look like Teder, which is server-rendered strings, one stylesheet and one script under a
  strict CSP. Reusing that beats re-creating it in React.
- Pitch pages are static HTML for phones.
- Phase 1 job volume fits a Postgres table with `SKIP LOCKED`, one service fewer to run.

## 2026-10-21: PGlite for development and tests

**Alternatives:** require Docker or a Postgres install on the laptop; SQLite in development.

**Why:**

- PGlite is real Postgres compiled to WASM, with the pgvector extension, so the migrations, the queries and
  `<=>` are identical to production.
- This machine has no Docker. Tests get an in-memory database each, in milliseconds.

## 2026-10-21: the agent runs on the subscription in development

**Alternatives:** the API everywhere.

**Why:**

- You asked for development and testing on the Claude Code subscription. The CLI headless call
  (`--tools "" --json-schema --system-prompt`) was measured at about 5 s a turn with structured tool calls.
- The agent loop and tools are the same in both backends. Only the transport differs: the CLI backend asks for
  `{reply | tool_calls}` as JSON and the loop runs the tools itself.
- In development the API backend is refused unless a command is run with `--allow-api` (Teder's rule).

## 2026-10-21: the model

**Alternatives:** Sonnet 5.5 ($2/$10 per MTok) or Haiku 4.5 ($1/$5) for lower cost.

**Decision:** `claude-opus-5-5` by default ($4 in, $20 out, $0.20 cache reads), at effort `low`, set in
`TORAN_MODEL_AGENT`.

**Why:**

- This is a sales demo in Hebrew where one wrong answer loses the store.
- The cost log records every call per store from day one, so the price of a demo is measured, not guessed. If it is
  too high, switching to Sonnet 5.5 is one setting.
- Chat at effort `low` is where the Claude docs say quality holds.

## 2026-10-21: local embeddings

**Alternatives:** Voyage or another paid embeddings API.

**Why:**

- `multilingual-e5-small` runs on the VPS's CPU at $0.
- It handles Hebrew, and on three test questions it ranked the right policy passage first.
- Policy text per store is small, so quality at this size is enough. Prices never come from embeddings anyway.

## 2026-10-21: Twilio as the BSP for phase 1

**Alternatives:** 360dialog (€49 a month per number); Meta's Cloud API directly.

**Why:**

- Demo replies are service messages, which Meta does not charge for.
- Twilio's $0.005 a message comes to about $4 a month at phase 1 volume, and its sandbox works today.
- The provider is one file behind an interface.

## 2026-10-21: StoreCensus as the first discovery source

**Alternatives:** Brave Search only.

**Why:**

- It lists about 5,800 Shopify stores based in Israel, and its robots.txt allows reading it.
- Brave needs a key that is not set yet.
- The directory ranks the biggest stores first, and Toran's buyers are smaller, so discovery reads its deeper pages
  (20 and on) first.

## 2026-10-21: chains are pushed down hard

**The rule:** -25 for a branch locator, the local site of an international brand, or 2,000+ products; the
catalogue factor also falls from 1,000 products.

**Why:** the first run qualified three national fashion and footwear chains. A chain does not buy a demo from a
solo developer.

## 2026-10-21: what WhatsApp Business does not allow is rejected at discovery

**The rule:** stores selling adult products, tobacco and vapes, weapons or drugs are rejected; alcohol is a -10
penalty.

**Why:** Meta's commerce policy, which WhatsApp Business follows, bars these categories, so Toran could never run
on those stores' numbers. The first run found one.

## 2026-10-21: the guard's allowlist leaves out the tools' own bookkeeping

**The rule:** "2 matching products", "[id 12]" and "3 options" do not put 2, 12 or 3 on the allowlist.

**Why:** the tests caught "only 2 left" and "arrives in 2 days" passing because of them.

## 2026-10-21: Hebrew search uses a light stem

**The rule:** each query word is also tried without a final ה/ת and without a plural ים/ות, so קערה finds קערת
and ספלים finds ספל. A word and all its forms count once.

**Why:** the router test caught a store whose only bowl is "קערת עץ זית", unfindable by "קערה".

## 2026-10-21: the pitch page header is the store's initial, not its logo

**The rule:** the store's initial sits in a circle in its own colour, beside the Toran mark. A logo, when it
loads, goes in the letter.

**Why:**

- The brand brief asks for the initial.
- Store logos were the commonest broken image in testing (relative paths, CDNs that refuse hotlinking).

## 2026-10-21: the owner's own phone never moves a lead

**The rule:** TORAN_OWNER_WHATSAPP can open any store's demo, and the store's status stays where it was.

**Why:** you will test every page before sending it, and that must not read as the store starting a demo.

## 2026-10-22: the pitch page, rebuilt in the Teder look, as OpenFrequency

**The page:** one column on Teder's silver wallpaper and glass. OpenFrequency speaks, as "we", and Toran is the
product's name on the page ("בנינו ל[חנות] תורן לוואטסאפ"). The sample chat is two questions and two answers about
one real in-stock product, written by the real agent. The price comes from one setting (`src/offer.ts`, edited on
/settings), never from a template. There is no free period anywhere. Light only for now. Heebo is served from our
own server, so no visitor's address goes to Google.

**Nothing is shown as a guess.** A page opens to anyone but the owner only when it is approved and nothing is missing
(`src/pitch/ready.ts`): the store's name, its colour, a product count, the two-turn sample chat, the price, and the
two WhatsApp numbers (the demo number, and OpenFrequency's own for "write to us" and takedowns). Before this, a
missing colour became graphite, a failed sample answer was rebuilt from the product row, and any page could be opened
by anyone with its link before approval. Now the review queue lists what is missing and approve stays off.

**Take this page down:** the footer link opens WhatsApp to OpenFrequency's number. The click is recorded and flagged
on Today and on the lead. Confirming it in the dashboard takes the page down (410), kills its demo code and open
bindings, cancels the reminder and skips the store. A takedown is an opt-out, so the status cannot bring it back.

**Kept from the old page:** the opens, scroll depth and demo-tap tracking (owner visits not counted), noindex in the
meta and the header, the demo code in the WhatsApp link, the docked button on a phone, the dashboard preview, the
contrast rule for the store colour. **Dropped:** the store's logo, the quoted policy lines (the hero now names the
pages that were read), the "what does not work yet" section, and dark mode.

## 2026-10-22: sign-in moves to openfrequency-accounts; every store belongs to a workspace

**The change (the owner's call):** Toran's own login, its users table and its password hashes are gone, as in Teder.
A browser without a session goes to `accounts.openfrequency.co.il/login?next=<the page>`; Toran sends the
`__Secure-of_session` cookie (only that one over HTTPS, so a sibling subdomain cannot plant a plain one) to accounts'
`GET /internal/session?product=toran` on this machine. Accounts' document says to ask on every request; the owner chose
a page may reuse an answer for 60 seconds and every POST asks afresh, so no change acts on a session that has signed
out or turned read-only. A failed check (accounts down, a wrong token) shows a page and lets nobody in. Sign-out is a
link to accounts' sign-out. The CSRF token stays Toran's, derived from the accounts session id.

**Workspaces:** `stores.workspace_id`, and everything else hangs off a store. A session sees its workspace's stores and
nothing else; another workspace's store, chat or job is "not found", checked once in the server before any route runs.
A store with no workspace is a lead the operator is still selling to: only the operator (the superadmin outside
view-as) sees it, and every workspace besides. The offer on the pitch pages, lead discovery, adding a store, the keys
and developer mode are the whole server's, so they are the operator's. View-as is read-only on the server, with the
banner accounts asks for. A signed-in session counts as the owner on a pitch page only for its own workspace's store.

## 2026-10-23: a channel layer, with WhatsApp as its first adapter

**The change:** Toran is moving from WhatsApp only to email, Messenger and Instagram: the same agent, the same
knowledge pack, one inbox. Step one moves WhatsApp behind an adapter interface (`src/channels/`) and changes nothing
else. `types.ts` holds the shapes, and `whatsapp.ts` the Twilio and simulator adapters. `policy.ts` has each channel's
rules, and `send.ts` is the one place a message leaves. `route.ts` takes every inbound message, and `demo.ts` is the
shared demo number's code binding. `src/wa/` keeps two re-exports so old imports still resolve.

**Rules in code, not in the prompt:** before every send, `send.ts` asks `sendPlan()` whether the channel's reply window
is open (24 hours on WhatsApp, measured from when the webhook received the message), and `fit()` cuts a reply into
parts the provider takes (Twilio: 1,600 characters a body).

**Proof of no behaviour change:** `test/channels-golden.test.ts` was committed on the old code first. It covers every
router outcome in one scripted run, and everything sent and written. It passes unchanged on the new code. The only
differences are two cases that never happen in that run, and the new tests cover both. A message answered more than
24 hours after it arrived is now held back and recorded (`wa_blocked`), where Twilio would have refused it. A reply
over 1,600 characters now goes in parts, where Twilio would have refused it whole.

**Decided for the steps after this one (the owner's calls):**

- An owner's reply pauses the agent in that conversation, until "להחזיר לתורן" or 12 hours after the owner's last
  message.
- Each channel is `off`, `demo` or `live` in the global list, so the website never calls a demo "live".
- Channel connections belong to a store (its knowledge pack answers them); a workspace's list is its stores'.
- Email is sent from our own subdomain first, and from the store's own domain later.
- OpenFrequency is the business for Meta's verification, and its own Page and Instagram account carry the demo.

## 2026-10-23: email, the first channel past WhatsApp

**Inbound:** Resend's inbound webhook on a receiving subdomain, rather than a forwarding service per store. Each
store gets `<slug>@TORAN_MAIL_DOMAIN` and forwards its own mail there. The webhook carries only the metadata, so the
worker fetches the body and the headers from Resend before routing (`complete()` in `src/channels/email.ts`). The
signature is Svix's, checked with no library.

**Outbound:** through Resend, from the store's address with the store's name. A reply carries `In-Reply-To` and
`References`, so it threads in the customer's mail. A reply in the thread, or one with the same subject within 30
days, stays one conversation. The agent's replies say `Auto-Submitted: auto-replied`; the owner's do not.

**Never answered, in code:** `Auto-Submitted`, `Precedence: bulk/list/junk`, list headers, auto-reply headers, an
empty `Return-Path`, delivery reports, no-reply and daemon senders, and our own domain. Such mail is kept and shown
as automatic. A bounce or a complaint suppresses the address (`mail_suppressed`). An email with only files hands the
conversation to the owner. A customer gets at most 20 agent answers a day per store address.

**The owner's reply, on every channel:** from the chat page, through the conversation's own adapter and the same
checks as any send. It pauses the agent there for 12 hours from the owner's last reply, until "להחזיר לתורן". On
WhatsApp the reply box closes 24 hours after the customer's last message, because Toran has no approved templates.

**The agent:** one line changed. The server context names the channel (for WhatsApp it is byte-identical), and the
owner's replies are part of the history it reads. A store's own channel has no demo footer.

**Config:** `TORAN_CHANNELS` turns a channel's code on (`whatsapp,email`). The operator sets each channel to `off`,
`demo` or `live` on /settings, and a channel whose code is off cannot be set past `off`. `GET /channels.json` gives
the website those states and nothing about any store.

**Not done here:** an address on the store's own domain (it needs DNS on their side), sending attachments, and
merging one customer across channels.

## 2026-10-24: the owner line, one WhatsApp number for Toran and Teder

**The change:** a business owner writes to one number (`TORAN_ASSISTANT_WA`, a second Twilio sender) and talks to
their assistant about their Toran store, their Teder posts, or both, whichever their workspace has. Teder's news
reaches them on the same number. The contracts with accounts and Teder are in docs/owner-line.md, and the code is
in `src/owners/`.

**Who a number is comes from accounts, asked live.** A number is an owner's once it has sent accounts' link code
(`LINK-XXXXXX`) to the line: the number that wrote is the proof, as with the website's demo requests. Accounts
links and verifies it, and keeps the opt-in from the link form with its time. A number typed on the dashboard
(`stores.owner_phones`, from the day before) is no longer read: it proved nothing. A number nobody vouched for gets
one line saying it is not linked, at most once an hour. If accounts does not answer, nobody is an owner.

**The rule that Toran writes only to someone who just wrote has one exception, in one file.** `owners/notify.ts`
may start a message to a business owner's verified number, about their own Teder account. Each message is checked
first:
- the opt-in is the latest word, in accounts and here
- Teder's quiet time is over (Shabbat and the owner's quiet hours, Teder's settings, asked of Teder each time)
- the number has had fewer than 8 such messages in 24 hours
- inside the 24 hours after the owner's last message it may hold text and images; outside them it is an approved
  utility template, or nothing at all.

Every attempt is a row in `owner_notifications`. "הפסק" stops all of it, kept here as well as in accounts, and
"התחל" brings it back. The first message to each number says it comes from a digital assistant, and every
template's footer says it again.

**The owner's reply acts at once.** "אשר את 1 ו-3, את 2 תעשה קצר יותר" approves two posts and sends one back
with the owner's words as its note, and the answer says what Teder did. The owner is giving instructions about
their own posts, the way one click does on Teder's dashboard, so there is no "כן" step. Toran's offer to write to a
customer still waits for "כן".

**Read in code first, the model second.** `owners/intents.ts` reads replies about posts: numbers, ordinals, "all",
"the rest", "all but", "not yet", reasons to rewrite, an edit to one line, show, send, status. It answers only when
it understood the whole message. Anything else (a question, a "don't", a verb it cannot place) goes to the model,
which has Teder's tools next to Toran's. Those tools act only on a number the owner's message names (`mentioned()`),
and an edit only with words that appear in the owner's message. The model cannot approve what the owner did not ask
for. Covers, images and captions go to the owner from Teder's answer by code, never through the model.

**Not done here:** the live-model check of the same twenty phrases (`test/intents.test.ts` checks the reader in
code), and Meta's approval of the templates (docs/whatsapp-templates.md is the sheet to submit).
