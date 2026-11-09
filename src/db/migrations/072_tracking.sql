-- Where a package is (src/tracking.ts; the owner, 2026-11-09: "make the order tracking also work with 17track, or the
-- website's own tracking").
--
--   stores.tracking_page  the store's own tracking page, set on its knowledge page (web/pages/orders.ts): an https
--                         address, with {number} (the tracking number) or {order} (the order number) filled in when
--                         Toran gives it. NULL: none, and Toran gives the store's tracking link or a 17track one.
ALTER TABLE stores ADD COLUMN tracking_page text;

-- What 17track said of a tracking number, so a customer asking again within the hour spends no call and no quota.
-- One row a number (17track's own key is the number, whichever store shipped it). The daily pass deletes a row 30 days
-- after it was last checked (jobs/retention.ts): the last event names a place on the way to the customer.
CREATE TABLE tracking_cache (
  number         text PRIMARY KEY,
  registered_at  timestamptz,           -- registered with 17track (one of the account's quota); NULL: not yet
  status         text,                  -- 17track's main status (InTransit, Delivered...); NULL: none yet
  sub_status     text,
  event          jsonb,                 -- the last event: { text, place, at }, or null
  refused        text,                  -- 17track's error code when it would not take the number (format, carrier, quota)
  checked_at     timestamptz NOT NULL DEFAULT now()
);
