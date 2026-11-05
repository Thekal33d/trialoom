-- A workspace can register its own host, but cannot confer platform trust.
ALTER TABLE runner_hosts ADD COLUMN workspace_id uuid REFERENCES workspaces(id);
ALTER TABLE runner_hosts ADD COLUMN platform_managed boolean NOT NULL DEFAULT false;
-- Only unambiguous legacy ownership is retained. Ambiguous hosts require explicit re-enrollment.
UPDATE runner_hosts h SET workspace_id=m.workspace_id FROM (
  SELECT user_id,(array_agg(workspace_id))[1] AS workspace_id FROM memberships
  WHERE role='owner' GROUP BY user_id HAVING count(*)=1
) m WHERE m.user_id=h.registered_by;
CREATE INDEX runner_hosts_workspace ON runner_hosts(workspace_id);
