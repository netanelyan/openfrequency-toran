-- The customer's dashboard (docs/customer.md): the store owner's inbox, what Toran knows, and the plan.

-- "טיפלתי בזה": the owner marked every message up to this id as handled, so a handoff before it no longer waits for
-- them. 0 is nothing marked.
ALTER TABLE conversations ADD COLUMN settled_upto integer NOT NULL DEFAULT 0;

-- An answer Toran learned from the owner's reply in a conversation ("מה שתענו הוא יזכור לפעם הבאה").
ALTER TABLE faqs ADD COLUMN conversation_id integer REFERENCES conversations(id) ON DELETE SET NULL;
