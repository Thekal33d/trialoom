-- 0012's payload guard used `payload ?| ARRAY[...]`, which reads only the
-- top-level keys. A secret one level down -- or inside an array -- passed it,
-- so the defence in depth it was described as providing covered one layer.
--
-- This replaces it with a recursive key scan. The jsonpath filters to objects
-- before taking their key-value pairs, because `$.**` yields scalars too and
-- `keyvalue()` errors on those even in lax mode.
CREATE FUNCTION event_payload_is_clean(payload jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM jsonb_path_query(payload, 'lax $.**?(@.type() == "object").keyvalue()') AS pair
    WHERE pair->>'key' = ANY (ARRAY[
      'secret', 'token', 'credential', 'password', 'signature', 'privateKey',
      'grant', 'runToken', 'attemptToken', 'authorization', 'cookie', 'bytes', 'document'
    ])
  );
$$;

-- 0012 declared the guard inline on the column, so Postgres named it
-- events_payload_check1, after the typeof check on the same column. Named
-- explicitly here so no later migration has to count constraints.
ALTER TABLE events DROP CONSTRAINT events_payload_check1;
ALTER TABLE events ADD CONSTRAINT events_payload_clean
  CHECK (event_payload_is_clean(payload));
