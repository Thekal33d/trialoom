-- Trusted local-controller journal. No credentials or raw browser data belong here.
CREATE TABLE preview_executions (
  run_id uuid PRIMARY KEY REFERENCES runs(id),
  config_hash text NOT NULL CHECK (config_hash ~ '^[a-f0-9]{64}$'),
  container_prefix text NOT NULL UNIQUE CHECK (container_prefix ~ '^trialoom-run-[a-f0-9]{24}$'),
  phase text NOT NULL DEFAULT 'prepared' CHECK (phase IN ('prepared','dispatching','captured','delivered','interrupted')),
  bundle_sha256 text CHECK (bundle_sha256 ~ '^[a-f0-9]{64}$'),
  egress_delivered boolean NOT NULL DEFAULT false,
  uploaded_count integer NOT NULL DEFAULT 0 CHECK (uploaded_count BETWEEN 0 AND 12),
  receipt jsonb CHECK (receipt IS NULL OR jsonb_typeof(receipt) = 'object'),
  cleanup_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((phase IN ('captured','delivered')) = (bundle_sha256 IS NOT NULL)),
  CHECK (NOT egress_delivered OR phase IN ('captured','delivered')),
  CHECK (uploaded_count = 0 OR egress_delivered),
  CHECK ((phase = 'delivered') = (receipt IS NOT NULL))
);

CREATE FUNCTION guard_preview_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Execution journals cannot be deleted'; END IF;
  IF NEW.run_id <> OLD.run_id OR NEW.config_hash <> OLD.config_hash
    OR NEW.container_prefix <> OLD.container_prefix OR NEW.created_at <> OLD.created_at
    OR (OLD.bundle_sha256 IS NOT NULL AND NEW.bundle_sha256 IS DISTINCT FROM OLD.bundle_sha256)
    OR (OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt)
    OR (OLD.egress_delivered AND NOT NEW.egress_delivered)
    OR NEW.uploaded_count < OLD.uploaded_count
    OR (OLD.cleanup_at IS NOT NULL AND NEW.cleanup_at IS DISTINCT FROM OLD.cleanup_at)
    OR NOT (NEW.phase = OLD.phase
      OR (OLD.phase = 'prepared' AND NEW.phase = 'dispatching')
      OR (OLD.phase = 'dispatching' AND NEW.phase IN ('captured','interrupted'))
      OR (OLD.phase = 'captured' AND NEW.phase = 'delivered'))
  THEN RAISE EXCEPTION 'Execution identity and progress are immutable'; END IF;
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER preview_execution_guard BEFORE UPDATE OR DELETE ON preview_executions
  FOR EACH ROW EXECUTE FUNCTION guard_preview_execution();
