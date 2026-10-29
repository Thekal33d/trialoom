-- What a payout actually cost Trialoom to send. Remesso's own fees guide is
-- explicit that the agent's key pays for each agent payment and that the
-- executor does not cover it, so this is a platform cost: it never touches the
-- campaign ledger, the builder's liability, or the token approval, which funds
-- the transfer rather than its gas.
--
-- A reading from a receipt is evidence, so the row is immutable and keyed by
-- the transaction it describes. The unique hash is what stops a retry that
-- reads the same receipt again from counting the same gas twice.
CREATE TABLE payout_gas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payable_id uuid NOT NULL REFERENCES payables(id),
  transaction_hash text NOT NULL UNIQUE CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  gas_used numeric(78, 0) NOT NULL CHECK (gas_used > 0),
  effective_price numeric(78, 0) NOT NULL CHECK (effective_price >= 0),
  cost_units numeric(78, 0) NOT NULL CHECK (cost_units >= 0),
  -- NULL is the chain's own currency. A Celo transaction may instead name a
  -- fee currency (CIP-64), in which case the price and the cost are
  -- denominated in that token rather than in CELO.
  fee_currency_address text CHECK (fee_currency_address ~ '^0x[0-9a-fA-F]{40}$'),
  currency_symbol text NOT NULL CHECK (length(currency_symbol) BETWEEN 1 AND 42),
  -- NULL means the fee currency is not one this build knows, so its cost
  -- cannot be converted or compared with anything. It is still recorded.
  currency_decimals integer CHECK (currency_decimals BETWEEN 0 AND 36),
  reader text NOT NULL CHECK (length(reader) BETWEEN 1 AND 60),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The cost is the product, not a third number somebody can disagree with.
  CONSTRAINT payout_gas_cost CHECK (cost_units = gas_used * effective_price)
);
CREATE INDEX payout_gas_payable ON payout_gas (payable_id);
CREATE TRIGGER immutable_payout_gas BEFORE UPDATE OR DELETE ON payout_gas
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
