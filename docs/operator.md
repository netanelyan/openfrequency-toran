# The operator's dashboard

The operator is the superadmin outside view-as. Their dashboard is on accounts' `/admin` (section 4): who to write to today about
Toran or Teder, with what message; who is already in a conversation; the funnel of each product; and the customers
and the money. The leads live in Toran, which finds stores, builds their pitch pages, tracks the opens and keeps
the outreach. Teder's store demos and the accounts customers are read from those services, which are on the same
machine, at each page load. Teder's demos are copied into Toran every few minutes, so that Toran can also keep
their outreach.

```
   Toran (the dashboard) ── GET /internal/ops/customers ──▶ accounts  (workspaces, subscriptions, invoices)
                         ── GET /internal/demos ──────────▶ Teder     (the store demos and their opens)
                         ── GET /internal/leads ──────────▶ the website's lead service (its last 30 days' leads)
   openfrequency.co.il   ── POST /internal/lead {url, code, product?} ▶ Toran  (a demo request, by its REQ- code)
   Toran (the worker)    ── POST /internal/lead {url, whatsapp} ──▶ Teder  (a Teder request, once its number wrote)
   Toran (our number)    ── GET /internal/pay, POST /internal/pay/receipt ──▶ accounts  (paying over WhatsApp, section 7)
```

All seven routes are local-only. They take `Authorization: Bearer <OF_INTERNAL_TOKEN>` (the same value in every
service's `.env`, 32 characters or more), and they refuse a request that has `X-Forwarded-For`, or that comes from
a socket that is not loopback. Every answer is JSON with `Cache-Control: no-store`.

## 1. Accounts: `GET /internal/ops/customers`

This route is on accounts' internal listener (127.0.0.1:4741), beside `/internal/session` and under the same
checks. It answers every customer workspace (the operator's own has none), newest first:

```json
{
  "today": "2026-10-24",
  "workspaces": [
    {
      "id": 3, "slug": "dana-shop", "name": "Dana Shop", "disabled": false, "createdAt": "2026-10-01T09:00:00.000Z",
      "products": ["teder", "toran"],
      "people": 2, "invitesWaiting": 1, "lastLoginAt": "2026-10-23T18:00:00.000Z",
      "subscriptions": [
        { "product": "toran", "monthly": 449, "vat": "excluded", "setup": 990, "startedOn": "2026-10-01",
          "paidUntil": "2026-10-31", "endsOn": null, "state": "paid", "nextChargeOn": "2026-11-01" }
      ],
      "invoices": { "count": 2, "lastIssuedOn": "2026-10-01" }
    }
  ]
}
```

`state` is one of these:
- `paid`: the paid period covers today.
- `waiting`: started, nothing paid yet.
- `late`: the paid period ended, and the subscription has not.
- `ending`: paid, and `endsOn` is set.
- `ended`.

The states are the same as the home page's (`describe()` in `src/accounts/subscriptions.js`). `monthly` and
`setup` are ₪ before VAT when `vat` is `excluded`.

## 2. Teder: `GET /internal/demos`

This route is on Teder's site (127.0.0.1:4700), beside `POST /internal/lead` and under its checks. It answers every
store demo, newest first, at most 500:

```json
{
  "demos": [
    {
      "id": 12, "domain": "dana-shop.example", "url": "https://dana-shop.example/", "name": "Dana Shop",
      "status": "approved", "whatsapp": "972500000123",
      "pageUrl": "https://teder.openfrequency.co.il/s/dana-shop-x1y2",
      "createdAt": "...", "readyAt": "...", "approvedAt": "...", "removedAt": null, "error": null,
      "opens": 3, "visitors": 1, "lastOpenAt": "..."
    }
  ]
}
```

- `pageUrl` is the page's absolute public address while the page is public (approved, and not removed), and null
  otherwise.
- `opens` counts the page's views by anyone who is not signed in to OpenFrequency.
- `visitors` counts the distinct browsers among them, by a cookie, the way Toran counts its pitch pages.
- `error` is Teder's reason a `failed` demo was not built. Toran keeps it with the rest (`teder_leads.error`, migration
  042), for the dashboard's list of Teder demos not up yet (section 4).

## 3. The website: a demo request by its code, one per number per product

Since 2026-10-23, Toran counts a demo asked for on openfrequency.co.il only when the person writes to the demo
number with the request's code (`src/channels/request.ts`). Since 2026-10-30 the same holds for a Teder demo. The
website's part:

1. The demo form takes the store's address only. The WhatsApp number proves itself by writing.
2. `server/lead.mjs` makes a code `REQ-XXXXXX` (6 of `A-Z0-9`, random), keeps it with the lead, and hands Toran
   `{ "url", "code" }` at `/internal/lead` for a Toran demo, `{ "url", "code", "product": "teder" }` for a Teder
   one, retrying as before. `product` is `toran` when it is left out; any value but `toran` or `teder` is
   `400 { "ok": false, "error": "bad" }`.
3. It answers the form with the code and a `https://wa.me/<TORAN_DEMO_WA>?text=...` link whose message holds the
   code. The form's success state shows that button.
4. Toran does the rest: the reply on WhatsApp, and one demo per number per product.

**One demo per number per product.** A number that claimed a Toran code may still claim a Teder one, and the other
way; a second code of the same product from the same number gets "כבר קיבלנו מהמספר הזה בקשה לדמו של תורן" (or "של
תדר"), and the code is left for its own number. The owner's phone (`TORAN_OWNER_WHATSAPP`) may ask any number of
times. A pitch page's `DEMO-` code is not a request: it starts that store's demo, as many times as anyone presses it.

**A Toran code** adds the store for that number (or gives the number to a store Toran has), and the page's link goes
to it on the demo number once the page is public, inside the 23 hours (`deliverRequested`).

**A Teder code** adds nothing to Toran. The person gets "קיבלנו, תודה. אנחנו בונים עכשיו דמו של תדר ל־<domain>..." at
once, and the worker hands the request to Teder (`teder_lead` job, `handToTeder`): `POST /internal/lead` on
`TEDER_SITE_INTERNAL` with `{ "url", "whatsapp": "<the number that wrote>" }` and the internal token. A Teder that
does not answer is tried again, 8 tries in all, the last 140 minutes after the first; Teder takes an Israeli mobile only
(`9725XXXXXXXX`), so another number's handoff fails without asking Teder. Teder keeps one demo per store and answers
with it (`{ ok, id, existing }`); `demo_requests.teder_id` keeps that id. Each minute while a Teder request waits,
Toran reads `GET /internal/demos` again, and once the demo has a `pageUrl` (Teder gives one to an approved demo
only) its link goes to the number on the demo number, inside the 23 hours after it wrote, once
(`demo_requests.delivered_at`, `deliverTeder`). The first such send marks the Teder lead sent, as "שלחתי" does, so
its one reminder comes due in four days. Two numbers that asked for the same store each get its one demo. Past the 23
hours the demo stays on the list as `asked_teder`, to send by hand. Inside them, its card can also go from the demo
number at once (`direct`, `sendTederDirect`), as a Toran card can; a Teder demo asked for with a typed number (the
website's other form, straight to Teder) never can.

**Only from a number that reaches people.** The demo number sends through Meta (our number), Twilio, or the
simulator (`src/channels/lines.ts` `demoLine`). The simulator reaches nobody, so on the VPS (`TORAN_ENV=prod`) it means
our number is not connected yet: the links above wait, nothing is marked sent, the cards offer no `direct`, and the
`direct` action answers 400 "המספר שלנו עוד לא מחובר, אז ההודעה לא נשלחה ולא סומנה. אפשר להעתיק אותה ולשלוח מהוואטסאפ
שלך.". Inside the 23 hours, a link that waited goes once the number is connected. In development and the tests the
simulator is the phone.

A request with nothing to send yet is under `stuck`. A Teder one says why in its own words: "הבקשה בדרך לתדר", "תדר
לא קיבל את הבקשה" (the handoff failed every try: its job is on the queue page, to run again), "הדמו של תדר בבנייה",
"הדמו של תדר מחכה לבדיקה בתדר", "תדר לא הצליח לבנות את הדמו" or "הדמו של תדר הוסר"; its `storeId` is null.

## 4. Where the dashboard lives: accounts' /admin

The operator's dashboard is on accounts' `/admin`, the superadmin's console, behind its password and authenticator
code. toran.openfrequency.co.il shows Toran only. Toran keeps the work behind the dashboard:
- the list of who to write to, and the outreach on each lead
- the copies of Teder's demos
- sending a demo asked for on the website by itself, Toran's or Teder's

It gives all of that to `/admin` through two internal routes, under the same checks as `/internal/lead` (OF_INTERNAL_TOKEN,
loopback, no `X-Forwarded-For`). Accounts reaches Toran at `OF_TORAN_INTERNAL` (default `http://127.0.0.1:4710`).

### `GET /internal/ops`

```json
{
  "teder": { "ok": true },
  "items": [
    { "key": "toran:12", "product": "toran", "id": "12", "reason": "tried_demo", "rank": 100, "name": "...",
      "domain": "...", "why": "ניסו את הדמו", "message": "...", "target": { "kind": "whatsapp", "href": "https://wa.me/...",
      "label": "להעתיק ולפתוח וואטסאפ" }, "direct": false, "mark": "reminded", "page": "https://...", "at": "...",
      "leadUrl": "https://toran.openfrequency.co.il/lead/12" }
  ],
  "noContact": [{ "id": 31, "name": "...", "domain": "...", "score": 71, "leadUrl": "..." }],
  "stuck": [{ "product": "toran", "domain": "...", "phone": "9725...", "at": "...", "why": "...", "storeId": 7, "message": "...",
    "target": { "kind": "whatsapp", "href": "https://wa.me/9725...?text=...", "label": "להעתיק ולפתוח וואטסאפ" }, "leadUrl": "..." }],
  "tederDemos": [{ "id": "14", "domain": "...", "name": "...", "status": "failed", "why": "לא נבנה", "error": "...",
    "whatsapp": "9725...", "at": "...", "message": "...", "target": { ... }, "leadUrl": "https://teder.openfrequency.co.il/demos/14" }],
  "leads": { "ok": true, "waitlist": [{ "id": 31, "contact": "9725... or an email", "store": null, "page": "/toran", "at": "..." }],
    "failed": [{ "id": 32, "product": "teder", "source": "teder", "store": "...", "contact": "9725...", "page": "/teder", "at": "..." }] },
  "conversations": [{ "key": "teder:7", "product": "teder", "id": "7", "name": "...", "domain": "...", "replied_at": "...",
    "next_step": "...", "next_step_at": "...", "target": { ... }, "page": "...", "status": "...", "leadUrl": null }],
  "funnels": { "toran": [{ "key": "found", "label": "נמצאו", "all": 12, "month": 3 }], "teder": [ ... ] },
  "ourNumber": { "number": "9725...", "status": "active", "roles": [{ "key": "demo", "he": "..." }], "leadUrl": "..." },
  "demoLine": { "live": true, "via": "meta", "number": "9725..." },
  "jobs": { "queued": 0, "running": 0, "messages": 0, "oldestAt": null, "failed": 0, "url": "..." }
}
```

- `items` is already in its order (src/ops/queue.ts says why).
- `reason` is one of reconnect, tried_demo, next_step, asked_toran, asked_teder, reminder, teder_reminder, first_send.
  `reconnect` (rank 110, first) is a store that has Toran whose WhatsApp has to be connected again: its Meta token
  ends within 10 days or has ended (docs/connecting-channels.md, step 2). Its message asks them to, with the link, and
  its `page` is the store's WhatsApp page. Its `mark` is sent: on such a store, "שלחתי" records that they were told,
  and the card comes back after three days while the number still waits.
- `target.href` opens the chat (`https://wa.me/<number>?text=<the message>`) or the mail (`mailto:<address>?subject=...&body=<the
  message>`) with the card's message already written in it; a card with no message (a next step) opens the chat alone.
- `mark` says what "שלחתי" records: sent, reminded, or next (a next step: no message; its card offers the next-step
  form).
- `direct` means the message can go out now from the demo number (the `direct` action): inside the 23 hours, and
  while our number is connected (section 3).
- `leadUrl` is the lead's page on Toran's dashboard, and null for a Teder lead.
- Each `stuck` request has a `message` for its reason, from the operator's own WhatsApp (`src/ops/messages.ts`): still
  being built ("...הוא עוד בבנייה, ונשלח לכם את הלינק כשיהיה מוכן."), could not be built, Teder included ("...ולא
  הצלחנו לבנות אותו. אם יש שאלה, אפשר לענות כאן."), or a platform Toran does not read; null for a Teder demo taken
  down. Its `target` is the number that asked, with the message written in. A Teder one's `leadUrl` is its demo in Teder
  once Teder took it.
- `tederDemos` is every Teder demo of the last 30 days that is not up yet (`src/ops/queue.ts` `tederDemos`), failed ones
  first: `status` new or building ("בבנייה"), ready ("מחכה לבדיקה בתדר": drawn, waiting for the operator in Teder) or
  failed ("לא נבנה", with Teder's `error`). A failed one with a number has the message "היי, כאן OpenFrequency. ביקשתם
  באתר דמו של תדר ל<store>, ולא הצלחנו לבנות אותו. אם יש שאלה, אפשר לענות כאן." and a `target` with it; the others
  open the chat alone (or nothing, with no number). `leadUrl` is the demo's page in Teder, `TEDER_URL`/demos/<id>
  (`TEDER_URL` is Teder's public address, default `https://teder.openfrequency.co.il`, the same setting as accounts').
  A demo a `stuck` request already lists (asked with a code, its link not sent) is left out, and an approved one is an
  `asked_teder` card once it has its page.
- `leads` is what reached the owner only by email until now, from the website's `GET /internal/leads` (openfrequency-web
  `server/lead.mjs`, on `OF_WEB_INTERNAL`, default `http://127.0.0.1:4720`, with the internal token; read at each load,
  `src/ops/sources.ts` `websiteLeads`): `waitlist`, Toran's waitlist of the last 30 days (a phone or an email, the store
  when one was given), and `failed`, every lead a product should have taken (`product` toran or teder) and has not, 10
  minutes after it came (the website tries again every 5). No message for either: Toran is not open, and a hand-off
  that failed needs the operator first. `ok` is false, with both lists empty, when the website did not answer.
- The funnels' last stage, `customers`, comes with `all` and `month` as null: accounts fills it from its
  subscriptions.
- `ourNumber` is our one WhatsApp number once our company store connected it, and null before. `demoLine` is the demo
  number as it sends now (`src/channels/lines.ts` `demoLine`): `via` meta, twilio or sim, its `number` when known, and
  `live`, false on the VPS while it is the simulator (section 3). /admin shows it as one line at the top.

### `POST /internal/ops/<toran|teder>/<id>/<action>`

The body is JSON `{ "by": "<the operator, for the audit>", "text": "...", "days": 1, "reason": "price" }`, with only
what the action takes.

| action | does |
|---|---|
| sent | the first message went out |
| reminded | the one reminder (or the question after a demo) went out |
| direct | sends the demo link on the demo number now, then records sent: a Toran page asked for on the website inside its 24 hours, or a Teder demo asked for with a code inside the 23 hours after its number wrote; never a Teder demo asked for with a typed number (that number never wrote to us); only while our number is connected |
| replied | they answered |
| next | `text` and `days`: the next step |
| later | `days` 1 or 7 |
| lost | `reason`: not_interested, price, has_solution, no_answer, not_fit or other |
| reopen | undoes lost and later |
| pilot, paid | Toran only |
| won | Teder only |

It answers `200 { "ok": true, "message": "<Hebrew line for the operator>" }`, or `400 { "ok": false, "error":
"<Hebrew line>" }` for an action the rules refuse (a second reminder, a link past its 24 hours).

## 5. The setup checklist: `GET /internal/setup?workspace=<id>`

A new customer signs up on accounts (accounts.openfrequency.co.il), and accounts has one checklist page for the new
workspace, `/setup`. It asks each product for the workspace's steps and shows them; each step's button opens the
product's own page, where the customer does it (the session cookie is shared across `*.openfrequency.co.il`, so the
link arrives signed in). Teder answers the same contract. Toran's is `src/setup.ts`, under the same checks as
`/internal/ops` (the token, loopback, no `X-Forwarded-For`); a workspace id that is not a positive integer is 400.

```json
{
  "product": "toran",
  "ready": false,
  "steps": [
    { "key": "store", "title": "מוסיפים את החנות", "status": "done", "detail": "",
      "href": "https://toran.openfrequency.co.il/lead/12/knowledge", "required": true },
    { "key": "whatsapp", "title": "מחברים את הוואטסאפ", "status": "working",
      "detail": "המספר ממתין לאישור של Meta. תורן יתחיל לענות בו לבד.",
      "href": "https://toran.openfrequency.co.il/lead/12/whatsapp", "required": true }
  ]
}
```

- `status` is one of `todo`, `working`, `done`, `attention`, `soon`. `detail` is one short Hebrew line, or "".
  `href` is absolute, on `PUBLIC_BASE_URL`, or null when there is nothing to open yet.
- `ready` is true when every `required` step is `done`: the store and WhatsApp.
- The steps, in this order, about the workspace's first store (a workspace has one for now):

| key | required | from |
|---|---|---|
| `store` | yes | none yet: todo, href `/start`. Its add or its reading queued or running: working. Read: done. A platform Toran cannot read, or the last try failed: attention (href `/start` while there is no store) |
| `knowledge` | no | "בודקים את התשובות", `/lead/<id>/knowledge`: done once someone of the workspace opened it after the site was read (`stores.knowledge_seen_at`, migration 021; not the operator, not view-as), or wrote an answer of their own |
| `whatsapp` | yes | the store's Meta account: pending working, active done, error or reconnect attention; soon while the server cannot connect a number (`waConnectReady`) |
| `email` | no | only when `TORAN_CHANNELS` lists it; soon without a mail provider; Settings `#channels` |
| `messenger`, `instagram` | no | only when `TORAN_CHANNELS` lists them; soon until `socialReady`; `/lead/<id>/<channel>` |
| `orders` | no | the order key on the knowledge page (`#orders`): active done, refused attention; soon on a platform whose orders Toran does not read |
| `auto` | no | Settings `#auto`: done once any automatic message is on |

Until the store exists, every step after it is `todo` with `href: null` and the detail "אחרי שהחנות מוכנה". A
workspace Toran has never heard of is a brand-new one and answers that way too: it is never an error.

## 6. When the message path fails: the queue, alerts, caps, retention, deletion

What keeps a customer's message from being lost or delayed without anyone knowing (the readiness audit's PRA-BE-001 to
-009, PRA-DB-004 to -007, PRA-AI-004 and -007):

- **The worker's loops.** `TORAN_MESSAGE_LOOPS` (2 by default) take customers' messages (`wa_inbound`, `mail_inbound`,
  `dm_inbound`, and the owners' own `wa_echo` and `dm_echo`) and nothing else; `TORAN_BACKGROUND_LOOPS` (1) take the
  rest (ingest, re-scrapes, the automatic messages). A customer's second message is not taken while their first runs
  (src/jobs/queue.ts `claim`), so no loop waits on a conversation. A running job's lease is three minutes and is
  refreshed every minute; at start, jobs another boot left running go back to the queue at once. More loops answer
  more people at once but hold more turns in memory: Toran runs at its `MemoryMax=1100M` (SERVER-FACTS.md), so lower
  `TORAN_MESSAGE_LOOPS` if memory is short. The default is 2, as many loops as the whole worker had before, because the
  cost of more is not measured: raise it once `systemctl show toran -p MemoryPeak` after a busy day leaves room.
- **A turn's deadline.** 60 seconds (`TORAN_TURN_DEADLINE_MS`); each model call gets what is left, at most 30 seconds,
  and one retry. Past it the customer gets the "checking" line and the owner a handoff.
- **A send that fails** is retried by the job: the answer already written is sent again, only its parts that did not go
  out, with no model call, inside the reply window. **UNVERIFIED:** a send that timed out after the provider accepted
  it is sent again (no idempotency key goes to Twilio, Meta or Resend); a customer may then get one part twice.
- **A message that fails every attempt** goes into its conversation with a handoff ("תורן לא הצליח לענות להודעה
  הזו..."), the operator hears of it, and it is listed on **the queue page**, `/admin/toran/queue` (Toran's `/queue`,
  the operator's only): what waits, how long the oldest customer message has waited, and the failed jobs of the last
  14 days, each with "להריץ שוב". `GET /internal/ops` carries the same counts as `jobs`.
- **Alerts** (src/ops/alert.ts): a lost message, a customer message waiting over 5 minutes, a store at 80% or past its
  cap, the cap over every store, a store spending over `TORAN_STORE_HOUR_ALERT_USD` ($5) in an hour, a store past
  `TORAN_STORE_TURNS_PER_HOUR` (200) answers or `TORAN_NEW_SENDERS_PER_HOUR` (30) new email senders in an hour. Each
  goes to the log, and to `TORAN_ALERT_CMD` or `/usr/local/bin/of-alert` when it exists. **UNVERIFIED:** of-alert is
  not on the server as of 2026-10-29 (SERVER-FACTS.md); check with `ls -l /usr/local/bin/of-alert`. Until it is, an
  alert is a log line only (`journalctl -u toran | grep '\[alert\]'`).
- **Spend caps** (src/agent/spend.ts): each store's month against its plan's conversations, twice, at $0.25 each
  ($150 for 300, $750 for 1,500; the operator's `stores.config.capUsd` replaces it), beside `TORAN_MONTHLY_CAP_USD`
  over every store. Past the store's cap only that store hands off.
- **Retention** (src/jobs/retention.ts), once an Israel day, one `retention` event with its counts:
  - a store's customers' conversations, messages, files, customers' contact details, automatic messages' log and
    events: deleted 30 days after its service stopped (no channel on, its page taken down, or `markServiceStopped`
    from the paywall); its opt-outs stay
  - leads, 6 months after the last contact: website demo requests, Teder's demos as Toran keeps them (unless won),
    chats on the demo number with a store that is no customer's
  - finished jobs' payloads emptied after 7 days, finished and failed jobs deleted after 30
  - the automatic messages' log 90 days after it was written, events after 13 months, the owner line's duplicate
    guard after 30 days; conversations silent for 14 days are closed, and the tracking numbers and links an order
    lookup gave are taken out of them
  - The 90 days and 13 months are Toran's own; the privacy page (openfrequency-web) states only the leads' 6 months
    and the conversations' 30 days, so it should state these too.
- **Our support's re-read of the site** (src/jobs/reread.ts), with `TORAN_SUPPORT_EXPORT_URL` set: once an Israel day
  and soon after each start, one `company_reread` event and one `[reread]` log line (`journalctl -u toran | grep
  '\[reread\]'`). The store is synced only when the site's /support.json changed, and a failed read changes nothing
  in it (docs/company.md, "It re-reads the site by itself").
- **Deleting a workspace**: `POST /internal/workspaces/<id>/delete` (src/erase.ts), as accounts' contract has it
  (openfrequency-accounts `docs/contracts/workspaces-delete.json`): 200 `{ ok: true, deleted: {...} }` with what it
  deleted, 200 with every count 0 when nothing was there; 401 `bad_token` without the right token; 503
  `not_configured` when `OF_INTERNAL_TOKEN` is unset or short here; 403 from anywhere but this machine. accounts reads
  only the status and treats anything but a 2xx as a failure.

## 7. Paying over WhatsApp: a PAY code and its receipt

Payment is a bank transfer that you record in accounts' `/admin`. Accounts gives each customer a "לתשלום בוואטסאפ"
button that opens WhatsApp to our number with `היי, אני רוצה לשלם על המנוי של <business>. PAY-XXXXXX` filled in.
Toran's part is `src/channels/pay.ts`, read on our number right after a `REQ-` code (docs/company.md, the table), and
on a separate owner line before the assistant. Toran never records money and keeps no amount, no bank details and no
file: accounts has them.

1. **The code.** Toran asks accounts `GET /internal/pay?code=PAY-XXXXXX` (the internal token, as for the owner
   routes; 3 seconds) and answers in one message: the total with VAT (`1,746.40 ₪`, as accounts writes it),
   accounts' `summary` lines without those that say the total again (one with "סך הכול", or with the total itself),
   so the amount is read once, and `payHow`, the transfer's details. The phone then waits for its receipt for 7 days
   (`pay_waits`, one row a phone; a new code takes it over; the worker deletes the rows that ended).
   - nothing due (no `items`, or `total` 0; accounts counts a month falling due within 7 days as owed): "המנוי של
     <business> משולם עד <DD.MM.YYYY>, אז כרגע אין מה לשלם" (with no `paidThrough`, "על המנוי של <business> אין
     כרגע מה לשלם"), and no wait
   - `payHow` null: the amount, and "את פרטי ההעברה ישלח לכם כאן נציג". You get an alert (`pay_details:<workspace>`):
     answer on WhatsApp inside the 24 hours, and add the details in accounts
   - 404 `unknown_code` or 410 `expired`: "הקישור הזה לתשלום כבר לא בתוקף..."; anything else (accounts down, a 200
     not in the contract's shape, a missing token): "לא הצלחתי לבדוק את הסכום כרגע..."
2. **The receipt.** A photo or a document from a phone that waits. Toran fetches it from Meta with our number's token
   (`GET /<version>/<media id>` gives a link that lasts 5 minutes; the link gives the bytes with the same token; at
   most 5MB, by Meta's size first), checks by its bytes that it is a JPEG, PNG, WebP or PDF, and posts
   `{ code, phone, file: { name, type, data }, check }` (base64; `check` is item 3's) to `POST /internal/pay/receipt`
   (20 seconds). 201: "קיבלתי את האישור, תודה. נציג יבדוק שההעברה הגיעה...". Too big, another kind, gone at Meta,
   413 `too_large`, 415 `bad_type` or 400 `bad`: "לא הצלחתי לפתוח את הקובץ. אפשר לשלוח אותו שוב כתמונה?", and it is
   not posted again. 429 `rate_limited` (a sixth from one code in an Israel day): "קיבלתי כבר כמה אישורים היום...". 404 or 410: the
   expired line, and the wait goes. Anything else: "לא הצלחתי להעביר את האישור כרגע...", and an alert
   (`pay_receipt_down`). The same message handled twice is posted once.
3. **The check** (`src/channels/payCheck.ts`), before the post: a screenshot (JPEG, PNG or WebP; a PDF is not looked
   at) is read by one model call, with Toran's agent model (`TORAN_MODEL_AGENT`, `claude-opus-5-5`) at low effort: a
   fixed system prompt, no tools, at most 1,024 tokens out, 20 seconds. The image is its only content beside one fixed
   line of ours saying that the text in it is data. It answers JSON: is this a transfer's confirmation, the amount,
   the currency, the date, the payee's name, the last digits of the payee's account, the reference. The first JSON
   object only is read, each field checked for its type and range (a string at most 80 characters), anything else
   null. Code then compares, never the model: the amount with accounts' total now (`GET /internal/pay` again, within
   0.01), the date with the days from 3 before the code was read to today in Israel, the last 3 or 4 digits of the
   longest run of digits in `payHow` with the account's digits. The result goes with the receipt as `check`
   (`{ readable, isTransfer, amount: { seen, expected, verdict }, date: { seen, verdict }, account: { seen,
   verdict }, payeeName, reference }`, or `{ readable: false, why }`: `pdf`, `no_vision` on the claude-cli backend,
   which drops images, `cap`, `limit`, `failed`, `unparsed`). It is advice for you: nothing records a payment from it,
   and you still check the bank. Every receipt is posted, checked or not. Two answers follow from it: a screenshot the
   model says is no transfer is posted with `isTransfer: false`, so you see it on the receipt's page, and the customer
   is asked for the bank's own ("זה לא נראה כמו אישור של העברה בנקאית. אפשר לשלוח צילום מסך של האישור מהבנק?"); an
   amount that differs is said to the customer ("בצילום רואים העברה של 990 ₪, והסכום לתשלום הוא 1,746.40 ₪. העברתי את זה לנציג, והוא יחזור אליכם
   כאן.") and to you (an alert, `pay_mismatch:<workspace>`): answer on WhatsApp inside the 24 hours. The payee's name
   and the reference are never said to the customer, and nothing the model read reaches another model call. Its cost
   is our support store's, with the tag `pay_check`: about 4,000 to 5,000 tokens in for a phone screenshot and a few
   hundred out, about $0.02 to $0.04 a check at Opus 5.5's prices (UNVERIFIED until the first real ones are in
   `usage`). It keeps to the agent's caps (`agent/spend.ts` `capFor`): past `TORAN_MONTHLY_CAP_USD`, or past our
   support store's own cap, it is skipped (`cap`); and to 5 checks a phone an Israel day (`limit`). Either way the
   receipt is still posted.
4. **What goes on as before.** A text from a phone that waits (support, a demo, the owner's assistant), a file from a
   phone that does not wait, a sticker, a voice note or a video. Only our number on Meta fetches a file: on Twilio a
   photo carries none.
5. **What is kept.** Events `pay_code` (`outcome`: ok, nothing_due, no_details, unknown, expired, unavailable) and
   `pay_receipt` (sent, unreadable, refused, too_many, gone, unavailable), and an audit row `pay_receipt`
   with the code, the workspace, the file's kind and size, the check's verdicts and amounts, and accounts' id. Never the
   transfer's details, the payee's name, the reference or the file.
