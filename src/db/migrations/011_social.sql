-- Messenger and Instagram (src/channels/social.ts, socialStore.ts): a store logs in at Meta to connect its Facebook
-- Page or Instagram account. Each login is one row here, from the button to Meta's answer: state is what we send Meta
-- and get back, nonce_hash the hash of the cookie the browser that pressed the button holds (so the answer is taken
-- only in that browser), and data, when the person manages more than one Page, their Pages with each one's token,
-- sealed, until they pick one. A row is used once and is good for 15 minutes; picking a Page, for 30.
CREATE TABLE channel_connects (
  state       text PRIMARY KEY,
  store_id    integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  channel     text NOT NULL,                    -- messenger | instagram
  user_id     integer NOT NULL,                 -- accounts' user who pressed the button
  by_name     text,
  nonce_hash  text NOT NULL,
  data        text,                             -- sealed (core/secrets.ts): the Pages to pick from
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz
);
