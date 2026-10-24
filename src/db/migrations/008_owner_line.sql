-- The owner line (src/owners/, docs/owner-line.md): one WhatsApp number on which a business owner talks to their
-- assistant about Toran, Teder or both, and on which Teder's news reaches them. Who a number is comes from
-- openfrequency-accounts, asked live; stores.owner_phones (007) is no longer read, since a number typed on the
-- dashboard proves nothing.

-- The assistant's chat for an owner who has no store here (Teder only): keyed by the workspace and the number.
ALTER TABLE assistant_messages ALTER COLUMN store_id DROP NOT NULL;
ALTER TABLE assistant_messages ADD COLUMN workspace_id integer;
ALTER TABLE assistant_messages ADD COLUMN phone text;
CREATE INDEX assistant_messages_phone ON assistant_messages (phone, id);

-- Each owner number that has written or been written to: what accounts last said about it, and what Toran itself
-- knows. opted_out_at is the owner's "הפסק" here, kept even when accounts could not be told; a later opt-in in accounts
-- or "התחל" here clears it.
CREATE TABLE owner_numbers (
  phone            text PRIMARY KEY,
  workspace_id     integer,
  user_id          integer,
  products         text[] NOT NULL DEFAULT '{}',
  checked_at       timestamptz,                    -- when accounts last vouched for it
  opted_out_at     timestamptz,
  disclosed_at     timestamptz,                    -- the first message that said it is a digital assistant
  last_inbound_at  timestamptz,                    -- the owner's last message: the 24-hour window runs from here
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The posts Toran last showed an owner, in the order shown: "1" in the owner's next message is items->0.
CREATE TABLE owner_lists (
  id            serial PRIMARY KEY,
  phone         text NOT NULL,
  workspace_id  integer NOT NULL,
  items         jsonb NOT NULL,                    -- [{ id, hook }]
  source        text NOT NULL,                     -- post.ready | post.reminder | post.unposted | asked
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX owner_lists_phone ON owner_lists (phone, id DESC);

-- Every event Teder sent, once (its id is the dedupe key).
CREATE TABLE teder_events (
  id            text PRIMARY KEY,
  type          text NOT NULL,
  workspace_id  integer NOT NULL,
  at            timestamptz,
  data          jsonb NOT NULL DEFAULT '{}',
  received_at   timestamptz NOT NULL DEFAULT now()
);

-- Every message Toran started to an owner (notify.ts), whatever became of it: sent inside the 24 hours (session) or as
-- a template, put off to the end of Teder's quiet time, or not sent and why.
CREATE TABLE owner_notifications (
  id            serial PRIMARY KEY,
  event_id      text,
  workspace_id  integer NOT NULL,
  phone         text NOT NULL,
  kind          text NOT NULL,                     -- the event's type
  status        text NOT NULL CHECK (status IN ('sent', 'deferred', 'skipped', 'failed')),
  mode          text CHECK (mode IN ('session', 'template')),
  template      text,
  reason        text,                              -- skipped / deferred / failed: why
  due_at        timestamptz,                       -- deferred: when it goes out
  detail        jsonb NOT NULL DEFAULT '{}',
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX owner_notifications_phone ON owner_notifications (phone, at DESC);
CREATE UNIQUE INDEX owner_notifications_once ON owner_notifications (event_id, phone) WHERE status = 'sent';

-- Every message the owner line took, by the provider's id: a webhook delivered twice is acted on once (the demo's
-- messages have messages.ext_id for this; the owner's chat is kept in assistant_messages, which has none).
CREATE TABLE owner_inbound (
  ext_id  text PRIMARY KEY,
  phone   text NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);
