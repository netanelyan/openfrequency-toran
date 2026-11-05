-- When what Teder reads of a store changed (GET /internal/stores, src/ops/stores.ts): Teder's operator page of the
-- stores Toran found pages by it (since=<the last one it got>). updated_at could not be that: some paths set it and
-- some do not (channels/request.ts and jobs/worker.ts write contact_whatsapp without it), and it also moves for things
-- Teder is not given. So the database keeps this one itself, on every INSERT and UPDATE, whatever path makes it: it
-- moves only when a field the route gives changes (the domain, the URL, the names, the platform, the score, qualified,
-- the status, the contacts, signals.social, and every flag that makes a store opted out: the takedown asked or done,
-- lost, skipped, a workspace's). clock_timestamp(), not now(): the rows one statement changes each get a moment of
-- their own, in order, and a long transaction's rows are stamped when they change, not when it began.
ALTER TABLE stores ADD COLUMN changed_at timestamptz;
UPDATE stores SET changed_at = updated_at;
ALTER TABLE stores ALTER COLUMN changed_at SET DEFAULT now();
ALTER TABLE stores ALTER COLUMN changed_at SET NOT NULL;
CREATE INDEX stores_changed ON stores (changed_at, id) WHERE qualified;

CREATE FUNCTION stores_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR ROW(NEW.domain, NEW.url, NEW.name, NEW.brand->'name', NEW.brand_override->'name', NEW.platform, NEW.score, NEW.qualified,
      NEW.status, NEW.contact_email, NEW.contact_whatsapp, NEW.contact_phone, NEW.signals->'social', NEW.takedown_asked_at, NEW.taken_down_at,
      NEW.lost_at, NEW.workspace_id)
    IS DISTINCT FROM ROW(OLD.domain, OLD.url, OLD.name, OLD.brand->'name', OLD.brand_override->'name', OLD.platform, OLD.score, OLD.qualified,
      OLD.status, OLD.contact_email, OLD.contact_whatsapp, OLD.contact_phone, OLD.signals->'social', OLD.takedown_asked_at, OLD.taken_down_at,
      OLD.lost_at, OLD.workspace_id) THEN
    NEW.changed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stores_changed BEFORE INSERT OR UPDATE ON stores FOR EACH ROW EXECUTE FUNCTION stores_changed();
