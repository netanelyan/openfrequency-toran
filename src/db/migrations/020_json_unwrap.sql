-- From the move to Postgres (2026-10-25) until db/index.ts's JSON_TYPE, the driver JSON.stringify()d the JSON text every
-- caller passes (J(...)), so each json and jsonb value written was one JSON string holding the JSON: a job's payload
-- read back as "{\"storeId\":95}", and every job since failed on it. Here every such value, in every json and jsonb
-- column, gets back what was meant: a string whose text is JSON is replaced by that JSON. A string whose text is not
-- JSON stays as it was. On PGlite nothing was written so, and the rare true string that reads as JSON ("5", "null")
-- is the only thing this could change.
CREATE FUNCTION toran_unwrap(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN (j #>> '{}')::jsonb;
EXCEPTION WHEN others THEN
  RETURN j;
END $$;

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT k.table_name, k.column_name, k.data_type FROM information_schema.columns k
           JOIN information_schema.tables t ON t.table_schema = k.table_schema AND t.table_name = k.table_name AND t.table_type = 'BASE TABLE'
           WHERE k.table_schema = current_schema() AND k.data_type IN ('json', 'jsonb') LOOP
    EXECUTE format('UPDATE %I SET %I = toran_unwrap(%I::jsonb)::%s WHERE json_typeof(%I::json) = ''string''',
                   c.table_name, c.column_name, c.column_name, c.data_type, c.column_name);
  END LOOP;
END $$;

DROP FUNCTION toran_unwrap(jsonb);
