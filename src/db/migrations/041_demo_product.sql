-- A demo asked for on openfrequency.co.il is a demo of one product, Toran or Teder (src/channels/request.ts): one
-- number gets one demo of each. Every request before this one was Toran's.
--
--   product       toran | teder, from the website's POST /internal/lead
--   teder_id      a Teder request, once Teder took it (its POST /internal/lead, the worker's teder_lead job): Teder's
--                 demo for that store, which Teder keeps one of per store
--   delivered_at  a Teder request: when the demo's link went to the number on our WhatsApp (ops/actions.ts
--                 deliverTeder), so it goes once. A Toran request's link is the store's sent_at, as before
--
-- The index on (phone, product) answers "did this number ask for this product", and the old one on phone alone with it.
ALTER TABLE demo_requests ADD COLUMN product text NOT NULL DEFAULT 'toran' CHECK (product IN ('toran', 'teder'));
ALTER TABLE demo_requests ADD COLUMN teder_id text;
ALTER TABLE demo_requests ADD COLUMN delivered_at timestamptz;
CREATE INDEX demo_requests_phone_product ON demo_requests (phone, product) WHERE phone IS NOT NULL;
DROP INDEX demo_requests_phone;
