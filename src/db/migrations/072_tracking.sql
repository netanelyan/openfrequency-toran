-- Where a package is (src/tracking.ts; the owner, 2026-11-09: "make the order tracking also work with 17track, or the
-- website's own tracking", then "lets just track trough shopify. a store that has the tracking page gets that").
--
--   stores.tracking_page  the store's own tracking page, set on its knowledge page (web/pages/orders.ts): an https
--                         address, with {number} (the tracking number) or {order} (the order number) filled in when
--                         Toran gives it. NULL: none, and Toran gives the store's tracking link.
ALTER TABLE stores ADD COLUMN tracking_page text;
