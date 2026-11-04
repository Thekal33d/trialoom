# Wallet login and agent access

Updated: 2026-11-04. Decision: D060. Local implementation; not yet deployed to Railway.

## Wallet accounts

D062 supersedes the original optional-wallet presentation: Trialoom now leads with a unified **Connect wallet** flow at `/sign-in` for new and returning users. `/sign-up` redirects there. Email/password is retained at `/sign-in/email` for existing accounts, not as public onboarding. Existing email users should sign in with email, open **Account settings**, and choose **Link a wallet** to preserve their current account, workspace and roles. Linking requires a session created in the last 30 minutes and proof of the wallet; a wallet already owned by another account cannot be transferred or merged here.

Supported: injected browser wallets, including EIP-6963 discovery, using ordinary Ethereum account signatures on Celo (chain 42220). No transaction, gas payment, token approval or server-held wallet key is involved. WalletConnect QR flows, smart contract wallets/EIP-1271, wallet removal, lost-wallet recovery and account merging are not implemented. Users can link an additional wallet while they retain access. A wallet-only account does not acquire a verified email address; the internal `.invalid` placeholder is never displayed as a verified contact.

## Authentication boundary

- The server generates the exact EIP-4361 message with origin/domain, scheme, chain, address, nonce, purpose, request ID and five-minute expiry. The browser returns only the challenge ID and signature.
- A signed HttpOnly, SameSite Strict cookie binds the challenge to the initiating browser. The database stores its digest. Both the route wrapper and plugin enforce the exact configured Origin.
- An atomic update consumes the challenge before checking the signature; invalid attempts burn it too. Expired, replayed, client-authored or foreign-purpose proofs cannot authenticate.
- New identity, wallet mapping, workspace, owner membership and free entitlement commit together under a wallet-specific transaction lock. Existing wallet identities are never matched to an arbitrary supplied email or an operator payout proof.
- Linking binds the signed-in user and exact session, rechecks its liveness in the mutation, and leaves roles unchanged. Better Auth creates and revokes the ordinary web session. Wallet responses return no session token in JSON.
- Existing authentication rate limits also cover wallet routes: 200 total auth requests/minute and ten requests per wallet address or proof ID/minute. Trusted edge limits and production abuse response remain launch work; creating many wallet addresses does not establish many independent users.

## Configuration and deployment

Apply `0025_wallet_login.sql` before serving the new build. Existing account tables are unchanged; wallet identities use the existing unique `(providerId, accountId)` constraint, with provider `celo-wallet`. Wallet challenges are separate from operator payout challenges.

| Setting | Effect |
| --- | --- |
| `TRIALOOM_WALLET_LOGIN=true` | Enables wallet sign-in and explicit account linking |
| `TRIALOOM_PUBLIC_WALLET_SIGNUP=true` | Opens new free wallet accounts, only when wallet login is also enabled |
| `TRIALOOM_PUBLIC_SIGNUP=true` | Existing email signup switch; still requires mail delivery configuration |

All default off. Wallet signup can be enabled independently of email delivery. It does not enable `TRIALOOM_FREE_TESTS`, operator enrollment, sponsor purchases or paid assignments. The landing page and health endpoint reflect wallet signup as public signup when enabled. Keep `BETTER_AUTH_URL` exact: local loopback or the verified HTTPS origin. Hosted launch gates in [FREE-03](FREE-03.md) still apply.

## Can agents use Trialoom?

Yes, through the existing **operator API** at `/api/agent/v1`. An admitted operator uses the operator console to prove a payout wallet, create an expiring scoped credential and complete qualification. A qualified operator can discover eligible work, claim assignments, maintain leases, request runs and submit evidence using narrowly scoped run grants. Decisions and payout status are also readable with the relevant scopes. Paid resource purchases require their separate scope and existing application authorization; an API token is not payment authority.

Example read-only calls, with an already-issued credential supplied privately in the environment:

```sh
curl -H "Authorization: Bearer $TRIALOOM_AGENT_TOKEN" https://trialoom.xyz/api/agent/v1/identity
curl -H "Authorization: Bearer $TRIALOOM_AGENT_TOKEN" https://trialoom.xyz/api/agent/v1/work
```

Do not send browser cookies to these routes; they are explicitly rejected. Mutations such as claims require an `Idempotency-Key`. Run grants and agent credentials are distinct and cannot be substituted for each other. The current source of truth is `src/app/api/agent/v1/[...path]/route.ts`; early ALPHA-03 documents describe historical foundations that later steps implemented.

**Public free builder signup does not enroll an operator.** Wallet login does not change that. The [builder agent client](AGENT-01.md) now signs in with a wallet, creates authorized projects and requests/reads/cancels bounded free tests through the same workspace API as the browser. Hosted browser execution remains unavailable until the dedicated runner is connected. The existing controlled API was exercised again in the operator browser checks; this is not a claim of live external agent adoption or bounty eligibility.

## Verification and references

The database tests use real signatures from throwaway keys and actual Better Auth sessions. Browser checks simulate only the wallet transport; all authentication requests, SQL writes and session cookies use the application. No wallet extension, hardware wallet or mobile wallet app has been manually certified by these tests.

Checks and deployment state are recorded in [the evidence checkpoint](evidence/WALLET-01.json). Official references checked on 2026-11-04: [EIP-4361](https://eips.ethereum.org/EIPS/eip-4361), [Better Auth plugin endpoints and session APIs](https://better-auth.com/docs/concepts/plugins), [Celo network configuration](https://docs.celo.org/learn/network/overview). The installed Better Auth 1.7.14 SIWE plugin was also inspected; the small application plugin uses Better Auth's session/cookie APIs while retaining Trialoom's atomic workspace creation and explicit linking rules.
