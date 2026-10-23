-- How many images each product has on the store (Shopify's images array), so the pitch page can say how many it
-- read. products.image keeps only the first one. Rows ingested before this say 0 until the next ingest.
ALTER TABLE products ADD COLUMN image_count integer NOT NULL DEFAULT 0;
