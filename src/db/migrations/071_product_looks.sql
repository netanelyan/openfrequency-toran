-- What a product's main photo shows (src/ingest/looks.ts; the owner, 2026-11-09, on a red kit offered for "a nice
-- yellow shirt": "make the AI have a way to watch pictures"). A store whose titles are only a team and a season says
-- nothing of colour in its text, so each product's photo is read once and its colours and look are kept beside it, in
-- Hebrew and English, for the agent's search (agent/tools.ts rank) and its result lines.
--
--   products.looks        a short line: "צהוב, ירוק / yellow, green; striped" (null: not read yet, or no photo)
--   products.looks_image  the photo address it was read from: a new photo is read again, the same one never
--   products.looks_at     when
--
-- A re-scrape leaves the three as they are (ingest/pack.ts writes none of them).
ALTER TABLE products ADD COLUMN looks text;
ALTER TABLE products ADD COLUMN looks_image text;
ALTER TABLE products ADD COLUMN looks_at timestamptz;
