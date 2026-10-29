-- The instrumented event stream. Every row shares the campaign and assignment
-- identifiers the PRD asks for, so one timeline joins work, decisions and
-- money; and every row is append-only, because a metric computed from a record
-- somebody could edit afterwards is not a measurement.
--
-- The topic list is closed. A metric may only rest on an event this table
-- admits, so a new measurement requires a migration rather than a string.
CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL CHECK (topic IN (
    'campaign.published',
    'campaign.funding_failed',
    'assignment.claimed',
    'run.started',
    'evidence.submitted',
    'reproduction.outcome',
    'duplicate.decided',
    'decision.accepted',
    'appeal.opened',
    'resource.settled',
    'payout.included',
    'payout.finalized',
    'purchase.repeated',
    'review.opened'
  )),
  workspace_id uuid REFERENCES workspaces(id),
  project_id uuid,
  campaign_id uuid REFERENCES campaigns(id),
  assignment_id uuid,
  operator_id uuid REFERENCES operators(id),
  -- The person an event is attributable to, where there is one. A run or a
  -- payout has none: nobody pressed a button.
  actor_id text REFERENCES auth_user(id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- No credentials and no raw private artifacts. The application redacts the
  -- values; this refuses the keys outright, so a careless caller cannot put a
  -- secret in the analytics stream by naming it plainly.
  CHECK (NOT (payload ?| ARRAY[
    'secret', 'token', 'credential', 'password', 'signature', 'privateKey',
    'grant', 'runToken', 'attemptToken', 'authorization', 'cookie', 'bytes', 'document'
  ]))
);
CREATE INDEX events_topic ON events (topic, occurred_at DESC);
CREATE INDEX events_campaign ON events (campaign_id, occurred_at);
CREATE INDEX events_workspace ON events (workspace_id, occurred_at DESC);
CREATE INDEX events_assignment ON events (assignment_id, occurred_at)
  WHERE assignment_id IS NOT NULL;
CREATE TRIGGER immutable_event BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
