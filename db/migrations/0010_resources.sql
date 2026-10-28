-- Reconciliation joins the outbox. A purchase's intent key is its dedupe key,
-- so a repeated event can never become a second authorization.
ALTER TABLE outbox_jobs DROP CONSTRAINT outbox_jobs_topic_check;
ALTER TABLE outbox_jobs ADD CONSTRAINT outbox_jobs_topic_check
  CHECK (topic IN ('system.ping', 'payout.dispatch', 'resource.reconcile'));

-- Trialoom's own exposure, not the builder's. A builder authorization says what
-- they will reimburse; it says nothing about whether the platform resource
-- wallet can fund the purchase in the first place, so that cap lives here and
-- is enforced by a check rather than by the code that spends against it.
CREATE TABLE resource_accounts (
  id text PRIMARY KEY CHECK (id = 'platform'),
  ceiling_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (ceiling_units >= 0),
  reserved_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  settled_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (settled_units >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (reserved_units + settled_units <= ceiling_units)
);
-- Seeded at nothing. No funded resource wallet exists in this build, so every
-- purchase is refused until an operator of the platform raises this.
INSERT INTO resource_accounts (id) VALUES ('platform');

CREATE TABLE resource_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_units numeric(78, 0) NOT NULL CHECK (amount_units > 0),
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_resource_authorization BEFORE UPDATE OR DELETE ON resource_authorizations
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- One purchase, one durable identity, from the quote to the reconciled receipt.
-- The authorized ceiling is the limit the call was made under: an actual cost
-- can never exceed it, and the quote must already fit inside it.
CREATE TABLE resource_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  assignment_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES runs(id),
  operator_id uuid NOT NULL REFERENCES operators(id),
  provider text NOT NULL CHECK (provider IN ('buy')),
  sku text NOT NULL CHECK (length(sku) BETWEEN 1 AND 80),
  request jsonb NOT NULL,
  quoted_units numeric(78, 0) NOT NULL CHECK (quoted_units > 0),
  ceiling_units numeric(78, 0) NOT NULL CHECK (ceiling_units > 0),
  cost_units numeric(78, 0) CHECK (cost_units >= 0),
  currency_chain_id integer NOT NULL CHECK (currency_chain_id = 42220),
  currency_address text NOT NULL,
  currency_decimals integer NOT NULL CHECK (currency_decimals = 6),
  payee_address text NOT NULL CHECK (payee_address ~ '^0x[0-9a-fA-F]{40}$'),
  quoted_at timestamptz NOT NULL,
  quote_expires_at timestamptz NOT NULL,
  -- The immutable identity reconciliation asks about. One purchase, one key.
  intent_key text NOT NULL UNIQUE CHECK (intent_key ~ '^trr_[a-f0-9]{48}$'),
  -- The caller's key for this purchase. A retried request returns the purchase
  -- it already started instead of authorizing a second one.
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  state text NOT NULL CHECK (state IN (
    'quoted', 'reserved', 'submitted', 'usable', 'reconciled', 'refused', 'failed', 'uncertain'
  )),
  reason text CHECK (reason IN (
    'resource_authority_unavailable', 'resource_ceiling_exceeded', 'allowance_exceeded',
    'quote_above_limit', 'quote_expired', 'provider_refused', 'provision_failed',
    'settlement_uncertain', 'response_lost'
  )),
  -- Who bears the cost. 'pending' holds the reservation; the platform absorbs a
  -- purchase it could not deliver and never passes it on as completed testing.
  charge text NOT NULL DEFAULT 'pending'
    CHECK (charge IN ('pending', 'builder', 'platform_absorbed', 'none')),
  receipt jsonb,
  transaction_hash text CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- One reimbursement for one purchase, ever: the database, not the code, is
  -- what makes a cost already reimbursed impossible to reimburse again.
  reimbursement_id uuid UNIQUE REFERENCES payables(id),
  submitted_at timestamptz,
  usable_at timestamptz,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (campaign_id, assignment_id) REFERENCES assignments (campaign_id, id),
  UNIQUE (assignment_id, idempotency_key),
  -- The quote has to fit the limit the caller authorized, and the cost has to
  -- fit the quote's ceiling: an explicit limit that could be exceeded is none.
  CHECK (quoted_units <= ceiling_units),
  CHECK (cost_units IS NULL OR cost_units <= ceiling_units),
  CHECK ((state IN ('refused', 'failed', 'uncertain')) = (reason IS NOT NULL)),
  CHECK ((state = 'reconciled') = (reconciled_at IS NOT NULL)),
  CHECK ((usable_at IS NULL) OR (submitted_at IS NOT NULL)),
  -- Nothing was sent in these states, so nothing can be owed for them.
  CHECK (charge <> 'builder' OR state IN ('submitted', 'usable', 'reconciled', 'uncertain')),
  CHECK (reimbursement_id IS NULL OR charge = 'builder'),
  CHECK (charge = 'pending' OR state <> 'reserved')
);
CREATE INDEX resource_purchases_assignment ON resource_purchases (assignment_id, created_at);
CREATE INDEX resource_purchases_campaign ON resource_purchases (campaign_id, created_at DESC);
-- Every purchase still holding part of an allowance, which is what the release
-- guard and the remaining-allowance check both ask for.
CREATE INDEX resource_purchases_open ON resource_purchases (assignment_id)
  WHERE reconciled_at IS NULL;

-- A purchase identity is fixed once. The state, cost, receipt and timestamps
-- move forward; the key, the authorized ceiling, the token, the payee and the
-- assignment never change, and a recorded cost or receipt is never rewritten.
CREATE FUNCTION prevent_resource_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent_key <> OLD.intent_key
    OR NEW.ceiling_units <> OLD.ceiling_units
    OR NEW.quoted_units <> OLD.quoted_units
    OR NEW.currency_chain_id <> OLD.currency_chain_id
    OR NEW.currency_address <> OLD.currency_address
    OR NEW.payee_address <> OLD.payee_address
    OR NEW.assignment_id <> OLD.assignment_id
    OR NEW.run_id <> OLD.run_id
    OR NEW.provider <> OLD.provider
    OR NEW.sku <> OLD.sku
    OR (OLD.cost_units IS NOT NULL AND NEW.cost_units IS DISTINCT FROM OLD.cost_units)
    OR (OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash)
    OR (OLD.reimbursement_id IS NOT NULL AND NEW.reimbursement_id IS DISTINCT FROM OLD.reimbursement_id)
  THEN
    RAISE EXCEPTION 'Resource purchase identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_resource_identity BEFORE UPDATE ON resource_purchases
  FOR EACH ROW EXECUTE FUNCTION prevent_resource_identity_change();
CREATE TRIGGER no_resource_purchase_delete BEFORE DELETE ON resource_purchases
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- Every quote, authorization and reconciliation observation, append-only.
CREATE TABLE resource_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES resource_purchases(id),
  adapter text NOT NULL CHECK (length(adapter) BETWEEN 1 AND 60),
  action text NOT NULL CHECK (action IN ('quote', 'purchase', 'resolve')),
  result text NOT NULL CHECK (result IN (
    'quoted', 'submitted', 'usable', 'settled', 'unsettled', 'uncertain', 'refused'
  )),
  transaction_hash text CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  detail text NOT NULL CHECK (length(detail) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX resource_attempts_purchase ON resource_attempts (purchase_id, created_at);
CREATE TRIGGER immutable_resource_attempt BEFORE UPDATE OR DELETE ON resource_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- A reimbursement is a transfer like any other, but it answers to a purchase
-- rather than to a decision, and only one can ever exist for that purchase.
ALTER TABLE payables ALTER COLUMN decision_id DROP NOT NULL;
ALTER TABLE payables ADD COLUMN resource_purchase_id uuid UNIQUE REFERENCES resource_purchases(id);
ALTER TABLE payables DROP CONSTRAINT payables_kind_check;
ALTER TABLE payables ADD CONSTRAINT payables_kind_check
  CHECK (kind IN ('operator', 'platform_fee', 'resource'));
-- payables_check6 is the generated name of 0008's `(kind = 'platform_fee') =
-- (category = 'fee')`, which a resource reimbursement cannot satisfy. Its
-- replacement is named, so no later migration has to count checks.
ALTER TABLE payables DROP CONSTRAINT payables_check6;
ALTER TABLE payables ADD CONSTRAINT payables_kind_category CHECK (
  CASE kind WHEN 'platform_fee' THEN category = 'fee'
    WHEN 'resource' THEN category = 'resource'
    ELSE category <> 'fee' END
);
ALTER TABLE payables ADD CONSTRAINT payables_resource_identity
  CHECK ((kind = 'resource') = (resource_purchase_id IS NOT NULL));
-- Only a reimbursement stands outside a decision; nothing else may.
ALTER TABLE payables ADD CONSTRAINT payables_decision_required
  CHECK ((decision_id IS NULL) = (kind = 'resource'));
ALTER TABLE payables DROP CONSTRAINT payables_blocked_reason_check;
ALTER TABLE payables ADD CONSTRAINT payables_blocked_reason_check CHECK (blocked_reason IN (
  'no_payout_wallet', 'fee_recipient_unconfigured', 'payment_authority_unavailable',
  'authority_revoked', 'insufficient_balance', 'policy_expired', 'awaiting_operator_settlement',
  'resource_recipient_unconfigured'
));

-- The identity trigger predates a nullable decision, where <> yields NULL and
-- would wave an overwrite through.
CREATE OR REPLACE FUNCTION prevent_payout_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_key <> OLD.operation_key
    OR NEW.amount_units <> OLD.amount_units
    OR NEW.currency_chain_id <> OLD.currency_chain_id
    OR NEW.currency_address <> OLD.currency_address
    OR NEW.decision_id IS DISTINCT FROM OLD.decision_id
    OR NEW.resource_purchase_id IS DISTINCT FROM OLD.resource_purchase_id
    OR NEW.assignment_id <> OLD.assignment_id
    OR NEW.kind <> OLD.kind
    -- A recipient may be filled in once; an approved one is never replaced.
    OR (OLD.recipient_address IS NOT NULL AND NEW.recipient_address IS DISTINCT FROM OLD.recipient_address)
    OR (OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash)
  THEN
    RAISE EXCEPTION 'Payout identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- An operator buys a capped resource for the run it is executing. The scope
-- cannot pay anyone, choose the payee, or raise the platform's ceiling.
ALTER TABLE agent_credentials DROP CONSTRAINT agent_credentials_scopes_check;
ALTER TABLE agent_credentials ADD CONSTRAINT agent_credentials_scopes_check CHECK (
  array_length(scopes, 1) BETWEEN 1 AND 10
  AND scopes <@ ARRAY['operator:read', 'work:read', 'qualification:submit',
    'assignments:read', 'assignments:claim', 'runs:execute',
    'decisions:read', 'appeals:submit', 'payouts:read', 'resources:purchase']
);
