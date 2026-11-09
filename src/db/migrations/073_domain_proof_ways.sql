-- Easier ways to prove a site is yours (src/domainProof.ts; the owner, 2026-11-09: "any easier way to do that? many
-- business owners dont know how to do that", and "a native website can have the html tag, others should have an easier
-- way"). /start reads what the site is built on and offers the easiest way first:
--   platform, platform_at   what the site is built on (shopify | woocommerce | wordpress | wix | webflow | other), read
--                           once and again after a day
--   order_creds             a Shopify or WooCommerce key that proved the site, sealed like order_access.secret; moved to
--                           the store's order_access once the store exists, then cleared
--   code_hash, code_to,     a 6-digit code sent to an address published on the site: only its hash, where it went,
--   code_sent_at, code_tries when (30 minutes), and how many tries it had (5)
ALTER TABLE domain_claims
  ADD COLUMN platform text,
  ADD COLUMN platform_at timestamptz,
  ADD COLUMN order_creds text,
  ADD COLUMN code_hash text,
  ADD COLUMN code_to text,
  ADD COLUMN code_sent_at timestamptz,
  ADD COLUMN code_tries integer NOT NULL DEFAULT 0;
