-- The owner's assistant (src/assistant/): the store's owner asks Toran about the store, on the dashboard or from their
-- own WhatsApp number, and Toran answers from what it holds: the conversations, the questions waiting for them, what
-- customers ask about, the catalogue. It does something (answers a customer, pauses itself in a conversation) only
-- after the owner says "כן" to that one thing.

-- The owner's WhatsApp numbers, international digits: a message from one of them is the owner talking to the assistant,
-- never a customer.
ALTER TABLE stores ADD COLUMN owner_phones text[] NOT NULL DEFAULT '{}';

-- The owner's chat with the assistant, both sides, wherever it was written.
CREATE TABLE assistant_messages (
  id          serial PRIMARY KEY,
  store_id    integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'assistant')),
  text        text NOT NULL,
  via         text NOT NULL DEFAULT 'dashboard',   -- dashboard | whatsapp
  author      text,                                -- who wrote it (the owner's name or number)
  tools       jsonb NOT NULL DEFAULT '[]',         -- the assistant's tool calls behind its answer
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_messages_store ON assistant_messages (store_id, id);

-- What the assistant offered to do, waiting for the owner's "כן" (pending), and what became of it. One pending at a time
-- per store: a new offer replaces the last; one left for 30 minutes expires.
CREATE TABLE assistant_actions (
  id          serial PRIMARY KEY,
  store_id    integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('answer_customer', 'pause', 'resume')),
  params      jsonb NOT NULL DEFAULT '{}',
  summary     text NOT NULL,                       -- what the owner is asked to approve, in Hebrew
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled', 'failed', 'expired')),
  result      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  decided_by  text
);
CREATE INDEX assistant_actions_store ON assistant_actions (store_id, status);
