-- A repair is quoted separately before it is ever assigned, against one
-- confirmed defect, one base build, and the files it may touch.
CREATE TABLE repair_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  defect_id uuid NOT NULL REFERENCES defects(id),
  -- The campaign that funds this repair. One quote per campaign, so an
  -- approved quote cannot quietly cover a second piece of work.
  campaign_id uuid NOT NULL UNIQUE REFERENCES campaigns(id),
  operator_id uuid NOT NULL REFERENCES operators(id),
  base_build_id uuid NOT NULL,
  base_revision text NOT NULL CHECK (length(base_revision) BETWEEN 1 AND 200),
  amount_units numeric(78, 0) NOT NULL CHECK (amount_units > 0),
  -- The paths this repair may change. Anything else needs a revised quote.
  scope_paths jsonb NOT NULL CHECK (jsonb_typeof(scope_paths) = 'array'),
  state text NOT NULL CHECK (state IN ('proposed', 'approved', 'rejected', 'withdrawn')),
  proposed_by text NOT NULL REFERENCES auth_user(id),
  approved_by text REFERENCES auth_user(id),
  approved_at timestamptz,
  decided_reason text CHECK (length(decided_reason) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, base_build_id) REFERENCES builds (project_id, id),
  FOREIGN KEY (project_id, campaign_id) REFERENCES campaigns (project_id, id),
  CHECK ((state = 'approved') = (approved_at IS NOT NULL)),
  CHECK ((approved_at IS NULL) = (approved_by IS NULL))
);
CREATE INDEX repair_quotes_defect ON repair_quotes (defect_id, created_at DESC);

-- One delivered repair per assignment, recorded exactly as it was submitted.
CREATE TABLE repairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL UNIQUE REFERENCES repair_quotes(id),
  defect_id uuid NOT NULL REFERENCES defects(id),
  campaign_id uuid NOT NULL,
  assignment_id uuid NOT NULL UNIQUE,
  submission_id uuid NOT NULL UNIQUE REFERENCES evidence_submissions(id),
  operator_id uuid NOT NULL REFERENCES operators(id),
  base_revision text NOT NULL CHECK (length(base_revision) BETWEEN 1 AND 200),
  -- A candidate that equals its base changes nothing and proves nothing.
  candidate_revision text NOT NULL CHECK (length(candidate_revision) BETWEEN 1 AND 200),
  changed_files jsonb NOT NULL CHECK (jsonb_typeof(changed_files) = 'array'),
  patch_sha256 text NOT NULL CHECK (patch_sha256 ~ '^[a-f0-9]{64}$'),
  test_sha256 text NOT NULL CHECK (test_sha256 ~ '^[a-f0-9]{64}$'),
  -- The replays and required checks the operator reported, as reported.
  regression jsonb NOT NULL CHECK (jsonb_typeof(regression) = 'object'),
  required_checks jsonb NOT NULL CHECK (jsonb_typeof(required_checks) = 'array'),
  -- The gate is the rule Trialoom applies to that report, not a re-execution.
  -- A repair row exists only for evidence that passed it; a report that does
  -- not demonstrate a regression fix is refused and can be corrected instead.
  gate_state text NOT NULL CHECK (gate_state = 'passed'),
  gate_detail text NOT NULL CHECK (length(gate_detail) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (campaign_id, assignment_id) REFERENCES assignments (campaign_id, id),
  CHECK (candidate_revision <> base_revision)
);
CREATE INDEX repairs_defect ON repairs (defect_id, created_at DESC);
CREATE TRIGGER immutable_repair BEFORE UPDATE OR DELETE ON repairs
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- An independent verifier's own result. A signature is not evidence, so a
-- verification carries its own replays and artifact references.
CREATE TABLE repair_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_id uuid NOT NULL REFERENCES repairs(id),
  verifier_operator_id uuid NOT NULL REFERENCES operators(id),
  assignment_id uuid NOT NULL REFERENCES assignments(id),
  submission_id uuid NOT NULL UNIQUE REFERENCES evidence_submissions(id),
  outcome text NOT NULL CHECK (outcome IN ('confirmed', 'refuted', 'inconclusive')),
  regression jsonb NOT NULL CHECK (jsonb_typeof(regression) = 'object'),
  evidence_refs jsonb NOT NULL CHECK (jsonb_typeof(evidence_refs) = 'array'),
  detail text NOT NULL CHECK (length(detail) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- One verification per operator per repair.
  UNIQUE (repair_id, verifier_operator_id)
);
CREATE INDEX repair_verifications_repair ON repair_verifications (repair_id, created_at);
CREATE TRIGGER immutable_verification BEFORE UPDATE OR DELETE ON repair_verifications
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- Where a defect stands on being fixed, separate from whether it is confirmed.
ALTER TABLE defects ADD COLUMN repair_state text NOT NULL DEFAULT 'none'
  CHECK (repair_state IN ('none', 'quoted', 'delivered', 'verified', 'accepted'));
