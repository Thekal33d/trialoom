-- Where a workspace wants to be told. A notice has to leave the platform to be
-- a notice at all, so the destination is held to the same admission rules as a
-- test target: HTTPS, no credentials in the URL, and an address that is not in
-- private space.
--
-- The shared secret is stored rather than digested, which is the opposite of
-- how a runner host's credential is kept. The asymmetry is inherent: a host
-- presents its credential and the platform only has to recognise it, while
-- here the platform has to present a signature, so it needs the key. It is
-- never returned after registration, never selected by a read path, and never
-- travels in a notice.
CREATE TABLE notice_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  url text NOT NULL CHECK (url ~ '^https://' AND length(url) BETWEEN 12 AND 2048),
  signing_secret text NOT NULL CHECK (signing_secret ~ '^trn_[A-Za-z0-9_-]{32,}$'),
  registered_by text NOT NULL REFERENCES auth_user(id),
  revoked_at timestamptz,
  last_delivery_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- One live destination per workspace: two would make "has anyone been told?"
-- a question with two answers.
CREATE UNIQUE INDEX notice_endpoints_live ON notice_endpoints (workspace_id)
  WHERE revoked_at IS NULL;

-- Something the platform needs a person to know. A notice is raised when a
-- condition becomes true and resolved when it stops being true, so a condition
-- that persists does not announce itself every time it is re-read.
CREATE TABLE notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  topic text NOT NULL CHECK (
    topic IN ('authority.short', 'authority.unreadable', 'authority.inactive')
  ),
  subject_id uuid NOT NULL,
  -- Composed by the platform from its own records. No operator prose reaches
  -- a destination the platform does not control.
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 300),
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  -- The same guard the event stream uses, at any depth: nothing that leaves
  -- the platform may carry a key, a grant or a credential.
  CONSTRAINT notices_detail_clean CHECK (event_payload_is_clean(detail)),
  raised_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  resolved_reason text CHECK (length(resolved_reason) BETWEEN 1 AND 200),
  -- 'undeliverable' is a workspace with nowhere to be told; 'suppressed' is a
  -- condition that resolved before anyone was told, which is worth recording
  -- rather than quietly dropping.
  delivery text NOT NULL DEFAULT 'pending'
    CHECK (delivery IN ('pending', 'delivered', 'failed', 'undeliverable', 'suppressed')),
  endpoint_id uuid REFERENCES notice_endpoints(id),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  delivered_at timestamptz,
  last_error text CHECK (length(last_error) BETWEEN 1 AND 300),
  CHECK ((delivery = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((resolved_at IS NULL) = (resolved_reason IS NULL))
);
-- One open notice per condition per subject. This is the deduplication: the
-- recurring read runs every six hours and must not announce the same shortfall
-- four times a day.
CREATE UNIQUE INDEX notices_open ON notices (topic, subject_id) WHERE resolved_at IS NULL;
CREATE INDEX notices_workspace ON notices (workspace_id, raised_at DESC);

-- Every delivery attempt, append-only, so "nobody was told" and "we tried
-- four times and the endpoint refused" are different answers.
CREATE TABLE notice_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id uuid NOT NULL REFERENCES notices(id),
  endpoint_id uuid REFERENCES notice_endpoints(id),
  transport text NOT NULL CHECK (length(transport) BETWEEN 1 AND 40),
  delivered boolean NOT NULL,
  status integer CHECK (status BETWEEN 100 AND 599),
  detail text NOT NULL CHECK (length(detail) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX notice_attempts_notice ON notice_attempts (notice_id, created_at);
CREATE TRIGGER immutable_notice_attempt BEFORE UPDATE OR DELETE ON notice_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

ALTER TABLE outbox_jobs DROP CONSTRAINT outbox_jobs_topic_check;
ALTER TABLE outbox_jobs ADD CONSTRAINT outbox_jobs_topic_check
  CHECK (topic IN (
    'system.ping', 'payout.dispatch', 'resource.reconcile', 'authority.verify', 'notice.deliver'
  ));
