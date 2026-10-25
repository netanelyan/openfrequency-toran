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

## 2026-10-24: the operator's dashboard

**The change:** the operator's Today opens on their dashboard (docs/operator.md, `src/ops/`, `pages/ops.ts`).
- One list of who to write to today, across Toran and Teder, each entry with its message and the button that copies
  it and opens the chat.
- Who is in a conversation, with their next step.
- Each product's funnel.
- The customers and the money, read from accounts.

Teder's store demos are copied in from Teder at each load, so that Toran keeps their outreach as it keeps its own
stores'.

**Why in Toran:** Toran is where the leads are found, the pages are built, the opens are counted and the outreach is
kept. Accounts and Teder each needed one read-only route (`GET /internal/ops/customers`, `GET /internal/demos`), and
nothing on this dashboard writes to them.

**The order:** first, stores that tried the demo. Then next steps that are due, then people who asked on the website
(they are waiting), then the reminders that are due (an opened page first), and last, new pages by their score.

**The line stays:** one approach and one reminder (outreach.ts). For a store that tried the demo, the question of
how it went takes the reminder's place and is not a third message. After the reminder the list never offers them
again, unless they answer.

**The one thing it sends:** the link to a Toran demo someone asked for on the website. It goes on the demo number
where they asked, inside the 24 hours after their message, as request.ts promised them ("נשלח לכם לכאן את הלינק").
After the 24 hours, the operator sends it from their own WhatsApp.

**Customers are accounts' word.** The funnel's last stage, and the money, come from accounts' subscriptions (paid or
ending). They are never taken from a status typed here.

**Found on the way:** the website's Toran demo form never sent the `REQ-` code that Toran has asked for since
2026-10-23, so every Toran request from openfrequency.co.il failed and was retried. It is fixed in
openfrequency-web (branch `toran-request-code`).

## 2026-10-24: one number for support and the demos; the demo goes out by itself

**One number.** OpenFrequency's WhatsApp (in TORAN_OWNER_WHATSAPP and DEMO_WA_NUMBER, both the same) is the support number, the "write to us" button and the demo
number. Until now a page counted "our number is the demo number" as missing, so that a takedown would not land in the
demo router; that rule is gone. The page's two messages to us ("take this page down", "about the page") start with
fixed words and end with the page's link. The demo router knows them by those (`pageMessage` in `channels/demo.ts`):
- A takedown becomes the store's takedown request, and Today lists it.
- The other message is kept in the store's chat, handed to the operator.
- Each gets one short reply, and neither reaches the agent.

**The demo goes out by itself.** Each minute the worker sends the link to every demo asked for on the website whose
page is now public (`deliverRequested`). It goes on the demo number, inside the 23 hours after the person wrote with
the code. A page that is held back waits. One past the 23 hours stays on the operator's list, to send by hand.

**What the website promises: "within an hour".** After the code arrives:
- Detecting and reading a store takes 30 to 340 seconds (docs/milestones.md).
- The pitch page and its sample chat take about a minute on the model.
- The worker checks every minute.
- A new store can wait behind the daily re-reads, two at a time.

An hour covers all of it, with room to spare.

**Requests with nothing to send:** a store that is not on Shopify (Toran reads Shopify only), a site that could not
be read, or a page that is held back. The dashboard lists them under "ביקשו דמו באתר, ועוד אין מה לשלוח", so the
operator answers them in person.

## 2026-10-24: the owner line speaks Teder's own assistant API

Two Teder sides were built for the owner line at once: ours (a contract in docs/owner-line.md, on Teder's branch
`owner-line`) and another session's (`src/assistant/`, docs/assistant-api.md). The other one reached Teder's main
and production first, so it is the one. Toran now speaks it:
- the signature with a nonce and a direction
- the routes under `/customers/<workspace>/`
- `by` as the person, from accounts
- the edit by field (hook, sub, title, body)
- a rejection's `redo`: writing, none or paused

Teder holds its own events through the owner's quiet hours and Shabbat, so Toran no longer asks Teder whether it is
quiet. post.ready names one post, so Toran gathers them for 90 seconds and sends the whole list of posts waiting as
one numbered message. That keeps "1" meaning what the owner sees. post.published is sent inside the 24 hours only,
since it has no template. Teder's branch `owner-line` is not merged.

## 2026-10-24: WooCommerce and Wix stores are read, each from its own public source

**The change:** ingest reads WooCommerce and Wix stores into the same rows as Shopify's (`src/ingest/catalogue.ts`), so
the agent's tools, the pitch page, the dashboard and the daily re-read never ask which platform a store is on. A lead
on either platform gets a page, a "לבנות דף" button and its daily re-read, and scores 18 (WooCommerce) or 14 (Wix) for
its platform instead of 14 and 8. Konimbo, Cashcow and the rest still stop at ingest with the reason.

**WooCommerce: the Store API.** `/wp-json/wc/store/v1/products` is public (the store's own cart blocks call it), needs
no key, and gives every product with its price in the currency's minor unit, its stock, categories and permalink.
`?type=variation` lists every variation of every variable product with its parent, its own price and its own stock,
so a store of 260 products and 324 variations is read in 7 requests.
- **Alternatives:** the REST API (`/wc/v3`), which needs the owner's key; scraping product pages, one request each
  and slower by two orders of magnitude.
- **When it is off:** some stores put it behind a firewall (one answered with a 200 and a "Request Rejected" page) or
  answer it with no products. Ingest then reads the store as it reads Wix, from the sitemap, and the warnings say so.

**Wix: the products sitemap and each product page.** Wix publishes no product feed. `store-products-sitemap.xml`
lists the product pages, and each page carries the product twice: schema.org JSON-LD (name, price, stock) and Wix's
own `wix-warmup-data` JSON, which also has the options, every variant's price and stock, and the sale. The reader
takes Wix's data when it is there and the JSON-LD when it is not.
- **The cost:** a Wix product page is 1.5 to 2 MB and one request, a second apart. Ingest reads the 150 newest by
  the sitemap's lastmod and reports the rest ("the sitemap lists 1,126 products: read the 150 newest"). A store of
  150 products takes about eight minutes.
- **Stock:** Wix often reports a tracked variant as "in_stock" with quantity 0. When the product's other variants have
  counts, that 0 is read as sold out; when every count is 0, the counts mean nothing and Wix's status stands.

**Policies:** the home page's links first, then the platform's standard addresses (Shopify's `/policies/…`,
WooCommerce's `/refund_returns/`), then, off Shopify, the pages the sitemap lists whose address says shipping,
returns, terms, FAQ, contact or about. Wix and WordPress have no standard policy paths and their slugs are often
Hebrew.

**The price check** (`--verify`) reads each sampled product from a second source: WooCommerce's single-product
route, or the product page's JSON-LD.

**Tested on real stores (2026-10-24),** in a scratch database, prices checked with `verifyPrices`:

| Store | Platform | Products read | In stock | Policy pages | Prices checked | Match | Time |
|---|---|---|---|---|---|---|---|
| A | WooCommerce | 41 of 41 | 35 | 0 (the site has none) | 10 | 10 | 50 s |
| B | WooCommerce | 260 of 260 | 230 | 6 | 10 | 10 | 71 s |
| C | Wix | 148 of 196 (150 read) | 118 | 4 | 10 | 10 | 473 s |
| D | Wix | 149 of 1,126 (150 read) | 134 | 3 | 10 | 10 | 518 s |

A product C marks out of stock was checked by hand against its page ("OutOfStock", "אזל"). A fifth site, on
WooCommerce behind a firewall, fell back to its sitemap and had no products to read: it is a pickup-point service,
not a store, and ingest stopped with "the product feed is empty".

**Fixtures:** the repository is public, so the recorded responses keep their shapes (every key the Store API sends,
Wix's JSON-LD and warmup objects, WooCommerce's JSON-LD and a firewall's page) and nothing else: three fictional
stores in `examples/` (`tavlinim-ba-shuk.example`, `beit-hasabon.example`, `quiet-candles.example`), served offline by
`exampleFetcher`.

**Not done here:**
- `create_cart_link` still answers with product pages in the demo, on every platform. The live cart link differs:
  Shopify's `/cart/<variant>:<qty>`, WooCommerce's `?add-to-cart=<id>&quantity=<n>`, and none on Wix (the product
  page).
- `get_order_status` reads no platform's orders: that needs the owner's key (WooCommerce's REST API, Wix's API), which
  the demo does not have.
- A Wix site on `<user>.wixsite.com/<site>` lives under a path, and ingest reads from the host's root: not handled.

## 2026-10-25: Toran answers our own support, as a company store; only a demo turn is told it is a demo

**The demo line.** Every turn's prompt said "This conversation is a demo", and the WhatsApp channel line said "demo",
so a paying store's real customers would have been answered as a demo. Whether a turn is a demo is now per turn
(`isDemoTurn` in agent/loop.ts): a turn on one of the store's own channels (which pass `channel`) is live; the shared
demo number, the pitch builder, the CLI and the eval are demos. The note rides in the SERVER CONTEXT line, never in
the cached store block. On a live turn, `create_cart_link` gives the product pages without "in the live version",
and `get_order_status` hands the question to the store.

**A company store** (src/company.ts, docs/company.md): Toran answering for a business that sells a service. Ours
first: people who write to OpenFrequency about Toran and Teder are answered from what openfrequency.co.il says.
- **Not ingested.** Ingest needs a shop's catalogue, and our site has none. Its knowledge is one JSON file the website
  repository makes from its own config and page modules (`npm run support`), synced by `npm run company -- sync`.
  A price changed in site.config.json reaches the agent on the next export and sync.
- **What is true today wins.** The site describes the product at launch (every channel, the store's own WhatsApp,
  abandoned carts). `openfrequency-web/support.json` holds what is true today for the agent only, and its status
  list sits in the prompt above every page. The site itself is not changed: it is published when it is done.
- **Its own prompt and three tools** (get_plans, get_policy, handoff). Same voice and grounding. A person's account,
  bill or cancellation is always handed off. The guard's honest lines speak for us, and "not available yet" is not a
  stock claim.
- **Out of the sales machine:** platform and status `company`, not qualified, no workspace, left out of the funnel.
- **WhatsApp, behind TORAN_SUPPORT_STORE:** our demo number (also our public number) answers a phone with no demo as
  support, and the owner line answers a number no workspace linked. The number is an account of the support store
  with status `line`, which `accountFor` never matches, so demo codes and owners route as before. A reply from the
  inbox goes out from the number the person wrote to (it went out from the demo number before).
- **Alternatives:** a scraped "store" of openfrequency.co.il (ingest refuses a site with no products, and would have
  read the launch-day claims as facts); FAQ rows typed in the dashboard (no plans, no pages, and drifting from the
  site's prices).

## 2026-10-25: real cart links, and a store's own orders read with the owner's key

**Cart links, on a live turn** (`create_cart_link`, agent/tools.ts), from the variant ids ingest already stores:
- **Shopify:** one link for the whole cart, `https://<store>/cart/<variant>:<qty>,<variant>:<qty>`.
- **WooCommerce:** `https://<store>/?add-to-cart=<id>&quantity=<n>`, one product a link. WooCommerce core has no
  link for several products (only a grouped product's own page), so several items are several links, which fill one
  cart when opened one after another in the same browser. The id is a simple product's own or a variation's. A
  variation's id is known only when the catalogue came from the Store API, so ingest now records the source in
  `stores.config.catalogue`. Read from the sitemap, options carry JSON-LD SKUs, and a variable product is one row with
  a price range: those go to the product page.
- **Wix:** no address fills a cart, so the product pages, with the option to pick. The demo now says so too ("in the
  demo or in the live version"), instead of promising a ready cart Wix cannot make.

Every item is checked first: the product is the store's, the variant is one of its own, and it is in stock. A
product with several options and none chosen gets a question back ("which option"), not a cart. A demo turn keeps
the demo's words and its product pages.

**Order status** (`get_order_status`, src/orders.ts). The owner pastes a key that only reads orders on the store's
knowledge page ("שאלות על הזמנות"), with the steps to make one on their platform:
- **Shopify:** an Admin API access token of a custom app with `read_orders` only, plus the store's myshopify
  address, read from `/meta.json` when left out. Lookup: `orders.json?name=#<n>&status=any`.
- **WooCommerce:** a REST API key with Read permission. Lookup: `/wc/v3/orders/<n>`, checked against the order's
  `number`, else `?search=<n>` for stores that number orders with a plugin. Basic auth first, the key in the query
  when the host drops the header (HTTPS only).
- **Wix:** an API key that reads orders, plus the site id. Lookup: eCommerce's orders search by number, then the
  order's fulfillments for tracking.

The key is tried once before it is kept, so a wrong one is refused on the page. It is sealed with TORAN_SECRETS_KEY
in `order_access` (migration 012), one row a store, deleted on disconnect. A key the platform refuses later marks the
row `error`; the page says so and questions go to the owner again. The platforms are called through `app.api`
(fetch, or the tests' stand-in), not the polite fetcher: these are the store's own keys on its own API.

**Who is told.** An order is told only to whoever shows they placed it:
- an email or phone number on the order appears in the customer's own messages in this conversation (the latest
  three of each, so a message with a list of numbers proves nothing), or
- the customer writes from the order's phone on the store's own WhatsApp (Meta's number, not their word).

The tool reads these from the stored messages, never from the model's arguments, so the model cannot supply them.
A number that is not there and details that do not match get the same answer ("NO MATCH"), and the order's details
are never in it. After three of them in one conversation the question goes to the store. The answer has the status,
the shipping state and the tracking link when the platform has one, and its rule line says a delivery date or
anything else not written there is unknown.
- **Alternatives:** asking the model to pass the email (it could pass anything); answering by order number alone
  (anyone could read anyone's order); an OAuth app per platform (a review at Shopify and Wix before the first store,
  for a read the owner can grant in two minutes).

**Not done here:**
- Shopify moved new custom apps to its Dev Dashboard during 2026. The page's steps follow the admin's "Develop
  apps", and need checking against a store that creates one today.
- Wix's order number is sent to its search as a string, as its docs type it. Not tried on a live Wix site, nor any
  of the three on a live store: the tests use stand-ins shaped from the platforms' docs.
- WooCommerce's own fulfillments (a new feature) and tracking plugins other than Shipment Tracking are not read: the
  order's status stands, with no tracking.

## 2026-10-25: the guard checks claims, not only numbers

**The gap:** the guard was lexical (milestones.md, section 3). It held every price, stock level and delivery time to
the numbers in the tool results, and nothing else: "ההחזרה חינם", "שולחים גם לאילת", "החולצה מכותנה" and "כן, יש
במלאי" were held only by the prompt.

**The change:** a second pass, `src/agent/claims.ts`, on every sentence the lexical rules let through. It finds a
claim by word lists in Hebrew and English, read the way `heWord` and `termGroups` read Hebrew (up to two prefix
letters, final letters folded), and holds it to the conversation's tool results:
- **free** ("חינם", "ללא עלות", "בלי תשלום", "at no cost"): in the same sentence as what is free, with the condition
  the store wrote. "בהזמנה מעל 300 ₪ המשלוח חינם" backs "מעל 300 ₪ המשלוח חינם", not "המשלוח חינם" and not
  "ההחזרה חינם".
- **area** (a city, a region, all of Israel, abroad) and **delivery** (express, same day, a weekday, before the
  holiday, to the door, a locker): in a passage about shipping or pickup. "כל הארץ" is not Eilat.
- **return** (that a return or an exchange is possible, and its conditions: tags, original packaging, unused,
  receipt, sale items) and **warranty** (a warranty or a guarantee, and its terms).
- **payment** (Bit, PayBox, credit card, cash, instalments) and **product** (a material or a property: cotton,
  ceramic, vegan, dishwasher safe, kosher, gluten free): anywhere in the tools' text.
- **size:** a letter size, or a number beside the word for size, that the product's options do not list.
- **stock:** said of the product the sentence names, against that product's row or variant, not only "some tool
  said במלאי".

Each concept keeps its Hebrew and English forms together, so an English reply is checked against a Hebrew policy and
the other way round. **Polarity counts:** "אין משלוחים לחו"ל" backs "we don't ship abroad" and cuts "we ship abroad"
(a negation word up to two words before, a clause that opens with one, or "is not", "אינה", "לא אפשרי" after).
**A bare answer** ("כן, יש", "yes, we do") makes the claims of the customer's question.

**What is not a claim:** a question back to the customer, a sentence that says it is checking, passing it on or does
not know, a greeting, chit-chat. A cut claim is the new redaction rule `claim` (with its kind), replaced by the honest
checking line once a reply, and hands off as `unknown`, like the lexical rules.

**The customer's words** count only when they are a statement, not a question or a request, and only for payment,
returns and delivery ("שילמתי בפייבוקס" lets the reply say PayBox). "יש משלוח לאילת?" never backs "כן, שולחים
לאילת", and "אני גר באילת" does not either. A company store's "works today" list, which the agent reads in its
prompt and not from a tool, backs a claim as a tool result would, and is never a source of numbers.

**The model, behind a flag:** `TORAN_GUARD_LLM`, off by default. A cut is borderline when the tools mention its key
term, but not in a way code can confirm (the opposite polarity, another subject, a dropped condition). With the flag
on, each borderline cut (at most three a reply) goes to the model once, with the passages that mention it, and only
the one-word answer "SUPPORTED" puts the sentence back. An error or any other answer keeps the cut. The call is
recorded against the store with the tag `guard`. The tests never need it.

**Alternatives:**
- A model call on every reply that states a policy. Every answer would pay for a second call, and the check that
  matters most would depend on a model again. tiyul-plus's rule is to move a rule to where it is not a choice.
- Matching the reply's content words against the tools' text. A paraphrase defeats it both ways, and it does not
  see "not".
- Rewriting the reply instead of cutting the sentence. The guard never writes facts, it only removes them.

**Tested:** `test/claims.test.ts`, 17 tests and about 140 sentences in Hebrew and English, cut and passed, on the
fictional store's own policy pages, and a turn in `test/agent.test.ts` through the loop with the flag off and on (a
scripted model). The guard's earlier tests pass unchanged.

**Known weak spots:**
- **Cut when it is true:** a paraphrase the word lists do not join ("שבועיים" for the policy's "14 יום"); a sound
  inference ("Bit, not cash" when the store lists only Bit and card); a policy whose subject is named only in a
  passage's header while the sentence names another; a customer's "yes" question answered "כן" when the store's
  words for it are not in the lists.
- **Passed when it is not:** a claim the lists do not know (colours, care, fit, opening hours, "it suits sensitive
  skin"); "free" with no subject of its own on a page whose header names one; a negation further than the windows
  reach; a claim spread over two sentences of the reply; a store sentence with the right words in another relation
  in one clause; a condition the store wrote in another sentence ("free shipping." then "over 300 ₪.").
