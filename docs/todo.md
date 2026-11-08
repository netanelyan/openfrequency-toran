# Toran: to do

Products the owner wants on Toran (the owner, 2026-11-06). The automatic messages themselves (an abandoned cart, a
payment, a shipment, a review request) were built on 2026-10-25 (`src/auto/`, docs/customer.md "Automatic messages");
on 2026-11-08 the owner asked to build what was still missing ("build the todo stuff we have for toran"), and this file
says, for each, what is built and what is left.

## Abandoned carts: built, with the money report

A WhatsApp message (or an email) to whoever left the cart without paying, with the link back to it: built 2026-10-25.

- **Report (2026-11-08):** carts reminded, carts recovered and the money recovered, per month (`src/auto/report.ts`).
  A cart counts as recovered when an order is placed within 7 days after its reminder went out, by the same checkout
  or the same phone or email; the money is the order's total (else the cart's), each currency apart. On the store's
  Settings (the automatic messages, "מה העגלות החזירו", three months) and on Today ("עגלות שחזרו החודש").
- **Left:** nothing. It is the reminder's share, not proof the reminder caused the order, and the page says "חזרו
  והזמינו".

## Order updates: built, and the customer can turn them off

"התשלום התקבל", "ההזמנה נשלחה" with the tracking link, and delivered: built 2026-10-25.

- **Built 2026-11-08:** the customer's page of message settings (`/u/<token>`, `src/web/unsubscribe.ts`) has a second
  choice, for the order updates, apart from the reminders; every order email ends with a quiet line to it
  (`?about=orders`). Consent scope `orders`, migration 060.
- **Left:** a WhatsApp order update has no button to that page. Adding one changes the Utility templates, which every
  store would then submit to Meta again; until then a customer reaches it from a reminder's button or an email, or
  writes "הסר" (which stops everything).

## Reviews after delivery: built, collected in the chat and shown on the store's site

A message a few days after delivery asking for a review: built 2026-10-25, with the owner's review link.

- **Built 2026-11-08** (`src/reviews.ts`, migration 061): the customer may answer the request in the conversation with a
  rating (1 to 5, or stars) and a sentence; Toran keeps it and asks once whether it may be shown with their first name;
  the owner sees it on Settings ("ביקורות שנאספו") and approves or hides it; the store's site shows the approved ones
  in a reviews block of the chat's script (`<div data-toran-reviews></div>`, `src/web/widget.ts`). Nothing is shown
  without both the customer's yes and the owner's approval.
- **Left:** publishing into the platform's own reviews. Shopify has no product reviews API of its own (its reviews
  are apps'); WooCommerce has products/reviews in its REST API, which needs a Read/Write key and the order's product:
  for later, when a store asks.

## A chat on the store's website: built

Toran answering inside the store's own site, as a chat button in the corner (`src/channels/web.ts`,
`src/web/widget.ts`, `src/web/static/chat.js`, `chat.css`, `src/web/pages/webchat.ts`).

- **Built 2026-11-08:** the owner turns it on in Settings ("צ׳אט באתר") and adds one line, `<script
  src="https://<toran>/w/<key>.js" async></script>`, with plain steps for Shopify (theme.liquid), WooCommerce (WPCode)
  and Wix (Custom Code). The chat is a frame of ours that only the store's own domains may show (CSP frame-ancestors),
  so a copied line shows nothing elsewhere. The channel `web`: the same agent and answers, the same inbox, counted in
  the plan; the owner answers from the inbox and the visitor reads it; "להמשיך בוואטסאפ" when the store's own WhatsApp
  number is connected. No cookies: the visitor is a random id in the frame's own storage. 12 messages a minute a
  visitor, 60 an address.
- **Left:** a Shopify theme app embed and a WordPress plugin (one click instead of pasting a line), and answers that
  arrive at once instead of the frame asking every few seconds. Shopify's `theme.liquid` path is from Shopify's edit-code
  article and the theme convention, not quoted from it: UNVERIFIED in their words.
