-- The operator's dashboard (docs/operator.md): who to write to today, who is in a conversation, the funnel, the
-- customers and the money.

-- A lead's outreach past the first message and the one reminder: they answered, they said no (and why), it waits for
-- later, and what happens next in a conversation.
ALTER TABLE stores ADD COLUMN replied_at timestamptz;
ALTER TABLE stores ADD COLUMN lost_at timestamptz;
ALTER TABLE stores ADD COLUMN lost_reason text;
ALTER TABLE stores ADD COLUMN snoozed_until timestamptz;
ALTER TABLE stores ADD COLUMN next_step text;
ALTER TABLE stores ADD COLUMN next_step_at timestamptz;

-- Teder's store demos (Teder's GET /internal/demos), copied in each time the dashboard opens, with their outreach,
-- which only Toran keeps. The columns up to synced_at are Teder's and are overwritten on every copy; the rest are
-- the operator's.
CREATE TABLE teder_leads (
  id               text PRIMARY KEY,                 -- Teder's demo id
  domain           text NOT NULL,
  url              text,
  name             text,
  whatsapp         text,                             -- the number that asked on the website
  status           text NOT NULL,
  page_url         text,                             -- the public page, while it is public
  created_at       timestamptz,
  ready_at         timestamptz,
  approved_at      timestamptz,
  removed_at       timestamptz,
  opens            integer NOT NULL DEFAULT 0,
  visitors         integer NOT NULL DEFAULT 0,
  last_open_at     timestamptz,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  reminder_due_at  timestamptz,
  reminded_at      timestamptz,                      -- the one reminder; after it, nothing more goes to them
  replied_at       timestamptz,
  won_at           timestamptz,
  lost_at          timestamptz,
  lost_reason      text,
  snoozed_until    timestamptz,
  next_step        text,
  next_step_at     timestamptz
);
