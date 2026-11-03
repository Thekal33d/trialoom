-- Trialoom buys a free test's explanation out of its own pocket. The free beta
-- promises the builder is never charged for it, so this ledger has no route to
-- a payable at all: no nullable column, no disabled branch, nothing an
-- accident could fill in later. The guarantee is the absence.
ALTER TABLE outbox_jobs DROP CONSTRAINT outbox_jobs_topic_check;
ALTER TABLE outbox_jobs ADD CONSTRAINT outbox_jobs_topic_check
  CHECK (topic IN (
    'system.ping', 'payout.dispatch', 'resource.reconcile', 'authority.verify',
    'notice.deliver', 'sponsored.reconcile'
  ));

-- Separate from resource_accounts on purpose. That ceiling bounds what builders
-- will reimburse; this one bounds what nobody will, and conflating them would
-- let a builder's authorization fund a free test's explanation.
CREATE TABLE sponsored_budgets (
  id text PRIMARY KEY CHECK (id = 'platform'),
  ceiling_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (ceiling_units >= 0),
  reserved_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  settled_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (settled_units >= 0),
  -- What one free account may cost the platform in a UTC day. A single
  -- enthusiastic account cannot drain the whole ceiling on its own.
  daily_user_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (daily_user_units >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (reserved_units + settled_units <= ceiling_units)
);
-- Seeded at nothing, like the resource account: no sponsor wallet is funded in
-- this build, so every purchase is refused with a reason until an operator
-- raises this deliberately.
INSERT INTO sponsored_budgets (id) VALUES ('platform');

CREATE TABLE sponsored_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_units numeric(78, 0) NOT NULL CHECK (amount_units > 0),
  daily_user_units numeric(78, 0) NOT NULL CHECK (daily_user_units > 0),
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_sponsored_authorization
  BEFORE UPDATE OR DELETE ON sponsored_authorizations
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- One prepared report, one purchase, ever. UNIQUE is what makes that true; a
-- worker that forgets to look first still cannot authorize a second call.
CREATE TABLE sponsored_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_input_id uuid NOT NULL UNIQUE REFERENCES buy_report_inputs(id),
  user_id text NOT NULL REFERENCES free_beta_accounts(user_id),
  workspace_id uuid NOT NULL REFERENCES free_beta_accounts(workspace_id),
  service text NOT NULL CHECK (service = 'cencori.v1.chat.completions'),
  -- The exact request the input fixed. Dispatch re-reads the body from that
  -- row and refuses if this no longer matches what it is about to send.
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  quoted_units numeric(78, 0) NOT NULL CHECK (quoted_units > 0),
  ceiling_units numeric(78, 0) NOT NULL CHECK (ceiling_units > 0),
  cost_units numeric(78, 0) CHECK (cost_units >= 0),
  currency_chain_id integer NOT NULL CHECK (currency_chain_id = 42220),
  currency_address text NOT NULL CHECK (currency_address ~ '^0x[0-9a-fA-F]{40}$'),
  currency_decimals integer NOT NULL CHECK (currency_decimals = 6),
  payee_address text NOT NULL CHECK (payee_address ~ '^0x[0-9a-fA-F]{40}$'),
  quoted_at timestamptz NOT NULL,
  quote_expires_at timestamptz NOT NULL,
  intent_key text NOT NULL UNIQUE CHECK (intent_key ~ '^tsb_[a-f0-9]{48}$'),
  state text NOT NULL CHECK (state IN (
    'quoted', 'reserved', 'submitted', 'usable', 'reconciled', 'refused', 'failed', 'uncertain'
  )),
  reason text CHECK (reason IN (
    'sponsor_wallet_unavailable', 'budget_exceeded', 'daily_user_limit', 'quote_above_limit',
    'quote_expired', 'quote_token_unexpected', 'provider_refused', 'request_changed',
    'output_unusable', 'settlement_uncertain', 'response_lost'
  )),
  transaction_hash text CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  receipt jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Whether the thing that was paid for arrived, kept apart from whether the
  -- payment settled. Reconciliation rewrites the state and clears the reason,
  -- so without this the fact that money bought nothing usable would be lost at
  -- exactly the moment the money is recorded as spent.
  delivery text NOT NULL DEFAULT 'pending'
    CHECK (delivery IN ('pending', 'usable', 'unusable', 'none')),
  -- The UTC day this purchase counts against, fixed when it is created so a
  -- long-running reconciliation never migrates into tomorrow's allowance.
  spend_day date NOT NULL DEFAULT ((clock_timestamp() AT TIME ZONE 'UTC')::date),
  submitted_at timestamptz,
  usable_at timestamptz,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- An explicit limit that could be exceeded is not a limit.
  CHECK (quoted_units <= ceiling_units),
  CHECK (cost_units IS NULL OR cost_units <= ceiling_units),
  CHECK ((state IN ('refused', 'failed', 'uncertain')) = (reason IS NOT NULL)),
  CHECK ((state = 'reconciled') = (reconciled_at IS NOT NULL)),
  CHECK ((usable_at IS NULL) OR (submitted_at IS NOT NULL)),
  -- Nothing can have been delivered by a call that was never answered.
  CHECK (delivery <> 'usable' OR state IN ('usable', 'reconciled')),
  -- And 'none' is only honest when nothing was paid for it.
  CHECK (delivery <> 'none' OR COALESCE(cost_units, 0) = 0)
);
-- Everything still holding part of the ceiling, which is what the release path
-- and the remaining-budget read both ask for.
CREATE INDEX sponsored_purchases_open ON sponsored_purchases (id) WHERE reconciled_at IS NULL;
CREATE INDEX sponsored_purchases_account ON sponsored_purchases (user_id, spend_day);

-- A purchase may only ever answer to a report that was actually prepared, for
-- the same account, carrying the same request. An all-passing test is recorded
-- as skipped with no request body, and this is what stops one being bought.
CREATE FUNCTION guard_sponsored_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM buy_report_inputs r
      WHERE r.id = NEW.report_input_id AND r.status = 'prepared'
        AND r.request_hash = NEW.request_hash AND r.service = NEW.service
        AND r.user_id = NEW.user_id AND r.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'A sponsored purchase must match a prepared report input'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sponsored_purchase_source BEFORE INSERT ON sponsored_purchases
  FOR EACH ROW EXECUTE FUNCTION guard_sponsored_purchase();

-- The state, cost, receipt and timestamps move forward. The identity, the
-- authorized ceiling, the token, the payee and the request never move, and a
-- recorded cost or transaction is never rewritten.
CREATE FUNCTION prevent_sponsored_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent_key <> OLD.intent_key
    OR NEW.report_input_id <> OLD.report_input_id
    OR NEW.user_id <> OLD.user_id
    OR NEW.workspace_id <> OLD.workspace_id
    OR NEW.service <> OLD.service
    OR NEW.request_hash <> OLD.request_hash
    OR NEW.ceiling_units <> OLD.ceiling_units
    OR NEW.quoted_units <> OLD.quoted_units
    OR NEW.currency_chain_id <> OLD.currency_chain_id
    OR NEW.currency_address <> OLD.currency_address
    OR NEW.currency_decimals <> OLD.currency_decimals
    OR NEW.payee_address <> OLD.payee_address
    OR NEW.spend_day <> OLD.spend_day
    OR (OLD.cost_units IS NOT NULL AND NEW.cost_units IS DISTINCT FROM OLD.cost_units)
    OR (OLD.transaction_hash IS NOT NULL
      AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash)
  THEN
    RAISE EXCEPTION 'Sponsored purchase identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_sponsored_identity BEFORE UPDATE ON sponsored_purchases
  FOR EACH ROW EXECUTE FUNCTION prevent_sponsored_identity_change();
CREATE TRIGGER no_sponsored_purchase_delete BEFORE DELETE ON sponsored_purchases
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- Every quote, dispatch and reconciliation observation, append-only.
CREATE TABLE sponsored_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES sponsored_purchases(id),
  adapter text NOT NULL CHECK (length(adapter) BETWEEN 1 AND 60),
  action text NOT NULL CHECK (action IN ('quote', 'purchase', 'resolve')),
  result text NOT NULL CHECK (result IN (
    'quoted', 'submitted', 'usable', 'settled', 'unsettled', 'uncertain', 'refused'
  )),
  transaction_hash text CHECK (transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  detail text NOT NULL CHECK (length(detail) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sponsored_attempts_purchase ON sponsored_attempts (purchase_id, created_at);
CREATE TRIGGER immutable_sponsored_attempt BEFORE UPDATE OR DELETE ON sponsored_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- What the purchase actually bought: advisory text bound to the exact request
-- that paid for it. `authoritative` is pinned false by a check rather than by
-- convention, because this is the record a reader is most tempted to trust.
CREATE TABLE sponsored_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL UNIQUE REFERENCES sponsored_purchases(id),
  report_input_id uuid NOT NULL UNIQUE REFERENCES buy_report_inputs(id),
  kind text NOT NULL DEFAULT 'generated_explanation' CHECK (kind = 'generated_explanation'),
  authoritative boolean NOT NULL DEFAULT false CHECK (NOT authoritative),
  body jsonb NOT NULL CHECK (
    jsonb_typeof(body) = 'object' AND octet_length(body::text) <= 8192
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_sponsored_output BEFORE UPDATE OR DELETE ON sponsored_outputs
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

-- An output belongs to the same prepared report its purchase does. Without
-- this the two foreign keys could point at different tests.
CREATE FUNCTION guard_sponsored_output() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sponsored_purchases p
      WHERE p.id = NEW.purchase_id AND p.report_input_id = NEW.report_input_id
        AND p.state IN ('usable', 'reconciled')
  ) THEN
    RAISE EXCEPTION 'A sponsored output requires its own delivered purchase'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sponsored_output_source BEFORE INSERT ON sponsored_outputs
  FOR EACH ROW EXECUTE FUNCTION guard_sponsored_output();
