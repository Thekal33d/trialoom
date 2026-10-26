CREATE TABLE outbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL CHECK (topic = 'system.ping'),
  dedupe_key text NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 160),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'done', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK ((state = 'leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state <> 'leased' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK ((state = 'done') = (completed_at IS NOT NULL))
);

CREATE INDEX outbox_jobs_available ON outbox_jobs (available_at, created_at)
  WHERE state IN ('pending', 'leased');

-- Harmless database-local handler output. This is not a payment or business ledger.
CREATE TABLE worker_effects (
  job_id uuid PRIMARY KEY REFERENCES outbox_jobs (id),
  kind text NOT NULL CHECK (kind = 'system.ping'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
