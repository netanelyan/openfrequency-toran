-- A store's read-only access to its own orders (src/orders.ts), which get_order_status reads: one row a store, the
-- key the owner pasted on the store's knowledge page, sealed with TORAN_SECRETS_KEY (core/secrets.ts) as a channel's
-- token is. Disconnecting deletes the row, so a key the owner took back is not kept anywhere.
CREATE TABLE order_access (
  store_id      integer PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  platform      text NOT NULL,                   -- shopify | woocommerce | wix
  secret        text NOT NULL,                   -- the credentials as JSON, sealed
  status        text NOT NULL DEFAULT 'active',  -- active | error (the platform refused the key)
  meta          jsonb NOT NULL DEFAULT '{}',     -- { shop, site_id, hint, by, checked_at, why }
  connected_at  timestamptz NOT NULL DEFAULT now()
);
