-- A runner host is a registered, revocable party that executes runs under a
-- written contract. It is not an operator: its credential is separate, so a
-- compromised agent cannot speak as the host that is supposed to watch it.
--
-- Registering a host is an accountability boundary, not a cryptographic one. A
-- host an operator controls can still misreport; what registration buys is a
-- named party whose access can be revoked, and a declared contract the platform
-- can hold evidence against. Enforcement becomes a guarantee only when the
-- platform runs the host itself, and nothing here changes when it does.
CREATE TABLE runner_hosts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- NULL means a host the platform runs itself.
  operator_id uuid REFERENCES operators(id),
  contract_version text NOT NULL CHECK (contract_version = 'runner-host-v1'),
  -- What the host says it provides. The checks below refuse an incoherent claim.
  sandbox text NOT NULL CHECK (sandbox IN ('gvisor', 'firecracker', 'none')),
  egress_enforced boolean NOT NULL,
  ephemeral_filesystem boolean NOT NULL,
  -- 'attested' is the agent's own word, which is all an unenforced host can
  -- offer. 'witnessed' requires a proxy that denies and reports egress itself.
  isolation_level text NOT NULL CHECK (isolation_level IN ('attested', 'witnessed')),
  credential_hash text NOT NULL UNIQUE CHECK (credential_hash ~ '^[a-f0-9]{64}$'),
  registered_by text NOT NULL REFERENCES auth_user(id),
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- A host cannot claim the witnessed level without the two things that make it
  -- mean anything: a real sandbox and an enforcing egress proxy.
  CHECK (
    isolation_level <> 'witnessed'
    OR (egress_enforced AND ephemeral_filesystem AND sandbox <> 'none')
  )
);
CREATE INDEX runner_hosts_live ON runner_hosts (operator_id) WHERE revoked_at IS NULL;

-- Which host executed a run, and the level that binding established. Recorded
-- when the grant is issued, so the level is a property of the run rather than a
-- sentence in a document the agent writes afterwards.
ALTER TABLE runs ADD COLUMN host_id uuid REFERENCES runner_hosts(id);
ALTER TABLE runs ADD COLUMN isolation_level text NOT NULL DEFAULT 'attested'
  CHECK (isolation_level IN ('attested', 'witnessed'));
ALTER TABLE runs ADD CONSTRAINT runs_witnessed_needs_host
  CHECK (isolation_level <> 'witnessed' OR host_id IS NOT NULL);

-- What the egress proxy denied or allowed, reported by the proxy. Append-only
-- and keyed to the batch it arrived in, so a later batch cannot rewrite an
-- earlier observation.
CREATE TABLE egress_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id),
  host_id uuid NOT NULL REFERENCES runner_hosts(id),
  batch integer NOT NULL CHECK (batch > 0),
  origin text NOT NULL CHECK (length(origin) BETWEEN 1 AND 2048),
  decision text NOT NULL CHECK (decision IN ('allowed', 'denied')),
  requests integer NOT NULL CHECK (requests > 0 AND requests <= 100000),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, batch, origin, decision),
  CHECK (last_seen_at >= first_seen_at)
);
CREATE INDEX egress_observations_run ON egress_observations (run_id, batch);
CREATE TRIGGER immutable_egress_observation BEFORE UPDATE OR DELETE ON egress_observations
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- The comparison the platform performed between what the agent claimed and what
-- the witness saw. Written once with the submission it belongs to.
ALTER TABLE evidence_submissions ADD COLUMN egress_verification jsonb;
ALTER TABLE evidence_submissions ADD CONSTRAINT evidence_submissions_egress_verification
  CHECK (egress_verification IS NULL OR jsonb_typeof(egress_verification) = 'object');
