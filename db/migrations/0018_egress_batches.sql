-- The batch receipt commits with its observations. An identical retry is safe;
-- a changed payload may never reuse its number, even after evidence closes.
CREATE TABLE egress_batches (
  run_id uuid NOT NULL REFERENCES runs(id),
  batch integer NOT NULL CHECK (batch BETWEEN 1 AND 10000),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL,
  PRIMARY KEY (run_id, batch)
);
CREATE TRIGGER immutable_egress_batch BEFORE UPDATE OR DELETE ON egress_batches
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
-- Unknown destinations remain anonymous: never persist attacker-supplied URLs.
ALTER TABLE egress_observations ALTER COLUMN origin DROP NOT NULL;
ALTER TABLE egress_observations ADD CONSTRAINT allowed_egress_needs_origin
  CHECK (decision <> 'allowed' OR origin IS NOT NULL);
ALTER TABLE egress_observations ADD COLUMN reason text;
