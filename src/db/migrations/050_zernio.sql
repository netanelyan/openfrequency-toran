-- A store connects its Facebook Page (Messenger) and Instagram account through Zernio (src/channels/zernio.ts) while
-- our own Meta app has no review for them: Zernio's approved Meta apps hold the connection, and Zernio's webhook brings
-- the messages to /zernio/webhook. Each store is one Zernio profile (externalId toran-store-<id>), made the first time it
-- presses "לחבר"; the Page or account itself is a channel_accounts row of kind 'zernio' (external_id Zernio's account
-- id, no secret: our API key sends for it).
--
--   zernio_profiles  store_id, profile_id (Zernio's id for the profile)
--   zernio_threads   one customer of one connected account: Zernio's conversation id, which sending needs, and the
--                    name Zernio gave for them (participantName), for the inbox
CREATE TABLE IF NOT EXISTS zernio_profiles (
  store_id    integer PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  profile_id  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zernio_threads (
  account_id       integer NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  peer             text NOT NULL,
  conversation_id  text NOT NULL,
  name             text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, peer)
);
