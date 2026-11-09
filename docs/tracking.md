# Where is my package: order tracking

The owner, 2026-11-09: "make the order tracking also work with 17track, or the website's own tracking."

When a customer asks about an order, `get_order_status` (src/agent/tools.ts) first checks the order is theirs (they
write from its phone or email, or give its phone). This part did not change. Only after that match does Toran look at
where the package is (src/tracking.ts). Before a match nothing is looked up, 17track included.

## What Toran tells

For each shipment on the order:

- **The link**, the first one that exists:
  1. the store's own tracking page (`stores.tracking_page`, set on the store's knowledge page, in the orders panel,
     under "יש לכם באתר דף למעקב אחרי משלוח?"), with `{number}` (the tracking number) and `{order}` (the order number,
     without `#`) filled in, URL-encoded. A page that needs `{number}` is skipped for a shipment that has no number.
  2. the tracking link the order carries (Shopify `tracking_url`/`tracking_urls`, WooCommerce tracking plugins, Wix
     `trackingLink`).
  3. `https://t.17track.net/en#nums=<number>` for the tracking number.
- **The status in words**: 17track's when the server has a key and 17track has a status, otherwise the store's
  (Shopify's `shipment_status`; otherwise the order's own status line).
- **The carrier's last update** (17track only): its description, place and time in Israel time. The model is told to
  say it in its own plain Hebrew, with no codes or English, and never a status, place or time the result does not give.

When a conversation closes, the retention pass (channels/conversations.ts `withoutTracking`) removes the tracking
number, the link and the carrier's last update from the stored tool results. `tracking_cache` rows are deleted 30 days
after they were last checked (jobs/retention.ts).

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

## 17track

Turned on by `TORAN_17TRACK_KEY` on the server. Without it nothing is sent to 17track and only the link is given.

Verified from the official docs, https://api.17track.net/en/doc (read 2026-11-09):

| What | The docs |
|---|---|
| Version and base | `https://api.17track.net/track/v2.4` ("V2.4 API is not backward compatible") |
| Endpoints used | `POST /register`, `POST /gettrackinfo` (also listed: changecarrier, changeinfo, stoptrack, retrack, deletetrack, getquota, gettracklist, getRealTimeTrackInfo) |
| Key | header `17token: <Security Key>`, `Content-Type: application/json`; the key is in the dashboard under Settings |
| Body | a JSON array, e.g. `[{"number": "RR123456789CN"}]`; `carrier` is optional ("the tracking numbers of most UPU and commercial carriers can be auto-identified") |
| Number format | "a combination of 5 to 50 characters including letters, numbers, or dashes" |
| Limits | 40 numbers a call, 3 requests a second (429 above) |
| HTTP codes | 200, 401 (incorrect key, IP not in the whitelist, or account disabled), 404, 429, 500, 503 |
| Answer | `{"code": 0, "data": {"accepted": [...], "rejected": [{"number", "error": {"code", "message"}}]}}` |
| Errors used | -18019901 already registered; -18019902 not registered yet, register first; -18019903 carrier not detected; -18019907 daily limit; -18019908 quota ran out; -18019909 no tracking info at the moment; -18019910 carrier code incorrect; -18019911 cannot be registered now; -18010012 format invalid; -18010001 IP not in the whitelist; -18010002 invalid key |
| Registration | required before gettrackinfo |
| Track info | `accepted[].track_info.latest_status {status, sub_status, sub_status_descr}`, `latest_event {time_iso, time_utc, time_raw, description, description_translation, location, stage, sub_status, address {country, state, city, street, postal_code}}` |
| Main statuses | NotFound, InfoReceived, InTransit, Expired, AvailableForPickup, OutForDelivery, DeliveryFailure, Delivered, Exception |
| Timing | "returned within seconds after the tracking number is registered (sometime it may go over 5 minutes)" |
| Quota | "Each tracking number counts as one shipment. No duplicate charges will be incurred during the automatic tracking period." From 2026-01-07: "New accounts registered after January 7, 2026, will receive a one-time allocation of 200 free order numbers" (the monthly 100 stopped) |
| Translation | `lang` exists (Hebrew `he` is listed), but a translation "will consume one quota", so Toran does not send it and puts the carrier's words into Hebrew itself |

How Toran uses it (src/tracking.ts `track17`):

- A number is registered only when a customer asks about that order, never in bulk, so quota goes only on real
  questions. A number already registered is only read.
- The answer is cached per number in `tracking_cache` (migration 072): 45 minutes when 17track had a status, 5 minutes
  while it has none yet (just registered, NotFound, -18019909), and 6 hours when 17track refuses the number (format,
  carrier, daily limit, quota), so it is not asked again and again.
- Each call has a 4 second timeout. Up to 3 shipments an order are looked up, in parallel. If anything fails (down,
  slow, 401, 429, an unexpected answer) the result is "no status", one log line, and the reply still goes with the link
  and the store's status. Nothing is thrown.
- A number that is in the cache but that 17track says is not registered (-18019902) is registered again once.

Not in the API docs (UNVERIFIED there):

- The public link `https://t.17track.net/en#nums=<number>`: 17track's own tracking page reads `nums` from the hash
  (comma-separated) and writes `window.location.hash = "nums=..."` itself (its production script, checked
  2026-11-09). `t.17track.net/he` answers with the English page, so the link uses `/en`.
- The body of a 401: the docs show none. Any answer that is not `code: 0` with `data` is treated as no status.
- WooCommerce: `formatted_tracking_provider`, `formatted_tracking_link` and `tracking_link` inside the meta are read
  in case a plugin version keeps them there. The docs show them only in the REST route's answer.

## What the owner does

1. Optional, for status in words: open a 17track API account (api.17track.net), copy the Security Key from Settings
   in the dashboard, and put it in `TORAN_17TRACK_KEY` on the server. If the dashboard's IP whitelist is on, add the
   server's address. The 200 free numbers are given once; after that 17track sells quota.
2. Optional, per store: in "מה תורן יודע", in the orders panel, paste the store's tracking page with `{number}` or
   `{order}`.
