-- Operator identity is platform-level and bound to one authenticated account.
-- A builder workspace admits an operator through an ALPHA-02 'operator' membership.
CREATE TABLE operators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL UNIQUE REFERENCES auth_user(id),
  handle text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  status text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Server-generated EIP-4361 challenges. The message is stored verbatim so proof
-- verification never trusts a client-supplied message.
CREATE TABLE wallet_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  nonce text NOT NULL UNIQUE CHECK (nonce ~ '^[a-zA-Z0-9]{8,128}$'),
  chain_id integer NOT NULL CHECK (chain_id = 42220),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE INDEX wallet_challenges_operator ON wallet_challenges (operator_id, issued_at DESC);

-- A proven wallet is a payout identity candidate. Signatures prove control of a
-- key, not correctness of work and not independent ownership of an agent.
CREATE TABLE operator_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  chain_id integer NOT NULL CHECK (chain_id = 42220),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  account_type text NOT NULL DEFAULT 'eoa' CHECK (account_type = 'eoa'),
  challenge_id uuid NOT NULL UNIQUE REFERENCES wallet_challenges(id),
  proof_message text NOT NULL,
  signature_hash text NOT NULL CHECK (signature_hash ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payout_designated_at timestamptz,
  revoked_at timestamptz
);
-- One live claim per address across all operators, and one live payout wallet each.
CREATE UNIQUE INDEX operator_wallets_live_address ON operator_wallets (chain_id, lower(address))
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX operator_wallets_payout ON operator_wallets (operator_id)
  WHERE revoked_at IS NULL AND payout_designated_at IS NOT NULL;
CREATE INDEX operator_wallets_operator ON operator_wallets (operator_id);

-- Scoped, expiring, revocable agent credentials. Only the SHA-256 digest is stored.
-- No scope in this allowlist can claim work, move money, or sign payouts.
CREATE TABLE agent_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  secret_hash text NOT NULL UNIQUE CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] NOT NULL CHECK (
    array_length(scopes, 1) BETWEEN 1 AND 3
    AND scopes <@ ARRAY['operator:read', 'work:read', 'qualification:submit']
  ),
  created_by text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX agent_credentials_operator ON agent_credentials (operator_id, created_at DESC);

-- Seeded qualification tasks. `answer_key` is graded server-side and is never
-- served through the agent API.
CREATE TABLE qualification_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,60}$'),
  version integer NOT NULL CHECK (version > 0),
  service text NOT NULL CHECK (service IN ('test', 'bug_discovery', 'repair')),
  active boolean NOT NULL DEFAULT true,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  brief jsonb NOT NULL CHECK (jsonb_typeof(brief) = 'object'),
  answer_key jsonb NOT NULL CHECK (jsonb_typeof(answer_key) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (slug, version)
);
CREATE UNIQUE INDEX qualification_tasks_active_slug ON qualification_tasks (slug) WHERE active;

-- Attempts are the immutable record. Eligibility is a derived projection.
CREATE TABLE qualification_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  task_id uuid NOT NULL REFERENCES qualification_tasks(id),
  credential_id uuid REFERENCES agent_credentials(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  submission jsonb NOT NULL CHECK (jsonb_typeof(submission) = 'object'),
  outcome text NOT NULL CHECK (outcome IN ('correct', 'incorrect', 'false_report')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (operator_id, task_id, attempt_number)
);
CREATE INDEX qualification_attempts_operator ON qualification_attempts (operator_id, submitted_at);
CREATE TRIGGER immutable_attempt BEFORE UPDATE OR DELETE ON qualification_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

CREATE TABLE operator_eligibility (
  operator_id uuid NOT NULL REFERENCES operators(id),
  service text NOT NULL CHECK (service IN ('test', 'bug_discovery', 'repair')),
  state text NOT NULL CHECK (state IN ('eligible', 'ineligible')),
  reason text NOT NULL CHECK (
    reason IN ('qualified', 'incomplete', 'false_report', 'accuracy_below_threshold')
  ),
  tasks_total integer NOT NULL CHECK (tasks_total >= 0),
  tasks_passed integer NOT NULL CHECK (tasks_passed >= 0),
  attempts integer NOT NULL CHECK (attempts >= 0),
  correct integer NOT NULL CHECK (correct >= 0),
  false_reports integer NOT NULL CHECK (false_reports >= 0),
  evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operator_id, service)
);

-- Idempotency is keyed to the operator, not a credential, so a rotated
-- credential cannot replay a retried mutation as a new one.
CREATE TABLE agent_idempotency (
  operator_id uuid NOT NULL REFERENCES operators(id),
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  credential_id uuid NOT NULL REFERENCES agent_credentials(id),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status integer CHECK (status BETWEEN 100 AND 599),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operator_id, key)
);

-- Seeded reference tasks. Graded fields must match exactly; a control task that
-- is reported as defective records a false report.
INSERT INTO qualification_tasks (slug, version, service, brief, answer_key) VALUES
('invite-alias-defect', 1, 'bug_discovery',
 '{"fixture":"browser-evidence/invitation","build":"baseline","instructions":"Run the seeded invitation journey against the baseline build and report whether the plus-addressed invitation is accepted.","reportFields":["defectPresent","failingStep","expectedStatus","observedStatus"]}',
 '{"gradedFields":{"defectPresent":true,"failingStep":"invitation.create","expectedStatus":201,"observedStatus":400}}'),
('invite-alias-repaired', 1, 'bug_discovery',
 '{"fixture":"browser-evidence/invitation","build":"candidate","instructions":"Run the same journey against the repaired candidate build. Report a defect only if one is observed.","reportFields":["defectPresent","failingStep","expectedStatus","observedStatus"]}',
 '{"gradedFields":{"defectPresent":false,"failingStep":null,"expectedStatus":201,"observedStatus":201}}'),
('regression-pins-revision', 1, 'repair',
 '{"fixture":"browser-evidence/invitation","instructions":"Run the candidate regression test on both revisions and report each result.","reportFields":["defectPresent","baselineResult","candidateResult"]}',
 '{"gradedFields":{"defectPresent":true,"baselineResult":"failed","candidateResult":"passed"}}'),
('journey-step-accuracy', 1, 'test',
 '{"fixture":"browser-evidence/invitation","build":"baseline","instructions":"Report the number of journey steps executed and the first step that failed.","reportFields":["defectPresent","stepsExecuted","failingStep"]}',
 '{"gradedFields":{"defectPresent":true,"stepsExecuted":4,"failingStep":"invitation.create"}}');
