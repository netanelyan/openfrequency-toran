-- Reviews Toran collects (src/reviews.ts; the owner, 2026-11-06, docs/todo.md: "a message a few days after delivery
-- asking for a review; the review then shows on the store's site"). A customer answers a review request (auto/send.ts)
-- with a rating and a sentence; Toran keeps it, asks once whether it may be shown with their first name, and the owner
-- approves it before the store's site shows it (web/widget.ts, the reviews block). Nothing is shown without both the
-- customer's yes and the owner's approval.
CREATE TABLE reviews (
  id               serial PRIMARY KEY,
  store_id         integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  conversation_id  integer REFERENCES conversations(id) ON DELETE SET NULL,
  event_id         integer REFERENCES auto_events(id) ON DELETE SET NULL,  -- the review request it answers
  order_ref        text,
  rating           smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text             text NOT NULL DEFAULT '',
  name             text,                                   -- the first name it would be shown with
  step             text NOT NULL DEFAULT 'asked',          -- asked: the permission question went out; done
  publish          text NOT NULL DEFAULT 'unknown',        -- the customer's word: yes | no | unknown
  status           text NOT NULL DEFAULT 'pending',        -- the owner's: pending | approved | hidden
  decided_by       text,
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reviews_event ON reviews (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX reviews_store ON reviews (store_id, created_at DESC);
