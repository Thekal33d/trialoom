-- Campaign lifecycle. Publication is only reachable with an internal budget.
ALTER TABLE campaigns DROP CONSTRAINT campaigns_status_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_check
  CHECK (status IN ('draft', 'open', 'paused', 'draining', 'cancelled', 'completed'));
ALTER TABLE campaigns
  ADD COLUMN slots integer CHECK (slots BETWEEN 1 AND 1000),
  ADD COLUMN max_concurrent integer CHECK (max_concurrent BETWEEN 1 AND 100),
  ADD COLUMN published_terms_id uuid,
  ADD COLUMN published_by text REFERENCES auth_user(id),
  ADD COLUMN published_at timestamptz,
  ADD COLUMN closed_at timestamptz,
  -- A builder's declared spending authorization. It is not escrow and is not
  -- verified on chain in this step; obligations survive its loss.
  ADD COLUMN spending_authorization text CHECK (length(spending_authorization) BETWEEN 1 AND 200),
  ADD CONSTRAINT campaigns_publication_complete CHECK (
    (status = 'draft') = (published_at IS NULL)
    AND (published_at IS NULL) = (slots IS NULL)
    AND (published_at IS NULL) = (max_concurrent IS NULL)
    AND (published_at IS NULL) = (published_terms_id IS NULL)
    AND (published_at IS NULL) = (published_by IS NULL)
    AND (published_at IS NULL) = (spending_authorization IS NULL)
  );

-- Lets an assignment reference one exact (campaign, terms version, build) triple,
-- so a pinned build can never belong to different terms.
ALTER TABLE terms_versions ADD CONSTRAINT terms_versions_campaign_build UNIQUE (campaign_id, id, build_id);
ALTER TABLE campaigns ADD CONSTRAINT campaigns_published_terms
  FOREIGN KEY (id, published_terms_id) REFERENCES terms_versions (campaign_id, id);

-- The single lock point for every reservation. The invariant is a table check,
-- so no application path can exceed the authorized ceiling.
CREATE TABLE campaign_accounts (
  campaign_id uuid PRIMARY KEY REFERENCES campaigns(id),
  ceiling_units numeric(78, 0) NOT NULL CHECK (ceiling_units >= 0),
  committed_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (committed_units >= 0),
  accepted_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (accepted_units >= 0),
  finalized_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (finalized_units >= 0),
  currency_chain_id integer NOT NULL CHECK (currency_chain_id = 42220),
  currency_address text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT campaign_ceiling_invariant
    CHECK (finalized_units + accepted_units + committed_units <= ceiling_units)
);

-- Appending here is the only way a ceiling rises; it never falls.
CREATE TABLE budget_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  amount_units numeric(78, 0) NOT NULL CHECK (amount_units > 0),
  spending_authorization text NOT NULL,
  authorized_by text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX budget_authorizations_campaign ON budget_authorizations (campaign_id, created_at);
CREATE TRIGGER immutable_authorization BEFORE UPDATE OR DELETE ON budget_authorizations
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL,
  project_id uuid NOT NULL,
  terms_version_id uuid NOT NULL,
  build_id uuid NOT NULL,
  operator_id uuid NOT NULL REFERENCES operators(id),
  credential_id uuid REFERENCES agent_credentials(id),
  state text NOT NULL CHECK (
    state IN ('claimed', 'running', 'submitted', 'accepted', 'rejected', 'released', 'expired', 'cancelled')
  ),
  -- Fences one execution attempt. Expiry retires the token; a later claim is a new assignment.
  attempt_token uuid NOT NULL DEFAULT gen_random_uuid(),
  max_liability_units numeric(78, 0) NOT NULL CHECK (max_liability_units >= 0),
  accepted_units numeric(78, 0),
  lease_expires_at timestamptz NOT NULL,
  deadline timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  closed_reason text CHECK (length(closed_reason) BETWEEN 1 AND 200),
  FOREIGN KEY (campaign_id, terms_version_id, build_id)
    REFERENCES terms_versions (campaign_id, id, build_id),
  FOREIGN KEY (project_id, build_id) REFERENCES builds (project_id, id),
  FOREIGN KEY (project_id, campaign_id) REFERENCES campaigns (project_id, id),
  CHECK (lease_expires_at <= deadline),
  CHECK ((state IN ('claimed', 'running', 'submitted')) = (closed_at IS NULL)),
  CHECK ((state = 'accepted') = (accepted_units IS NOT NULL))
);
-- One live assignment per operator per campaign; a slot frees when it closes.
CREATE UNIQUE INDEX assignments_live_operator ON assignments (campaign_id, operator_id)
  WHERE state IN ('claimed', 'running', 'submitted');
CREATE INDEX assignments_campaign ON assignments (campaign_id, state);
CREATE INDEX assignments_operator ON assignments (operator_id, claimed_at DESC);
CREATE INDEX assignments_lease ON assignments (lease_expires_at) WHERE state IN ('claimed', 'running');

-- Append-only money history. Replaying these entries must reproduce the account row.
CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  assignment_id uuid REFERENCES assignments(id),
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL CHECK (kind IN ('authorize', 'commit', 'release', 'reclassify', 'finalize')),
  category text NOT NULL CHECK (category IN ('ceiling', 'execution', 'discovery', 'resource', 'fee')),
  amount_units numeric(78, 0) NOT NULL CHECK (amount_units > 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  actor_id text REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'authorize') = (category = 'ceiling')),
  CHECK (kind = 'authorize' OR assignment_id IS NOT NULL)
);
CREATE INDEX ledger_entries_campaign ON ledger_entries (campaign_id, sequence);
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- Claiming work needs its own scopes. Nothing here can move money or sign a payout.
ALTER TABLE agent_credentials DROP CONSTRAINT agent_credentials_scopes_check;
ALTER TABLE agent_credentials ADD CONSTRAINT agent_credentials_scopes_check CHECK (
  array_length(scopes, 1) BETWEEN 1 AND 5
  AND scopes <@ ARRAY['operator:read', 'work:read', 'qualification:submit',
    'assignments:read', 'assignments:claim']
);
