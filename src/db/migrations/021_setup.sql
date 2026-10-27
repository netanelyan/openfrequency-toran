-- The setup checklist (src/setup.ts, GET /internal/setup for accounts' /setup): its one step Toran cannot read from
-- what the store already has is "בודקים את התשובות", the owner going over what Toran knows. knowledge_seen_at is the
-- first time a customer of the store's workspace opened its knowledge page (web/pages/customer.ts), not the
-- operator and not view-as. The step is done from then, or once the owner wrote an answer of their own.
ALTER TABLE stores ADD COLUMN knowledge_seen_at timestamptz;
