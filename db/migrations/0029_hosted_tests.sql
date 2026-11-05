CREATE TABLE paid_runner_runtime (
  host_id uuid PRIMARY KEY REFERENCES runner_hosts(id),
  image text NOT NULL CHECK (image ~ '^sha256:[a-f0-9]{64}$'),
  dispatch_key_hash text NOT NULL CHECK (dispatch_key_hash ~ '^[a-f0-9]{64}$'),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE hosted_test_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL UNIQUE REFERENCES assignments(id),
  operator_id uuid NOT NULL REFERENCES operators(id),
  credential_id uuid NOT NULL REFERENCES agent_credentials(id),
  attempt_token uuid NOT NULL,
  host_id uuid NOT NULL REFERENCES runner_hosts(id),
  image text NOT NULL CHECK (image ~ '^sha256:[a-f0-9]{64}$'),
  dispatch_key_hash text NOT NULL CHECK (dispatch_key_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','submitted','blocked','interrupted')),
  run_id uuid UNIQUE REFERENCES runs(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (state NOT IN ('running','submitted','interrupted') OR run_id IS NOT NULL)
);
CREATE INDEX hosted_test_jobs_pending ON hosted_test_jobs(host_id,created_at) WHERE state IN ('queued','running');
