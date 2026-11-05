-- GET /internal/stores now gives each store's `about`, a line in its own words (src/leads/about.ts), made from its home
-- page's description and title as detection kept them (signals.description, signals.title). changed_at (migration 046)
-- has to move when that line can change, so the trigger watches those two as well; the rest is 046's as it was.
CREATE OR REPLACE FUNCTION stores_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR ROW(NEW.domain, NEW.url, NEW.name, NEW.brand->'name', NEW.brand_override->'name', NEW.platform, NEW.score, NEW.qualified,
      NEW.status, NEW.contact_email, NEW.contact_whatsapp, NEW.contact_phone, NEW.signals->'social', NEW.signals->'description', NEW.signals->'title',
      NEW.takedown_asked_at, NEW.taken_down_at, NEW.lost_at, NEW.workspace_id)
    IS DISTINCT FROM ROW(OLD.domain, OLD.url, OLD.name, OLD.brand->'name', OLD.brand_override->'name', OLD.platform, OLD.score, OLD.qualified,
      OLD.status, OLD.contact_email, OLD.contact_whatsapp, OLD.contact_phone, OLD.signals->'social', OLD.signals->'description', OLD.signals->'title',
      OLD.takedown_asked_at, OLD.taken_down_at, OLD.lost_at, OLD.workspace_id) THEN
    NEW.changed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;

-- Every store that may have one has a new field: it changed, so a reader paging by changed_at reads it again.
UPDATE stores SET changed_at = clock_timestamp() WHERE qualified AND (signals ? 'description' OR signals ? 'title');
