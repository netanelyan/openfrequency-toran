-- How long a store's Meta token lasts (channels/waStore.ts). Embedded Signup's token can end after 60 days, by the
-- configuration's choice; Meta's debug_token says when, read after the connect and once a day after it. The worker
-- tries to renew a token that ends within 20 days, and when that does not work, the dashboard and the operator ask the
-- store to connect again from 10 days before the end. On the end the account's status becomes 'reconnect': Meta still
-- delivers the customers' messages, but Toran cannot answer, so they wait for the owner.
--
-- token_expires_at is NULL for a token that never expires, and until it was read (token_checked_at says which).
ALTER TABLE channel_accounts ADD COLUMN token_issued_at timestamptz;
ALTER TABLE channel_accounts ADD COLUMN token_expires_at timestamptz;
ALTER TABLE channel_accounts ADD COLUMN token_data_until timestamptz;   -- debug_token's data_access_expires_at
ALTER TABLE channel_accounts ADD COLUMN token_checked_at timestamptz;
CREATE INDEX channel_accounts_token ON channel_accounts (token_expires_at) WHERE token_expires_at IS NOT NULL;
