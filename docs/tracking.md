# Where is my package: order tracking

The owner, 2026-11-09: "make the order tracking also work with 17track, or the website's own tracking", and then: "lets
just track trough shopify. a store that has the tracking page gets that". No outside tracking service is asked.

When a customer asks about an order, `get_order_status` (src/agent/tools.ts) first checks the order is theirs (they
write from its phone or email, or give its phone). This part did not change. Only after that match does Toran look at
where the package is (src/tracking.ts). Before a match nothing is told.

## What Toran tells

For each shipment on the order:

- **The link**: the store's own tracking page when it has one (`stores.tracking_page`, set on the store's knowledge
  page, in the orders panel, under "יש לכם באתר דף למעקב אחרי משלוח?"), with `{number}` (the tracking number) and
  `{order}` (the order number, without `#`) filled in, URL-encoded; a page that needs `{number}` is skipped for a
  shipment that has no number. Otherwise the tracking link the order carries (Shopify `tracking_url`/`tracking_urls`,
  WooCommerce tracking plugins, Wix `trackingLink`).
- **The status in words**: the store's (Shopify's `shipment_status`; otherwise the order's own status line). The model
  is told to say it in its own plain Hebrew, with no codes or English, and never a status, place or time the result
  does not give.

When a conversation closes, the retention pass (channels/conversations.ts `withoutTracking`) removes the tracking
number and the link from the stored tool results.

## The website's tracking page setting

Only the account's owner can set it (a member sees it), and it shows once the orders are connected. It must be an
https address with a host name: no `http:`, no `javascript:`, no user:password, no `localhost`, at most 300
characters. It is kept as typed, placeholders included. Leaving it empty removes it.

## What the order already carries

- **Shopify**: fulfillments' `tracking_company`, `tracking_number` (or `tracking_numbers[0]`), `tracking_url` (or
  `tracking_urls[0]`) and `shipment_status`. These were already read; the link is now kept only when it is an
  http(s) address.
- **WooCommerce**: the order meta `_wc_shipment_tracking_items`. Both WooCommerce Shipment Tracking and Advanced
  Shipment Tracking keep their list there (docs.zorem.com: "the Shipping Tracking plugin stores the tracking
  information in the order meta with the meta key _wc_shipment_tracking_items"). Toran reads `tracking_number`,
  `custom_tracking_provider` or `tracking_provider`, and `custom_tracking_link`. A provider picked from the plugin's
  list has no link in the meta, so when a number has no link Toran asks the plugin's REST route
  `GET /wp-json/wc-shipment-tracking/v3/orders/<id>/shipment-trackings` (docs.zorem.com "Shipment Tracking API":
  `tracking_id, tracking_provider, tracking_link, tracking_number, date_shipped`). It uses the same read key and a
  4 second timeout, and a store without the route just keeps its numbers.
- **Wix**: unchanged (fulfillments' `trackingInfo`).
