-- Which demo the operator chose to make for a lead on the shared lead dashboard (accounts' /admin/leads,
-- src/ops/leadsAdmin.ts; the owner, 2026-11-11: "each leads should have a button for generating a demo for
-- teder/toran/both. the message that is suggested being sent to the phone number on whatsapp should be according to
-- that"). The lead's page leads with that one's message.
--
--   stores.demo_for   toran, teder or both: what the operator asked to make here. Asking for the other one too makes it
--                     both. Null, the default, is nothing chosen here (a page Toran built by itself, or none yet): the
--                     page leads with the message with both demos when both can go, as before.
ALTER TABLE stores ADD COLUMN demo_for text CHECK (demo_for IN ('toran', 'teder', 'both'));
