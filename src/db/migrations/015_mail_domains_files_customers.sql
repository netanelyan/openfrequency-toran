-- Three things email left for later (docs/decisions.md, 2026-10-25): an address on the store's own domain, the files
-- customers send and the owner attaches, and one customer across channels.

-- A store's own mail domain (src/channels/mailDomain.ts): the domain its replies go out from, as Resend holds it, with
-- the DNS records the owner adds and where each stands. Until status is 'verified' replies go out from the store's
-- address on our domain, as before. receiving is a subdomain the owner chose for mail to come straight to Toran (an MX
-- record there), a second domain at Resend; NULL: their mail keeps coming by forwarding.
CREATE TABLE mail_domains (
  store_id           integer PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  domain             text NOT NULL UNIQUE,        -- theirstore.co.il
  local              text NOT NULL,               -- support: replies go out from support@theirstore.co.il
  resend_id          text,
  status             text NOT NULL DEFAULT 'not_started', -- Resend's: not_started | pending | verified | failed | temporary_failure
  records            jsonb NOT NULL DEFAULT '[]',
  receiving          text UNIQUE,                 -- help.theirstore.co.il, or NULL
  receiving_id       text,
  receiving_status   text,
  receiving_records  jsonb NOT NULL DEFAULT '[]',
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  checked_at         timestamptz,
  verified_at        timestamptz
);

-- A file in a conversation (src/channels/files.ts): one a customer sent (in) or the owner attached to a reply (out).
-- The bytes are in the private folder under their SHA-256 (files/), never in the repository or a page's HTML; a file
-- that was too big or of a kind the inbox does not show is listed with why, and nothing is kept. messages.attachments
-- lists a message's files by these ids.
CREATE TABLE files (
  id               serial PRIMARY KEY,
  conversation_id  integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction        text NOT NULL,                 -- in | out
  name             text NOT NULL,
  type             text NOT NULL,                 -- what the bytes are (checked), not what the sender said
  size             integer NOT NULL DEFAULT 0,
  sha256           text,                          -- NULL: not kept
  skipped          text,                          -- why not kept: too_big | type | failed
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_conversation ON files (conversation_id);

-- One customer across channels (src/channels/customers.ts). A row says that this id on this channel is this customer
-- of this store: they wrote from it (wrote), gave it in a conversation (said: an email address or a phone number, the
-- exact string), or the owner said so in the inbox (owner), or said the opposite (apart). An id with no row is a
-- customer of its own. Nothing here is guessed from a name or a likeness: only an exact id joins two.
CREATE TABLE customers (
  id          serial PRIMARY KEY,
  store_id    integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE customer_ids (
  store_id      integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  channel       text NOT NULL,                    -- whatsapp | email | messenger | instagram
  value         text NOT NULL,                    -- the peer: international digits, the address, Meta's id
  customer_id   integer NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  how           text NOT NULL,                    -- wrote | said | owner | apart
  conversation_id integer REFERENCES conversations(id) ON DELETE SET NULL, -- where it was said, or merged from
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, channel, value)
);
CREATE INDEX customer_ids_customer ON customer_ids (customer_id);
