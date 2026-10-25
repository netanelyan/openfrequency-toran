# The customer's dashboard

A store owner who pays for Toran signs in through openfrequency-accounts and lands on toran.openfrequency.co.il. What
they see there is what openfrequency.co.il/toran sells them, page by page. The operator (the superadmin outside
view-as) keeps their own dashboard: leads, the review queue, the follow-ups, a lead's page and the outreach. The
superadmin viewing a workspace as its customer sees the customer's dashboard, read-only.

## What the website promises, and where it is

| On openfrequency.co.il/toran | In the dashboard |
| --- | --- |
| Answers on WhatsApp, Instagram, Messenger and email | Today and Settings list the four channels for each store: connected (with the address), on our demo number with its code, or "בקרוב". Connecting the store's own WhatsApp number through Meta is not built yet, and the page says so. |
| All the conversations in one inbox, each with its channel and what happened: "ענה לבד", "מחכה לכם", "תיקנתם" | `/chats`: one list with a channel chip and the state, filtered by state and by channel (`src/web/inbox.ts`). A chat on our shared demo number is tagged "דמו". |
| What it answers alone, and what it leaves to you | `/lead/<id>/knowledge` lists both, word for word as the website does. With the store's orders connected, "where is my order" moves to what it answers alone. |
| Order status answered automatically | "שאלות על הזמנות" on `/lead/<id>/knowledge` (`src/web/pages/orders.ts`): the account's owner pastes a key that only reads orders (Shopify, WooCommerce or Wix, with the steps to make one), tried before it is kept and sealed with `TORAN_SECRETS_KEY`. An order is told only to a customer who gave its email or phone (docs/decisions.md, 2026-10-25). |
| When the site has no answer it says it is checking and sends you the question; what you answer it remembers | A handed-over conversation waits on Today and in the inbox. Answering it from the chat has a "לשמור את התשובה" box (on by default), with the question editable; the answer becomes an FAQ with the conversation's id, and the agent prefers it to the site. "טיפלתי בזה" clears it without an answer. |
| Two plans by conversations a month: חנות up to 300, חנות גדולה up to 1,500 | `/plan`: the store's plan, this month's conversations against it, the two months before, and the website's rule for moving. The header shows the month's conversations where the operator sees tokens. |
| Abandoned-cart reminders included | "הודעות אוטומטיות" in Settings (`src/web/pages/auto.ts`, `src/auto/`): the cart, the payment, the shipping and a review request, each off until the account's owner turns it on, with the exact text shown. The plan lists the cart and the other three as on, with their channels, or "כבוי, מפעילים בהגדרות". Below. |
| The first two weeks we go over the conversations with you | A banner on Today, and a line in the plan, until 14 days after the store's first channel was connected. |
| No commitment; to stop, write to us; the conversations are kept 30 days so you can export them | `/plan#stop`: the website's text, a WhatsApp link to OpenFrequency (`TORAN_OWNER_WHATSAPP`), and `/export/conversations.csv` for the account's owner. |
| The owner asks Toran about the store | `/assistant`, unchanged. |

The price, the founding offer, the setup fee, the invoices and the people in the account are accounts'. Toran never
quotes a price to a customer; `/plan` and `/settings` link to accounts for them.

## What counts as a conversation

`src/plans.ts`. A conversation counts in a month when a customer wrote in it that month, on one of the store's own
channels: a conversation with a `channel_accounts` row (the store's email address now, its WhatsApp number once
Meta connects it). Conversations on the shared demo number never count. A WhatsApp conversation is one customer
until a week of silence; an email conversation is one thread. Months are Israel's.

Moving plans is the operator's: the store's page has a "החבילה של הלקוח" select (`POST /lead/<id>/plan`, stored as
`stores.config.plan`). The customer's plan page says when a move is due by the website's rule (two months in a
row over the plan, or two months under 300 on the big plan). Nothing moves a store by itself, and nothing changes
the price in accounts.

## Automatic messages

The one place Toran writes to a store's customer who did not just write (docs/decisions.md, 2026-10-25). Each kind is
off until the owner turns it on in Settings, and each sends only about what happened at the store after it was turned
on:

| Kind | What goes out | Category on WhatsApp | When |
| --- | --- | --- | --- |
| עגלה נטושה | one reminder with the link back to the cart | marketing | the delay the owner picks after the checkout (an hour by default) |
| תשלום | the payment arrived, is waiting (a bank transfer, a payment the store confirms), or failed with the link to try again | utility | at once |
| משלוח | the order left, with its tracking link; it arrived, where the carrier says so | utility | at once |
| בקשה לביקורת | one request, with the link the owner gives | marketing | days after the delivery (the owner picks; 3 by default), or after the shipping plus two days where the platform never says delivered |

**Where it comes from:** the store's platform, read with the key the owner already connected for orders
(`order_access`). Shopify's webhooks once the owner pastes the custom app's API secret key (it signs them);
WooCommerce's webhooks when the key has Read/Write; Wix has none for an API key. Otherwise, and behind the webhooks
every hour, the worker reads the orders and checkouts that changed every 15 minutes. The page says which, in plain
words, and when the key cannot read abandoned checkouts.

**Which channel:** WhatsApp first, from the store's own connected number (never our demo number), once Meta approved
the kind's templates on the store's WhatsApp account: "לשלוח את התבניות לאישור של Meta" submits them, and each one's
state shows. Else email, from the store's email channel. The phone or the email is the one on the order or checkout.

**The rules, in code (`src/auto/send.ts`):**
- the cart and the review only to a customer who agreed at the store's checkout (`auto_consent`, with its source);
  payment and shipping to the order's own phone or email
- never at night (21:00 to 09:00 Israel time), on Shabbat or a holiday, or the afternoon before one: it waits
- "הסר" or "STOP" from the customer stops all of them, answered with one line; a message from the customer drops a
  cart reminder or a review request still waiting
- one cart reminder a checkout, none once an order is placed, nothing twice for the same event, no cart or review to
  the same person twice in a day

**In the inbox** each message is in the customer's conversation, marked "הודעה אוטומטית". It counts nothing toward the
plan until the customer answers it. The latest eight, sent or not and why, are listed under the kinds.

**Cost:** Meta bills each template to the store's own WhatsApp account, so the page says a payment method must be on
it. Email costs the store nothing more.

## Where a conversation stands

`src/web/inbox.ts`, in SQL over `conversations c`:

- **מחכה לכם**: a handoff after the owner last answered or marked it handled, or the agent is paused (the owner
  took the conversation) and the customer wrote again since. Automated mail never makes a conversation wait.
- **תיקנתם**: the owner answered in it.
- **ענה לבד**: everything else.

"טיפלתי בזה" sets `conversations.settled_upto` to the conversation's last message id (migration 010).

## Who may do what

`src/web/server.ts`:

- A customer opening an operator page (`/leads`, `/review`, `/followups`, `/brand`, `/job/<id>`, `/lead/<id>`,
  `/lead/<id>/review`) is sent to `/`, or for a store's page to `/lead/<id>/knowledge`. Another workspace's store is
  still "not found" first.
- Selling a store is the operator's on a customer's own store too: build, approve, unapprove, take down, sent,
  reminder sent, skip, status, notes, the sample chat, the brand, the plan, approve-all and `/ops/*` answer 403.
- A customer changes their own store's answers, policies' text, products' corrections and email channel, answers
  their customers, and asks their assistant.
- The export is for `client_owner` (and the superadmin); a `client_member` gets 403 and no link.
- Connecting and disconnecting the store's orders is the same: a `client_member` sees whether they are connected.
- So are the automatic messages: a `client_member` sees each kind and its text, and changes none of it.
