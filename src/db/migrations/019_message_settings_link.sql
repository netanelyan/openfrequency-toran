-- The quiet way to stop the marketing automatic messages (the cart and the review, auto/messages.ts): a link in each
-- one, on WhatsApp the template's "הגדרות הודעות" button, by email a line at the end and List-Unsubscribe, to the
-- page /u/<token> (web/unsubscribe.ts). token is random (18 bytes, base64url), so the URL says nothing about the
-- person; the row binds it to one store, one channel and one address (a phone in international digits, an email
-- lower-cased), one token for each, kept for good so a message from last year still opens its page. stopped_at is set
-- while the person has stopped from the page, and cleared by its undo; the consent itself is in auto_consent (source
-- 'link').
CREATE TABLE auto_links (
  token       text PRIMARY KEY,
  store_id    integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  channel     text NOT NULL,                     -- whatsapp | email
  address     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  stopped_at  timestamptz,
  UNIQUE (store_id, channel, address)
);
