-- A number that wrote "הפסק" to us after a payment reminder (src/billing/remind.ts): no payment reminder goes to it on
-- WhatsApp until it writes "התחל", which deletes the row. Kept by number, whoever the number is (an owner's linked
-- number, or the one a workspace last paid from, which accounts knows of only by its receipts), and kept while it
-- stands, as the record of what the person asked; the emails are accounts' and go on.
--
--   phone       international digits
--   stopped_at  when it was said (the latest "הפסק")
CREATE TABLE IF NOT EXISTS pay_remind_stops (
  phone       text PRIMARY KEY,
  stopped_at  timestamptz NOT NULL DEFAULT now()
);
