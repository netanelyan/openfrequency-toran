-- A store the operator added to the shared lead list by hand, by its address (accounts' /admin/leads,
-- src/ops/leadsAdmin.ts; the owner, 2026-11-12: "i want https://accounts.openfrequency.co.il/admin/leads to have
-- everything i need for creating and doing leads"). It is listed there whatever its score, with its description, so the
-- operator decides on it: Toran, Teder, both or neither. Adding it reads the site and builds nothing.
--
--   stores.added_at   when the operator added it there, or again; NULL for a store discovery alone found.
ALTER TABLE stores ADD COLUMN added_at timestamptz;
