-- A demo asked for on openfrequency.co.il, waiting for the person to write to the demo number with its code
-- (src/channels/request.ts). The request counts only once that message arrives: the number it came from is then
-- proven, and one number gets one demo. Until then nothing is fetched and nothing is built.
CREATE TABLE demo_requests (
  id         serial PRIMARY KEY,
  code       text NOT NULL UNIQUE,            -- REQ-XXXXXX, in the message the website's button writes
  url        text NOT NULL,                   -- the store's homepage, from the form
  domain     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  phone      text,                            -- the WhatsApp number that wrote with the code
  claimed_at timestamptz,
  store_id   integer REFERENCES stores(id) ON DELETE SET NULL
);
CREATE INDEX demo_requests_phone ON demo_requests (phone) WHERE phone IS NOT NULL;
