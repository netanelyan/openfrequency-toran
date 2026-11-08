# The first customer, and every month after

What the operator does, in order, from a store signing up for Toran to its second month, and what to do when a
channel disconnects or a customer waits. Where to look first, always: accounts' **/admin**, signed in as the operator.
Toran's part of it comes from `GET /internal/ops` (src/ops/api.ts), and its `customers` list has one row a customer's
store (src/ops/health.ts): paid, switched on, its channels and their state, the month's conversations against its
plan, customers waiting more than a day, the month's model spend against its cap, and the last alert about it. The
alerts themselves go to the operator's WhatsApp (src/ops/alert.ts, `TORAN_ALERT_WA`) and to the log
(`journalctl -u toran | grep '\[alert\]'`).

Keys and setup are in [connecting-channels.md](connecting-channels.md) and [deploy.md](deploy.md); this page is the
routine. Costs are in [costs.md](costs.md).

## 0. Before the first one: the sign-up switch

Toran is sold in three places that must agree (src/ops/signupSwitch.ts), and Toran says at each start whether they
do (`[signup] all three agree: open`, or a loud line and an alert):

- Toran: `TORAN_SIGNUP_OPEN=1` in `/opt/toran/private/.env`. Until it is on, no pitch about Toran goes out and its
  pitch pages keep "לכתוב לתורן".
- accounts: `OF_SIGNUP=1` and `toran` in `OF_SIGNUP_PRODUCTS`.
- the website: `site.config.json` with Toran live and `signup` open for it (openfrequency-web README, the launch
  steps).

Turn the three on the same day, in the website README's order.

## 1. Sign-up and payment

- The owner signs up at accounts (`signup?p=toran&plan=store|big`), reads and accepts the contract
  (openfrequency.co.il/toran/contract), and lands on `/setup`.
- Payment is a bank transfer for now (`OF_PAYMENT_METHOD`): record it on `/admin` ("התקבל תשלום לחודש"), and the
  invoice is made in Morning. Until it is recorded, Toran answers the store's customers with "checking" and hands
  every message to the owner (the paywall, src/billing/entitlement.ts).
- Pricing and the founding offer are accounts' (its LIST_PRICES); Toran only knows the plan (store or big) and counts
  the conversations (src/plans.ts).

## 2. Setup, the first day

1. **The site.** On `/start` the owner gives the store's address. Toran proves the domain is theirs, reads the
   site (products, prices, stock, policies, FAQ), and builds the knowledge pages. A store added here starts with Toran
   **switched off** (src/golive.ts): messages on its channels wait for the owner until they switch it on.
2. **Try it.** Every store has a demo code: the owner writes to our demo number from their phone and sees Toran
   answer as their store. Nothing reaches their customers.
3. **The channels.**
   - WhatsApp, their own number, through Kapso (coexistence: the number stays in the WhatsApp Business app on
     their phone). The store's WhatsApp page sends them to Kapso's setup page; they come back connected. The number
     must have been on the WhatsApp Business app for at least 7 days.
   - Instagram and Messenger through Zernio (`TORAN_DM_PROVIDER=zernio`): their page's "לחבר", messaging permissions
     only. Meta's window names Zernio; that is expected.
   - Email: their address forwards to Toran's, or their own domain once it is proved (docs/customer.md).
   - The chat on their website: one line of script from Settings.
4. **Switch it on.** "להפעיל את תורן". From then on Toran answers on every connected channel; a question it cannot
   answer safely goes to the owner by email (src/owners/waiting.ts) and waits in the inbox.

Check the same day: the store's health row shows paid, `live`, and each channel `active`. Write to the store's
number from another phone once, and answer once from the WhatsApp Business app: the answer must appear in the inbox
and Toran must step back (Kapso's echoes are still unverified; docs/connecting-channels.md, step 2b).

## 3. The first two weeks

Today promises the owner that we read the conversations with them for two weeks. In those 14 days every customer who
waits for the owner is also an alert to the operator (`waiting:<store>`): open the conversation, see what Toran did
not know, and either answer it with the owner or add it to the store's answers ("לשמור את התשובה"). At the end of
the second week, look at the month so far in the health row: answered alone against waiting.

## 4. A customer waits

The owner gets one email for a burst of waiting customers (through accounts, kind `conversation_waiting`; at most
three a day, as accounts allows), each conversation once in 12 hours, never between 22:00 and 07:00. A health row
with customers waiting more than a day means the owner has not seen them: write to the owner.

## 5. A channel to connect again

- Kapso says a number was offboarded or disconnected: an alert (`kapso_reconnect:<store>`), the number is
  `reconnect`, and the store's page and Today ask the owner to connect it again. Deleted at Kapso: `kapso_gone`.
- Zernio says an Instagram or Messenger account was disconnected: an alert (`zernio_gone:<store>:<channel>`).
- Kapso out of credit (`insufficient_credits`): an alert (`kapso_credits`); add credit in Kapso's dashboard, or no
  store's WhatsApp sends anything.
- A store whose site was read three days ago and has nothing connected yet: an alert (`stuck:<store>`). Write to
  them and help connect.

## 6. Every month

- On the 1st from 09:00, each store's owners get last month's results by email (src/owners/reports.ts): the
  conversations, how many Toran answered alone, how many the owner fixed, the carts that came back, and the month
  against the plan.
- A store over its plan this month is an alert (`over_plan:<store>:<month>`). One busy month costs nothing more; two
  in a row and the store moves to the big plan: the move is the operator's, on the store's page, after writing to
  the owner a week before (src/plans.ts).
- A store that stopped (unpaid past the 72 hours, or taken down): three days later its Kapso number and Zernio
  accounts are disconnected (src/jobs/retention.ts), retried daily with an alert if the provider refuses; 30 days
  later its conversations are deleted.
