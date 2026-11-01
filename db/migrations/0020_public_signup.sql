-- Email possession precedes account creation; no credentials are preclaimed.
CREATE TABLE public_signup_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(email)),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX public_signup_email ON public_signup_tokens(email, created_at);

-- Separate entitlement: existing invited workspaces retain their original mode.
CREATE TABLE free_beta_accounts (
  user_id text PRIMARY KEY REFERENCES auth_user(id),
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_free_beta_accounts BEFORE UPDATE OR DELETE ON free_beta_accounts
  FOR EACH ROW EXECUTE FUNCTION prevent_record_mutation();
