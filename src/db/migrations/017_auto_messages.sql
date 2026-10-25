-- Toran's automatic messages (src/auto/): an abandoned cart, a payment (paid, pending, failed), a shipment (shipped,
-- delivered) and a review request, each started by Toran from what the store's platform says, on the store's own
-- WhatsApp number (an approved template) or its email. Every kind is off until the store's owner turns it on.

-- What the owner turned on, per store and kind (auto/messages.ts KINDS): which channels, and for the cart and the
-- review the delay and the link. on_since is when the kind was last turned on: nothing that happened before it is
-- ever sent, so turning a kind on never writes to last month's customers.
CREATE TABLE auto_settings (
  store_id       integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind           text NOT NULL,                   -- cart | payment | shipping | review
  whatsapp       boolean NOT NULL DEFAULT false,
  email          boolean NOT NULL DEFAULT false,
  delay_minutes  integer,                         -- cart: after the checkout; review: after the delivery
  link           text,                            -- review: where the customer writes one
  on_since       timestamptz,
  updated_by     text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, kind)
);

-- Where a store's events come from (auto/platforms.ts): its platform's webhooks when the owner's key can register
-- them, and the worker's reading every 15 minutes either way (every hour behind working webhooks). secret is the
-- webhooks' signing key, sealed with TORAN_SECRETS_KEY: Shopify's is the custom app's API secret key, which the owner
-- pastes; WooCommerce's is one Toran makes. can says what the key allows, with why, for the settings page.
CREATE TABLE auto_sources (
  store_id    integer PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  platform    text NOT NULL,                     -- shopify | woocommerce | wix
  secret      text,
  hooks       jsonb NOT NULL DEFAULT '[]',       -- [{ topic, id }] registered at the platform
  can         jsonb NOT NULL DEFAULT '{}',       -- { webhooks, checkouts, why: { webhooks, checkouts } }
  read_from   timestamptz,                       -- the platform's update time the reading has reached
  polled_at   timestamptz,
  hook_at     timestamptz,                       -- the last webhook that checked out
  checked_at  timestamptz
);

-- One thing to tell one customer, from one thing that happened at the store: key is the platform's own id of it
-- with the message (shopify:checkout:<token>:cart, woocommerce:order:<id>:paid ...), so a webhook and a reading of the
-- same order are one row, and nothing is sent twice. contact is the customer's name, phone and email from the order or
-- checkout; vars the order number and the link. A row waits until due_at and leaves 'waiting' once: sent (with the
-- channel and the conversation it is in), skipped (why: an order was placed, the customer wrote, no consent, the
-- kind is off...) or failed.
CREATE TABLE auto_events (
  id               serial PRIMARY KEY,
  store_id         integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  key              text NOT NULL,
  kind             text NOT NULL,
  message          text NOT NULL,                -- cart | paid | pending | failed | shipped | delivered | review
  ref              text,                         -- the order number or the checkout, for the owner
  contact          jsonb NOT NULL DEFAULT '{}',  -- { name, phone, email }
  vars             jsonb NOT NULL DEFAULT '{}',  -- { order, link }
  source           text NOT NULL,                -- webhook | poll
  happened_at      timestamptz NOT NULL,
  due_at           timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'waiting',
  why              text,
  basis            text,                         -- what allowed it: the order's phone or email, or a consent's source
  channel          text,
  conversation_id  integer REFERENCES conversations(id) ON DELETE SET NULL,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, key)
);
CREATE INDEX auto_events_due ON auto_events (due_at) WHERE status = 'waiting';
CREATE INDEX auto_events_store ON auto_events (store_id, created_at DESC);

-- What a customer agreed to, or refused, per channel and address (a phone in international digits, an email address
-- lower-cased), with where it came from: the store's checkout (shopify:sms_marketing_consent ...) or the customer
-- writing "הסר" (customer:הסר). The latest by `at` stands (auto/consent.ts). scope marketing is the cart and the
-- review; all is every automatic message.
CREATE TABLE auto_consent (
  id           serial PRIMARY KEY,
  store_id     integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  channel      text NOT NULL,                    -- whatsapp | email
  address      text NOT NULL,
  scope        text NOT NULL,                    -- marketing | all
  state        text NOT NULL,                    -- in | out
  source       text NOT NULL,
  at           timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, channel, address, scope, state, source, at)
);
CREATE INDEX auto_consent_who ON auto_consent (store_id, channel, address, at);

-- Toran's templates on a store's own WhatsApp account (auto/templates.ts), as submitted and as Meta last said:
-- PENDING, APPROVED, REJECTED, PAUSED, DISABLED, or error (the submission itself failed, with why). category is what
-- Meta says it is, which can differ from what was asked for.
CREATE TABLE wa_templates (
  account_id    integer NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  store_id      integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name          text NOT NULL,
  message       text NOT NULL,
  asked         text NOT NULL,                   -- UTILITY | MARKETING
  category      text,
  meta_id       text,
  status        text NOT NULL,
  why           text,
  body          text NOT NULL,                   -- the body as submitted
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  checked_at    timestamptz,
  PRIMARY KEY (account_id, name)
);

-- A message Toran sent by itself (auto_events.message), shown so in the inbox. It is the store's side of the
-- conversation, so it counts toward nothing in the plan (plans.ts counts the customers' messages).
ALTER TABLE messages ADD COLUMN auto text;
