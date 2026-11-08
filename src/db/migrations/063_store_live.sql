-- Going live, one press (src/golive.ts; TORAN-READINESS.md P1-7, the owner, 2026-11-08: "make sure toran is ready for
-- customers like teder"). Until a store's owner presses "להפעיל את תורן", a message on the store's own channels waits
-- for the owner in the inbox and Toran does not answer it (channels/store.ts); the demo number is not gated. The owner
-- can pause the whole store later and switch it on again.
--
--   stores.agent_live_at    the first time Toran was switched on (null: never)
--   stores.agent_paused_at  set while the owner has paused it; null when it answers
--
-- A store is live from the start, as every store here was until now: only a store a customer adds at sign-up starts
-- off (jobs/worker.ts add_store), so the owner switches it on once its channels and answers are ready. Each store
-- already here is live from the day its first channel connected, or from now.
ALTER TABLE stores ADD COLUMN agent_live_at timestamptz DEFAULT now();
ALTER TABLE stores ADD COLUMN agent_paused_at timestamptz;
UPDATE stores s SET agent_live_at = COALESCE((SELECT MIN(a.connected_at) FROM channel_accounts a WHERE a.store_id = s.id), s.agent_live_at, now());
