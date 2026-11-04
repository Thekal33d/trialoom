-- Login proofs are separate from operator payout-wallet proofs.
CREATE TABLE auth_wallet_challenges (
  id uuid PRIMARY KEY,
  address text NOT NULL CHECK (address ~ '^0x[a-f0-9]{40}$'),
  intent text NOT NULL CHECK (intent IN ('sign-in', 'sign-up', 'link')),
  message text NOT NULL,
  browser_hash text NOT NULL CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  user_id text REFERENCES auth_user(id) ON DELETE CASCADE,
  session_id text REFERENCES auth_session(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((intent = 'link') = (user_id IS NOT NULL AND session_id IS NOT NULL))
);
CREATE INDEX auth_wallet_challenges_expiry ON auth_wallet_challenges(expires_at);
-- Wallet identities use auth_account's existing UNIQUE(providerId, accountId).
-- New wallet accounts receive the same free_beta_accounts entitlement as email signup.
