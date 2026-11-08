-- A store connects its own WhatsApp number through Kapso (src/channels/kapso.ts) while our own Meta app waits for its
-- review: Kapso's Meta app holds the connection, and Kapso forwards the number's Meta webhooks to /kapso/webhook. Each
-- store is one Kapso "customer", made the first time it opens the connect link; the number itself is a channel_accounts
-- row of kind 'kapso' (external_id the Meta phone number id, no secret: our project key sends for it).
--
--   store_id     the store
--   customer_id  Kapso's id for it (a uuid)
--   link_at      when the last setup link was made for it
CREATE TABLE IF NOT EXISTS kapso_customers (
  store_id     integer PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  customer_id  text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  link_at      timestamptz
);
