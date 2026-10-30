-- Teder's reason a demo failed (the `error` of its GET /internal/demos), copied with the rest of Teder's columns
-- (src/ops/sources.ts syncTeder), so the operator's dashboard shows every Teder demo that is not up yet, with why.
ALTER TABLE teder_leads ADD COLUMN error text;
