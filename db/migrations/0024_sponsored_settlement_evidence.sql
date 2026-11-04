-- No real purchases existed at this upgrade checkpoint. Refuse an automatic
-- upgrade of legacy purchases: the old signer could extend the saved expiry
-- and reconciliation trusted HTTP success. Those require a chain audit with
-- the old workers stopped, not an automatic reinterpretation of money state.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM sponsored_purchases) THEN
    RAISE EXCEPTION 'Legacy sponsored purchases require an independent chain audit';
  END IF;
END $$;

-- Gateway claims and chain-verified settlement are distinct facts.
ALTER TABLE sponsored_purchases
  ADD COLUMN payer_address text NOT NULL CHECK (payer_address ~ '^0x[0-9a-fA-F]{40}$'),
  ADD COLUMN reported_cost_units numeric(78, 0) CHECK (reported_cost_units >= 0),
  ADD COLUMN reported_transaction_hash text
    CHECK (reported_transaction_hash ~ '^0x[0-9a-fA-F]{64}$');

DROP TRIGGER immutable_sponsored_identity ON sponsored_purchases;

-- Preserve delivery even if a response is usable but its payment is uncertain
-- or never settles. Discover the old unnamed check rather than its ordinal.
DO $$ DECLARE constraint_name text; BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
      WHERE conrelid='sponsored_purchases'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%delivery%'
        AND pg_get_constraintdef(oid) LIKE '%state%'
  LOOP
    EXECUTE format('ALTER TABLE sponsored_purchases DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
ALTER TABLE sponsored_purchases ADD CONSTRAINT sponsored_usable_response
  CHECK (delivery <> 'usable' OR (submitted_at IS NOT NULL AND usable_at IS NOT NULL));

CREATE OR REPLACE FUNCTION prevent_sponsored_identity_change()
RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR NEW.payer_address <> OLD.payer_address
    OR NEW.spend_day <> OLD.spend_day
    OR NEW.quoted_at <> OLD.quoted_at
    OR NEW.quote_expires_at <> OLD.quote_expires_at
    OR (OLD.cost_units IS NOT NULL AND NEW.cost_units IS DISTINCT FROM OLD.cost_units)
    OR (OLD.transaction_hash IS NOT NULL
      AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash)
    OR (OLD.reported_cost_units IS NOT NULL
      AND NEW.reported_cost_units IS DISTINCT FROM OLD.reported_cost_units)
    OR (OLD.reported_transaction_hash IS NOT NULL
      AND NEW.reported_transaction_hash IS DISTINCT FROM OLD.reported_transaction_hash)
  THEN
    RAISE EXCEPTION 'Sponsored purchase identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_sponsored_identity BEFORE UPDATE ON sponsored_purchases
  FOR EACH ROW EXECUTE FUNCTION prevent_sponsored_identity_change();
