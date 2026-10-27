-- A submission is immutable, so its review state is derived from decisions
-- rather than stamped back onto the record of what was submitted.
ALTER TABLE evidence_submissions DROP COLUMN decision_state;

-- The defect is the thing being reported, not one report of it. Clustering is
-- deterministic: the same failure signature on the same build is the same
-- defect. Judgement belongs to a recorded decision, never to this grouping.
CREATE TABLE defects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  build_id uuid NOT NULL,
  signature_hash text NOT NULL CHECK (signature_hash ~ '^[a-f0-9]{64}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- Severity is a reviewer's call against the published rubric, so it stays
  -- empty until one is recorded.
  severity text CHECK (severity IN ('blocking', 'major', 'minor')),
  state text NOT NULL CHECK (state IN ('unconfirmed', 'confirmed', 'flaky', 'out_of_scope', 'rejected')),
  -- The finding that earned the discovery reward. One per defect, ever.
  awarded_finding_id uuid,
  review_flag text CHECK (review_flag IN ('uncertain_duplicate', 'independence_failed', 'inconsistent_result')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, build_id) REFERENCES builds (project_id, id),
  UNIQUE (project_id, build_id, signature_hash)
);
CREATE INDEX defects_project ON defects (project_id, created_at DESC);

-- One report of a defect, derived from one submission.
CREATE TABLE findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  defect_id uuid REFERENCES defects(id),
  project_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  assignment_id uuid NOT NULL UNIQUE,
  submission_id uuid NOT NULL UNIQUE REFERENCES evidence_submissions(id),
  operator_id uuid NOT NULL REFERENCES operators(id),
  build_id uuid NOT NULL,
  signature_hash text NOT NULL CHECK (signature_hash ~ '^[a-f0-9]{64}$'),
  signature jsonb NOT NULL CHECK (jsonb_typeof(signature) = 'object'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  proposed_severity text CHECK (proposed_severity IN ('blocking', 'major', 'minor')),
  -- What deterministic clustering saw, not what anyone decided.
  match text NOT NULL CHECK (match IN ('first', 'exact', 'uncertain')),
  -- Whether this report can count as independent reproduction of the defect.
  independent boolean NOT NULL,
  independence_reason text CHECK (length(independence_reason) BETWEEN 1 AND 300),
  state text NOT NULL CHECK (state IN (
    'submitted', 'duplicate', 'confirmed', 'inconclusive', 'out_of_scope', 'disputed'
  )),
  candidate_defect_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (campaign_id, assignment_id) REFERENCES assignments (campaign_id, id),
  FOREIGN KEY (project_id, build_id) REFERENCES builds (project_id, id),
  -- An unclustered report is exactly one awaiting review.
  CHECK ((defect_id IS NULL) = (match = 'uncertain')),
  CHECK (independent OR independence_reason IS NOT NULL)
);
CREATE INDEX findings_defect ON findings (defect_id, created_at);
CREATE INDEX findings_campaign ON findings (campaign_id, created_at DESC);
ALTER TABLE defects ADD CONSTRAINT defects_awarded_finding
  FOREIGN KEY (awarded_finding_id) REFERENCES findings(id);

-- Every acceptance, rejection, duplicate call, severity change and appeal, with
-- the criteria applied, the reason, the evidence it rests on, and who is
-- responsible. These rows are never edited; a change is another decision.
CREATE TABLE decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  assignment_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('submission', 'finding')),
  subject_id uuid NOT NULL,
  matter text NOT NULL CHECK (matter IN ('execution', 'discovery', 'severity', 'duplicate', 'appeal')),
  outcome text NOT NULL CHECK (outcome IN (
    'accepted', 'rejected', 'awarded', 'declined', 'duplicate', 'changed', 'opened', 'upheld', 'overturned'
  )),
  criteria text NOT NULL CHECK (length(criteria) BETWEEN 1 AND 4000),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 2000),
  evidence_refs jsonb NOT NULL CHECK (jsonb_typeof(evidence_refs) = 'array'),
  amount_units numeric(78, 0) CHECK (amount_units >= 0),
  -- Only a person acts. No model, agent or signature can post a decision.
  actor_id text NOT NULL REFERENCES auth_user(id),
  actor_role text NOT NULL CHECK (actor_role IN ('owner', 'reviewer', 'operator')),
  appeal_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (campaign_id, assignment_id) REFERENCES assignments (campaign_id, id),
  -- Only a builder-side decision can carry money, and only an operator appeals.
  CHECK ((amount_units IS NULL) OR actor_role IN ('owner', 'reviewer')),
  CHECK ((matter = 'appeal' AND outcome = 'opened') = (actor_role = 'operator'))
);
CREATE INDEX decisions_subject ON decisions (subject_type, subject_id, created_at);
CREATE INDEX decisions_campaign ON decisions (campaign_id, created_at DESC);
-- One settled decision per matter: a later change is an appeal, not an edit.
CREATE UNIQUE INDEX decisions_one_execution ON decisions (assignment_id)
  WHERE matter = 'execution';
CREATE UNIQUE INDEX decisions_one_discovery ON decisions (subject_id)
  WHERE matter = 'discovery';
CREATE UNIQUE INDEX decisions_one_open_appeal ON decisions (assignment_id)
  WHERE matter = 'appeal' AND outcome = 'opened';
CREATE TRIGGER immutable_decision BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- A rejected amount stays committed while it can still be appealed, so the
-- reservation is released on a schedule rather than at the decision.
ALTER TABLE assignments
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN release_after timestamptz;
CREATE INDEX assignments_release ON assignments (release_after)
  WHERE release_after IS NOT NULL;

-- Operators read their decisions and open an appeal. Neither scope moves money.
ALTER TABLE agent_credentials DROP CONSTRAINT agent_credentials_scopes_check;
ALTER TABLE agent_credentials ADD CONSTRAINT agent_credentials_scopes_check CHECK (
  array_length(scopes, 1) BETWEEN 1 AND 8
  AND scopes <@ ARRAY['operator:read', 'work:read', 'qualification:submit',
    'assignments:read', 'assignments:claim', 'runs:execute',
    'decisions:read', 'appeals:submit']
);
