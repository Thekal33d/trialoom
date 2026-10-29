-- A spending authorization is not escrow, and on Celo it is not even private to
-- one campaign: a token approval is granted by an owner to a spender contract,
-- and Remesso's own documentation states that "that one approval is shared by
-- all their policies for the token" and that "a policy has no total of its own".
-- A per-campaign budget therefore proves nothing about ability to pay. Two live
-- campaigns can each hold a ceiling the builder authorized, each name their own
-- policy, and still be funded by a single approval that only one of them can
-- actually drain.
--
-- So the contended thing is modelled directly. An approval is identified by the
-- tuple that identifies it on chain -- the token, the payer and the chain --
-- not by the workspace or the policy that happens to reference it. Everything
-- that spends through it commits against one row, and one table check refuses
-- the overcommitment that no local test could otherwise produce.
CREATE TABLE payment_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id integer NOT NULL CHECK (chain_id = 42220),
  token_address text NOT NULL CHECK (token_address ~ '^0x[0-9a-fA-F]{40}$'),
  payer_address text NOT NULL CHECK (payer_address ~ '^0x[0-9a-fA-F]{40}$'),
  -- What the builder states the spender may still draw, in token base units.
  -- It mirrors a token approval rather than a budget: a top-up raises it, and
  -- settlement lowers it, because a transfer really does consume an approval.
  declared_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (declared_units >= 0),
  committed_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (committed_units >= 0),
  settled_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (settled_units >= 0),
  -- What the chain last said, through a reader that names itself. NULL means
  -- nobody has looked; it is never assumed to equal the declaration.
  observed_allowance_units numeric(78, 0) CHECK (observed_allowance_units >= 0),
  observed_balance_units numeric(78, 0) CHECK (observed_balance_units >= 0),
  observed_at timestamptz,
  state text NOT NULL DEFAULT 'declared'
    CHECK (state IN ('declared', 'verified', 'short', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (chain_id, token_address, payer_address),
  -- The whole point of the table. Nothing may be committed against an approval
  -- beyond what it is declared to still hold, however many campaigns are
  -- asking and however their own budgets were authorized.
  CONSTRAINT payment_approval_ceiling CHECK (committed_units <= declared_units),
  CONSTRAINT payment_approval_observation
    CHECK ((observed_at IS NULL) = (observed_allowance_units IS NULL)
      AND (observed_at IS NULL) = (observed_balance_units IS NULL))
);

-- A workspace's named handle on one approval: which provider signs, under which
-- policy, as which agent. Several authorities may point at one approval, which
-- is exactly the case the ceiling above exists to catch.
CREATE TABLE payment_authorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  approval_id uuid NOT NULL REFERENCES payment_approvals(id),
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 120),
  provider text NOT NULL CHECK (provider IN ('remesso')),
  -- The Remesso policy this workspace spends under. A policy bounds each
  -- payment and each day; it does not reserve anything.
  policy_id text NOT NULL CHECK (policy_id ~ '^[0-9]{1,40}$'),
  -- The address Trialoom signs with. It is the spender, not the payer.
  agent_address text NOT NULL CHECK (agent_address ~ '^0x[0-9a-fA-F]{40}$'),
  registered_by text NOT NULL REFERENCES auth_user(id),
  revoked_at timestamptz,
  revoked_reason text CHECK (length(revoked_reason) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, reference),
  CHECK ((revoked_at IS NULL) OR (revoked_reason IS NOT NULL))
);
CREATE INDEX payment_authorities_live ON payment_authorities (workspace_id)
  WHERE revoked_at IS NULL;

-- Every move on an approval, append-only, so the row is replayable from the
-- entries the way the campaign ledger is. A release is derived from these, so
-- closing a campaign twice releases nothing the second time.
CREATE TABLE payment_approval_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id uuid NOT NULL REFERENCES payment_approvals(id),
  authority_id uuid REFERENCES payment_authorities(id),
  campaign_id uuid REFERENCES campaigns(id),
  kind text NOT NULL CHECK (kind IN ('declare', 'commit', 'settle', 'release')),
  amount_units numeric(78, 0) NOT NULL CHECK (amount_units > 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  actor_id text REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Only a declaration stands alone; every other move belongs to a campaign.
  CHECK ((kind = 'declare') = (campaign_id IS NULL))
);
CREATE INDEX payment_approval_entries_approval
  ON payment_approval_entries (approval_id, created_at);
CREATE INDEX payment_approval_entries_campaign ON payment_approval_entries (campaign_id);
CREATE TRIGGER immutable_approval_entry BEFORE UPDATE OR DELETE ON payment_approval_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- What was read, by whom, when. An observation is evidence, so it is kept
-- rather than overwritten by the next read.
CREATE TABLE payment_approval_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id uuid NOT NULL REFERENCES payment_approvals(id),
  authority_id uuid REFERENCES payment_authorities(id),
  reader text NOT NULL CHECK (length(reader) BETWEEN 1 AND 60),
  allowance_units numeric(78, 0) NOT NULL CHECK (allowance_units >= 0),
  balance_units numeric(78, 0) NOT NULL CHECK (balance_units >= 0),
  policy_active boolean NOT NULL,
  committed_at_read numeric(78, 0) NOT NULL CHECK (committed_at_read >= 0),
  detail text NOT NULL CHECK (length(detail) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payment_approval_observations_approval
  ON payment_approval_observations (approval_id, created_at DESC);
CREATE TRIGGER immutable_approval_observation
  BEFORE UPDATE OR DELETE ON payment_approval_observations
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- Which authority funds this campaign, and which authorization committed under
-- it. Both stay nullable: a workspace with no registered authority publishes
-- exactly as before, against a free-text reference that pays nobody.
ALTER TABLE campaigns ADD COLUMN authority_id uuid REFERENCES payment_authorities(id);
ALTER TABLE budget_authorizations ADD COLUMN authority_id uuid
  REFERENCES payment_authorities(id);
-- A payment carries the authority that was committed for it, so the worker
-- knows which policy to spend under without re-deriving it from the campaign.
ALTER TABLE payables ADD COLUMN authority_id uuid REFERENCES payment_authorities(id);
