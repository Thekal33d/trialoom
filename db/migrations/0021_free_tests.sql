-- Free testing has no campaign, assignment, payment authority or payable.
CREATE TABLE free_test_runtime (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  heartbeat_at timestamptz NOT NULL,
  allowed_origins jsonb NOT NULL CHECK (jsonb_typeof(allowed_origins)='array')
);
CREATE TABLE free_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES free_beta_accounts(user_id),
  workspace_id uuid NOT NULL REFERENCES free_beta_accounts(workspace_id),
  project_id uuid REFERENCES projects(id),
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sample','homepage')),
  target jsonb NOT NULL CHECK (jsonb_typeof(target)='object'),
  environment text NOT NULL CHECK (environment IN ('preview','staging')),
  phase text NOT NULL DEFAULT 'queued' CHECK (phase IN ('queued','running','captured','completed','blocked','interrupted','cancelled')),
  container_prefix text NOT NULL UNIQUE CHECK (container_prefix ~ '^trialoom-run-[a-f0-9]{24}$'),
  image text CHECK (image ~ '^sha256:[a-f0-9]{64}$'),
  deadline_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  cleanup_at timestamptz,
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=1048576)),
  result_hash text CHECK (result_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,request_id),
  CHECK ((kind='sample')=(project_id IS NULL)),
  CHECK ((result IS NULL)=(result_hash IS NULL)),
  CHECK (phase NOT IN ('captured','completed','blocked') OR result IS NOT NULL),
  CHECK (phase NOT IN ('running','captured') OR (image IS NOT NULL AND deadline_at IS NOT NULL)),
  CHECK (phase NOT IN ('completed','blocked','interrupted','cancelled') OR cleanup_at IS NOT NULL)
);
CREATE UNIQUE INDEX free_test_active_account ON free_tests(user_id) WHERE phase IN ('queued','running','captured');
CREATE INDEX free_test_queue ON free_tests(created_at) WHERE phase IN ('queued','running','captured');
CREATE INDEX free_test_daily ON free_tests(created_at,user_id);

CREATE FUNCTION guard_free_test() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Free test history cannot be deleted'; END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM free_beta_accounts WHERE user_id=NEW.user_id AND workspace_id=NEW.workspace_id)
      OR (NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id AND workspace_id=NEW.workspace_id))
    THEN RAISE EXCEPTION 'Free test ownership mismatch'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.user_id,NEW.workspace_id,NEW.project_id,NEW.request_id,NEW.kind,NEW.target,NEW.environment,NEW.container_prefix,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.workspace_id,OLD.project_id,OLD.request_id,OLD.kind,OLD.target,OLD.environment,OLD.container_prefix,OLD.created_at)
    OR (OLD.image IS NOT NULL AND NEW.image IS DISTINCT FROM OLD.image)
    OR (OLD.deadline_at IS NOT NULL AND NEW.deadline_at IS DISTINCT FROM OLD.deadline_at)
    OR (OLD.result IS NOT NULL AND (NEW.result,NEW.result_hash) IS DISTINCT FROM (OLD.result,OLD.result_hash))
    OR (OLD.cancel_requested AND NOT NEW.cancel_requested)
    OR (OLD.cleanup_at IS NOT NULL AND NEW.cleanup_at IS DISTINCT FROM OLD.cleanup_at)
    OR NOT (NEW.phase=OLD.phase
      OR (OLD.phase='queued' AND NEW.phase IN ('running','cancelled'))
      OR (OLD.phase='running' AND NEW.phase IN ('captured','interrupted','cancelled'))
      OR (OLD.phase='captured' AND NEW.phase IN ('completed','blocked','cancelled')))
  THEN RAISE EXCEPTION 'Free test identity and progress are immutable'; END IF;
  NEW.updated_at=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER free_test_guard BEFORE INSERT OR UPDATE OR DELETE ON free_tests
  FOR EACH ROW EXECUTE FUNCTION guard_free_test();
