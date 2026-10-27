-- Lets a run and a submission inherit an assignment's exact pinned identities
-- instead of restating them, so neither can name different terms or a different build.
ALTER TABLE assignments ADD CONSTRAINT assignments_campaign_assignment UNIQUE (campaign_id, id);
ALTER TABLE assignments ADD CONSTRAINT assignments_pinned_identity
  UNIQUE (id, terms_version_id, build_id);

-- One scoped execution grant per run of an assignment. The grant is the only
-- credential an isolated runner holds: it expires with the claim lease, it can
-- do exactly one thing, and no scope in this system can sign a payout.
CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES assignments(id),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  project_id uuid NOT NULL,
  build_id uuid NOT NULL,
  operator_id uuid NOT NULL REFERENCES operators(id),
  -- The attempt this run belongs to. A retired attempt can never submit.
  attempt_token uuid NOT NULL,
  terms_version_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('issued', 'active', 'submitted', 'abandoned', 'expired')),
  grant_hash text NOT NULL UNIQUE CHECK (grant_hash ~ '^[a-f0-9]{64}$'),
  grant_scope text NOT NULL CHECK (grant_scope = 'evidence:submit'),
  grant_expires_at timestamptz NOT NULL,
  -- Issued limits and the declared isolation profile.
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  -- What Trialoom itself observed about the pinned target at execution time.
  target_check jsonb NOT NULL CHECK (jsonb_typeof(target_check) = 'object'),
  artifact_count integer NOT NULL DEFAULT 0 CHECK (artifact_count >= 0),
  artifact_bytes bigint NOT NULL DEFAULT 0 CHECK (artifact_bytes >= 0),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  closed_reason text CHECK (length(closed_reason) BETWEEN 1 AND 200),
  FOREIGN KEY (project_id, build_id) REFERENCES builds (project_id, id),
  FOREIGN KEY (campaign_id, assignment_id) REFERENCES assignments (campaign_id, id),
  FOREIGN KEY (assignment_id, terms_version_id, build_id)
    REFERENCES assignments (id, terms_version_id, build_id),
  CHECK (grant_expires_at > issued_at),
  CHECK ((state IN ('issued', 'active')) = (closed_at IS NULL))
);
-- One live run per assignment: a crashed runner abandons before another starts.
CREATE UNIQUE INDEX runs_live_assignment ON runs (assignment_id) WHERE state IN ('issued', 'active');
CREATE INDEX runs_assignment ON runs (assignment_id, issued_at DESC);
CREATE INDEX runs_expiry ON runs (grant_expires_at) WHERE state IN ('issued', 'active');

-- Artifact bytes never enter this database. These rows record identity, size,
-- the private storage key, and whether a verified redacted copy exists.
CREATE TABLE evidence_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id),
  name text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9._-]{0,80}$'),
  kind text NOT NULL,
  media_type text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  storage_key text NOT NULL CHECK (storage_key ~ '^[a-f0-9]{64}$'),
  redacted_key text CHECK (redacted_key ~ '^[a-f0-9]{64}$'),
  redacted_sha256 text CHECK (redacted_sha256 ~ '^[a-f0-9]{64}$'),
  redaction jsonb NOT NULL CHECK (jsonb_typeof(redaction) = 'object'),
  -- A reviewer may only ever be shown a verified redacted derivative.
  reviewable boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, name),
  UNIQUE (run_id, sha256),
  CHECK (reviewable = (redacted_key IS NOT NULL)),
  CHECK ((redacted_key IS NULL) = (redacted_sha256 IS NULL)),
  CHECK ((kind, media_type) IN (
    ('trace', 'application/zip'),
    ('assertions', 'application/json'),
    ('report', 'application/json'),
    ('report', 'text/markdown'),
    ('screenshot', 'image/png'),
    ('log', 'text/plain'),
    ('patch', 'text/x-diff'),
    ('test', 'text/plain')
  ))
);
CREATE INDEX evidence_artifacts_run ON evidence_artifacts (run_id, created_at);
CREATE TRIGGER immutable_artifact BEFORE UPDATE OR DELETE ON evidence_artifacts
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- One submission per assignment, pinned to the exact terms and build it ran.
-- A submission records work; it decides nothing and authorizes no payment.
CREATE TABLE evidence_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL UNIQUE REFERENCES runs(id),
  assignment_id uuid NOT NULL UNIQUE REFERENCES assignments(id),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  terms_version_id uuid NOT NULL,
  build_id uuid NOT NULL,
  operator_id uuid NOT NULL REFERENCES operators(id),
  -- A blocked run is not a product failure, and neither is a payable.
  outcome text NOT NULL CHECK (outcome IN ('executed', 'product_failed', 'blocked')),
  blocked_reason text CHECK (blocked_reason IN (
    'invalid_credentials', 'infrastructure_unavailable', 'agent_limitation', 'target_changed'
  )),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  artifact_count integer NOT NULL CHECK (artifact_count > 0),
  total_bytes bigint NOT NULL CHECK (total_bytes > 0),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Acceptance and rejection are a separate recorded decision, not this row.
  decision_state text NOT NULL DEFAULT 'pending_review' CHECK (decision_state = 'pending_review'),
  FOREIGN KEY (campaign_id, assignment_id) REFERENCES assignments (campaign_id, id),
  FOREIGN KEY (assignment_id, terms_version_id, build_id)
    REFERENCES assignments (id, terms_version_id, build_id),
  CHECK ((outcome = 'blocked') = (blocked_reason IS NOT NULL)),
  CHECK (finished_at >= started_at)
);
CREATE INDEX evidence_submissions_campaign ON evidence_submissions (campaign_id, submitted_at DESC);
CREATE TRIGGER immutable_submission BEFORE UPDATE OR DELETE ON evidence_submissions
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- Starting a run needs its own scope. Nothing here can move money or sign a payout.
ALTER TABLE agent_credentials DROP CONSTRAINT agent_credentials_scopes_check;
ALTER TABLE agent_credentials ADD CONSTRAINT agent_credentials_scopes_check CHECK (
  array_length(scopes, 1) BETWEEN 1 AND 6
  AND scopes <@ ARRAY['operator:read', 'work:read', 'qualification:submit',
    'assignments:read', 'assignments:claim', 'runs:execute']
);
