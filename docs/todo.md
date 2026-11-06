# Toran: to do

Products the owner wants on Toran, for when we work on them (the owner, 2026-11-06). None is built yet. Each one
writes to a customer first, so outside WhatsApp's 24-hour window each needs a template Meta approves
(docs/whatsapp-templates.md), and each needs the store's own events (a cart, a shipment, a delivery) from its
platform.

## TODO: Abandoned carts

A WhatsApp message to whoever left the cart without paying, with the link back to it.

- Why first: the easiest of the three to sell, because the owner can see money that came back (carts recovered,
  and their total).
- Needs: the store's abandoned-cart events and the cart link (Shopify, WooCommerce, Wix); the customer's WhatsApp
  number and their consent to marketing messages (a cart reminder is advertising under the Israeli spam law, section
  30A: consent, "פרסומת" where it applies, and a way to stop); a Marketing template; one reminder per cart, never on
  Shabbat or a holiday, and stop the moment they pay.
- Report: carts reminded, carts recovered, the money recovered, per month.

## TODO: Order updates

"ההזמנה נשלחה", the tracking link, and delivered, all on WhatsApp.

- Why: it saves the store the "where's my order" questions.
- Needs: the store's fulfilment and delivery events and the carrier's tracking link; Utility templates (one per
  update); the customer can turn them off.
- Builds on: order status Toran already looks up for the person who placed the order (src/orders.ts).

## TODO: Reviews after delivery

A message a few days after delivery asking for a review; the review then shows on the store's site.

- Needs: the delivery event; a review link or a reply Toran collects; a way to publish it on the store (the
  platform's own reviews, or a review app the store uses) only with the customer's permission to show it.
- Asked once per order, never again after a no or no answer.

## TODO: A chat on the store's website

Toran answering inside the store's own site, as a chat button in the corner, beside WhatsApp, Instagram, Messenger
and email.

- Why: many customers ask while they are on the product page, and won't open WhatsApp for it.
- Needs: a small script the store adds (a Shopify app embed, a WooCommerce plugin, a Wix app, or one line of code);
  the same agent and answers as the other channels; handing over to a person in the store's inbox; the chat
  answers on the page, or moves to WhatsApp when the customer wants to continue there.
- Nothing like it exists yet: Toran's only "widget" code today detects other chat widgets on a lead's site
  (src/leads/signals.ts).
