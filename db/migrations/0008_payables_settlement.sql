-- Payout topics join the outbox. A payout job's dedupe key is the payable's
-- operation key, so the queue and the payment share one identity.
ALTER TABLE outbox_jobs DROP CONSTRAINT outbox_jobs_topic_check;
ALTER TABLE outbox_jobs ADD CONSTRAINT outbox_jobs_topic_check
  CHECK (topic IN ('system.ping', 'payout.dispatch'));

-- An accepted payable fixes its recipient, token, exact amount, the decision
-- that accepted it, and its assignment. A payout identity is written once and
-- never rewritten: a retry reconciles this key rather than inventing another.
CREATE TABLE payables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  assignment_id uuid NOT NULL,
  decision_id uuid NOT NULL REFERENCES decisions(id),
  operator_id uuid NOT NULL REFERENCES operators(id),
  -- Operator payouts and platform fees are separate, traceable transfers.
  kind text NOT NULL CHECK (kind IN ('operator', 'platform_fee')),
  category text NOT NULL CHECK (category IN ('execution', 'discovery', 'resource', 'fee')),
  -- A fee is collectible only once the operator work it rests on has settled.
  depends_on uuid REFERENCES payables(id),
  amount_units numeric(78, 0) NOT NULL CHECK (amount_units > 0),
  currency_chain_id integer NOT NULL CHECK (currency_chain_id = 42220),
  currency_address text NOT NULL,
  currency_decimals integer NOT NULL CHECK (currency_decimals = 6),
  -- Empty until a recipient exists to fix; fixed exactly once after that.
  recipient_address text CHECK (recipient_address ~ '^0x[0-9a-fA-F]{40}$'),
  recipient_wallet_id uuid REFERENCES operator_wallets(id),
  -- The immutable identity a retry reconciles. One payment, one key, forever.
  operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^trp_[a-f0-9]{48}$'),
  state text NOT NULL CHECK (state IN (
    'queued', 'blocked', 'submitted', 'included', 'finalized', 'needs_reconciliation', 'cancelled'
  )),
  blocked_reason text CHECK (blocked_reason IN (
    'no_payout_wallet', 'fee_recipient_unconfigured', 'payment_authority_unavailable',
    'authority_revoked', 'insufficient_balance', 'policy_expired', 'awaiting_operator_settlement'
  )),
  transaction_hash text CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  submitted_at timestamptz,
  included_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (campaign_id, assignment_id) REFERENCES assignments (campaign_id, id),
  -- One payable per decision and kind: an acceptance cannot be paid twice.
  UNIQUE (decision_id, kind),
  CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL)),
  -- Inclusion and finality are separate facts, and neither exists without a hash.
  CHECK ((transaction_hash IS NULL) = (submitted_at IS NULL)),
  CHECK ((included_at IS NULL) OR (transaction_hash IS NOT NULL)),
  CHECK ((state = 'finalized') = (finalized_at IS NOT NULL)),
  CHECK ((finalized_at IS NULL) OR (included_at IS NOT NULL)),
  -- Nothing leaves the queue toward a transfer without a recipient to pay.
  CHECK (recipient_address IS NOT NULL OR state IN ('queued', 'blocked', 'cancelled')),
  CHECK ((kind = 'platform_fee') = (category = 'fee'))
);
CREATE INDEX payables_campaign ON payables (campaign_id, created_at DESC);
CREATE INDEX payables_operator ON payables (operator_id, created_at DESC);
CREATE INDEX payables_open ON payables (state) WHERE state <> 'finalized';

-- A payout identity is fixed once. The state, hash and timestamps move forward;
-- the recipient, token, amount and key never change after they are written.
CREATE FUNCTION prevent_payout_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_key <> OLD.operation_key
    OR NEW.amount_units <> OLD.amount_units
    OR NEW.currency_chain_id <> OLD.currency_chain_id
    OR NEW.currency_address <> OLD.currency_address
    OR NEW.decision_id <> OLD.decision_id
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
CREATE TRIGGER immutable_payout_identity BEFORE UPDATE ON payables
  FOR EACH ROW EXECUTE FUNCTION prevent_payout_identity_change();
CREATE TRIGGER no_payable_delete BEFORE DELETE ON payables
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- Every settlement attempt and observation, append-only, for reconciliation.
CREATE TABLE payout_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payable_id uuid NOT NULL REFERENCES payables(id),
  adapter text NOT NULL CHECK (length(adapter) BETWEEN 1 AND 60),
  action text NOT NULL CHECK (action IN ('send', 'confirm')),
  result text NOT NULL CHECK (result IN (
    'submitted', 'included', 'finalized', 'uncertain', 'failed', 'blocked'
  )),
  transaction_hash text CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  detail text NOT NULL CHECK (length(detail) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payout_attempts_payable ON payout_attempts (payable_id, created_at);
CREATE TRIGGER immutable_payout_attempt BEFORE UPDATE OR DELETE ON payout_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- Operators read their payouts. The scope cannot start or redirect one.
ALTER TABLE agent_credentials DROP CONSTRAINT agent_credentials_scopes_check;
ALTER TABLE agent_credentials ADD CONSTRAINT agent_credentials_scopes_check CHECK (
  array_length(scopes, 1) BETWEEN 1 AND 9
  AND scopes <@ ARRAY['operator:read', 'work:read', 'qualification:submit',
    'assignments:read', 'assignments:claim', 'runs:execute',
    'decisions:read', 'appeals:submit', 'payouts:read']
);
