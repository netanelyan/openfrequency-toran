-- A number that asked us to stop after a pitch on WhatsApp (src/ops/outreach.ts): the template's "הסירו אותי", or a
-- reply such as "לא" or "הסר" to it. No pitch of either product goes to it again, from any of our numbers, and its
-- leads are marked lost. Kept by number, as the record of what the person asked; nothing removes a row.
--
--   phone       international digits
--   product     the product whose pitch they answered (toran | teder)
--   said        what they wrote, as it came (the button's text, or their words), cut to 200 characters
--   stopped_at  when
CREATE TABLE IF NOT EXISTS outreach_stops (
  phone       text PRIMARY KEY,
  product     text NOT NULL,
  said        text,
  stopped_at  timestamptz NOT NULL DEFAULT now()
);
