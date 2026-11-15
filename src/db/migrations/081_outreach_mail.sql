-- A pitch by email (src/ops/emailPitch.ts; the owner, 2026-11-15: "19 messages, 0 replies. redo that part. from start
-- until the end"): the first message asks a business whether it wants the demo we built for it, with the one way to
-- stop, as the Communications Law's section 30A allows once. Each one is an events row, kind 'outreach_mail', on the
-- lead's store, found again by the address it went to (a reply, the stop list, "once per address, product and stage")
-- and by the Israel day it went (the day's cap): the two indexes below keep those lookups off the events table.
--
-- An address that asked us to stop ("הסר", "לא תודה" to one of those emails): no email pitch of either product goes to
-- it again, and its leads are marked lost. Kept by address, as the record of what the business asked; nothing removes
-- a row.
--
--   email    the address, lower-cased
--   product  the product of the email they answered (toran | teder | both)
--   said     what they wrote, cut to 200 characters
--   at       when
CREATE TABLE IF NOT EXISTS outreach_mail_stops (
  email    text PRIMARY KEY,
  product  text,
  said     text,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_outreach_mail_email ON events ((data->>'email')) WHERE kind = 'outreach_mail';
CREATE INDEX IF NOT EXISTS events_outreach_mail_day ON events ((data->>'day')) WHERE kind = 'outreach_mail';
