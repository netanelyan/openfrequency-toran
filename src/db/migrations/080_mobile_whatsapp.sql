-- A store's WhatsApp, when its site links to none, is its first Israeli mobile number (the owner, 2026-11-13: "if a
-- phone start with +9725 whatsapp is 99% available, so lets treat it as it is"; leads/store.ts does the same for every
-- find from now on). The stores known before: their phone when it is a mobile, else the first mobile their site listed
-- (signals.phones, in the order found). A company's row keeps only the WhatsApp it was given. changed_at moves with it
-- (migration 047), so Teder's copy of the lead reads the number on its next sync.
UPDATE stores s SET contact_whatsapp = m.n, updated_at = now()
FROM (
  SELECT id, COALESCE(
    CASE WHEN contact_phone ~ '^9725[0-9]{8}$' THEN contact_phone END,
    (SELECT e.p FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(signals->'phones') = 'array' THEN signals->'phones' ELSE '[]'::jsonb END) WITH ORDINALITY AS e(p, i)
      WHERE e.p ~ '^9725[0-9]{8}$' ORDER BY e.i LIMIT 1)
  ) AS n
  FROM stores
  WHERE contact_whatsapp IS NULL AND status <> 'company' AND platform IS DISTINCT FROM 'company'
) m
WHERE s.id = m.id AND m.n IS NOT NULL;
