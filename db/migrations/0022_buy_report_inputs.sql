-- Immutable prepared requests only. No signer, spending authority or customer payable.
CREATE TABLE buy_report_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  free_test_id uuid NOT NULL REFERENCES free_tests(id),
  user_id text NOT NULL REFERENCES free_beta_accounts(user_id),
  workspace_id uuid NOT NULL REFERENCES free_beta_accounts(workspace_id),
  result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  service text NOT NULL CHECK (service='cencori.v1.chat.completions'),
  template_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('prepared','skipped')),
  skip_reason text CHECK (skip_reason='all_checks_passed'),
  observations jsonb NOT NULL CHECK (jsonb_typeof(observations)='object' AND octet_length(observations::text)<=4096),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  request_body text CHECK (octet_length(request_body)<=16384),
  request_hash text CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(free_test_id,service,template_version),
  CHECK (
    (status='prepared' AND skip_reason IS NULL AND request_body IS NOT NULL AND request_hash IS NOT NULL)
    OR (status='skipped' AND skip_reason IS NOT NULL AND request_body IS NULL AND request_hash IS NULL)
  )
);

CREATE FUNCTION guard_buy_report_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Buy report inputs are immutable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM free_tests WHERE id=NEW.free_test_id
      AND user_id=NEW.user_id AND workspace_id=NEW.workspace_id
      AND result_hash=NEW.result_hash AND result IS NOT NULL
      AND phase IN ('completed','blocked') AND cleanup_at IS NOT NULL AND NOT cancel_requested
  ) THEN RAISE EXCEPTION 'Buy report requires matching completed test evidence'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER buy_report_input_guard BEFORE INSERT OR UPDATE OR DELETE ON buy_report_inputs
  FOR EACH ROW EXECUTE FUNCTION guard_buy_report_input();
