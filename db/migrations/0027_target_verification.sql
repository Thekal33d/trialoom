CREATE TABLE target_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  requested_by text NOT NULL REFERENCES auth_user(id),
  origin text NOT NULL,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
  consumed_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX target_challenge_active ON target_challenges(project_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE TABLE target_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  challenge_id uuid NOT NULL UNIQUE REFERENCES target_challenges(id),
  origin text NOT NULL,
  addresses jsonb NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '7 days',
  revoked_at timestamptz
);
CREATE INDEX target_verification_current ON target_verifications(project_id,expires_at);
ALTER TABLE free_test_runtime ADD COLUMN accepts_verified_targets boolean NOT NULL DEFAULT false;
