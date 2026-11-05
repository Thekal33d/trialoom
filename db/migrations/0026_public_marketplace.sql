-- Public entry is opt-in; old free entitlements and private campaigns survive.
CREATE TABLE marketplace_workspaces (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  enabled_by text NOT NULL REFERENCES auth_user(id),
  enabled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_marketplace_workspaces BEFORE UPDATE OR DELETE ON marketplace_workspaces
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();

ALTER TABLE campaigns ADD COLUMN visibility text NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private', 'public'));
CREATE INDEX campaigns_public_open ON campaigns(published_at) WHERE visibility='public' AND status='open';
