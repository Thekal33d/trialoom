CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  target_url text NOT NULL,
  authorized_origin text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('preview','staging')),
  repository_url text,
  authorized_by text NOT NULL REFERENCES auth_user(id),
  authorization_version text NOT NULL DEFAULT 'testing-permission-v1',
  authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  admission_addresses jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id,id)
);
CREATE TABLE builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  revision text NOT NULL CHECK (length(revision) BETWEEN 1 AND 200),
  fixture_version text NOT NULL CHECK (length(fixture_version) BETWEEN 1 AND 200),
  target_url text NOT NULL,
  admission_addresses jsonb NOT NULL,
  created_by text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id,id), UNIQUE (project_id,revision,fixture_version,target_url)
);
CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'draft' CHECK (status='draft'),
  latest_version integer NOT NULL DEFAULT 0 CHECK (latest_version>=0),
  created_by text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id,id)
);
CREATE TABLE terms_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  build_id uuid NOT NULL,
  version integer NOT NULL CHECK (version>0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document)='object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  approved_by text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id,campaign_id) REFERENCES campaigns(project_id,id),
  FOREIGN KEY (project_id,build_id) REFERENCES builds(project_id,id),
  UNIQUE (campaign_id,version), UNIQUE(campaign_id,id)
);
CREATE INDEX projects_workspace ON projects(workspace_id,created_at);
CREATE INDEX builds_project ON builds(project_id,created_at);
CREATE INDEX campaigns_project ON campaigns(project_id,created_at);
CREATE TRIGGER immutable_project BEFORE UPDATE OR DELETE ON projects FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_build BEFORE UPDATE OR DELETE ON builds FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
CREATE TRIGGER immutable_terms BEFORE UPDATE OR DELETE ON terms_versions FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
