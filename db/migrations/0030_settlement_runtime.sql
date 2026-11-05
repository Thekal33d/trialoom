CREATE TABLE settlement_runtime (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  agent_address text CHECK (agent_address ~ '^0x[0-9a-fA-F]{40}$'),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE payment_approval_observations
  ADD COLUMN per_payment_units numeric(78,0) CHECK (per_payment_units >= 0),
  ADD COLUMN remaining_today_units numeric(78,0) CHECK (remaining_today_units >= 0),
  ADD COLUMN open_recipients boolean;
