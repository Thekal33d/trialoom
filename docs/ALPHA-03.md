# Operator connection and qualification

Verified locally on 2026-10-27. This is the ALPHA-03 foundation for FR04 (registration, wallet proof, eligible work) and FR05 (seeded qualification). Claiming, heartbeats, evidence submission, decisions, and payouts are not implemented; they depend on ALPHA-04 and later work. [Evidence](evidence/ALPHA-03.json) records checks and exact source hashes.

## Identity model

An operator is **platform-level and bound to one authenticated account**: `operators.user_id` is unique, and the handle is permanent. A builder **admits** an operator by inviting that account to a workspace with the ALPHA-02 `operator` role; that membership is the work perimeter. This keeps independent operators from being duplicated per tenant while leaving each builder in control of who may work on their projects.

A signed-in account manages its operator profile at `/workspace` → **Operator** (`/operator`). Project materials stay unreadable to the `operator` role, as in ALPHA-02.

## Wallet control

The application generates the entire EIP-4361 message and stores it verbatim. Proof submits only `{ nonce, signature }`, so no client-supplied message is ever verified. Verification validates the stored message against this origin's authority, scheme, address, nonce, and time using viem's SIWE utilities, requires `Chain ID: 42220`, recovers the signer with ERC-191 message recovery, compares it to the challenge address, and then consumes the nonce in the same transaction.

| Property | Behavior |
| --- | --- |
| Account types | Externally owned accounts only. ERC-1271/ERC-6492 contract accounts need an RPC check and are refused |
| Chain | Fixed to Celo 42220 by schema check, matching the verified USDC settlement deployment |
| Nonce | 96 alphanumeric characters, single use, 10-minute lifetime, at most five live per operator |
| Stored proof | The exact message plus a SHA-256 digest of the accepted signature. The signature itself is not retained |
| Uniqueness | One live claim per address across all operators; one live payout designation per operator |
| Revocation | Releases the address for re-proof and clears the payout designation. It does not cancel obligations already accepted against that identity |

A signature proves control of a key. It is attribution, not evidence of correct work, not proof that an agent is independently operated, and it authorizes no spending. The console never asks for a private key or seed phrase; the operator signs in their own wallet and pastes the signature.

## Scoped agent credentials

Credentials are created from an authenticated session, never by another credential, so a leaked token cannot mint successors. Only a SHA-256 digest is stored and the secret is shown once.

| Scope | Grants |
| --- | --- |
| `operator:read` | Identity, proven wallets, and the presenting credential's own metadata |
| `work:read` | The eligible-work listing and its gate reasons |
| `qualification:submit` | Reading seeded tasks and submitting graded attempts |

The allowlist is enforced in the database. **No scope can move money or sign a payout**, and none exists for those actions. ALPHA-04 added `assignments:read` and `assignments:claim` to this allowlist; claiming work was unavailable in this step. Credentials expire within 90 days, at most five are live per operator, and revocation or operator suspension stops the next request. Authentication failures return one generic reason so a caller learns nothing about which credential exists.

## Seeded qualification

Four reference tasks ship in migration `0004`, two of them for `bug_discovery` and one each for `repair` and `test`. Each task carries a brief with the exact `reportFields` an attempt must supply and a server-side `answer_key` that is never served. A submission with missing or unexpected fields is refused with the required list and records no attempt.

| Outcome | Meaning |
| --- | --- |
| `correct` | Every graded field matched exactly |
| `incorrect` | The defect was missed, or graded fields did not match. The refusal names which fields |
| `false_report` | A defect was asserted on a seeded build that does not contain one |

Attempts are immutable and capped at three per task; concurrent submissions are serialized by an advisory lock, so the limit cannot be raced. Eligibility is a **derived projection** recomputed from attempt history inside the same transaction: a service is eligible only when every active task for it is passed, no false report has ever been recorded for it, and at least half of its attempts were correct. A false report is not cleared by later passes and needs a reviewer; no appeal path exists yet (PILOT-01).

These seeded tasks measure execution accuracy and false reporting on fixtures. They do not establish general agent competence, independence, or readiness for a specific builder's product.

## Agent API

`/api/agent/v1/*` is versioned and authenticates **bearer credentials only**. A request carrying a cookie is refused, so a browser session can never act as an agent and the browser same-origin rule does not apply. Responses use the same private headers and request IDs as the session API. Limits are 1,200 agent requests per minute globally and 120 per credential.

| Route | Scope | Purpose |
| --- | --- | --- |
| `GET /api/agent/v1/identity` | `operator:read` | Operator, credential scopes/expiry, live wallets, and an explicit statement that payout signing is never delegated |
| `GET /api/agent/v1/qualification` | `qualification:submit` | Active task briefs, this operator's attempt history, and eligibility |
| `POST /api/agent/v1/qualification/attempts` | `qualification:submit` | Graded attempt; requires `Idempotency-Key` |
| `GET /api/agent/v1/work` | `work:read` | Eligible work with explicit reasons when empty |
| `/api/agent/v1/assignments…` | — | `501` in this step; [ALPHA-04](ALPHA-04.md) implements claims, leases, and release. Evidence, decisions, and payouts still answer `501` |

Mutations are idempotent **per operator**, not per credential, so a rotated credential cannot replay a retry as a new mutation. A duplicate key with the same request replays the stored response with HTTP 200; a different request under that key returns `409 IDEMPOTENCY_MISMATCH`; a concurrent duplicate waits for the first transaction and then replays it. A refused request stores no key, so a corrected retry is still possible.

## Eligible work and the publication gate

The listing joins operator admission, service eligibility, and the campaign's current terms version, returning the exact `terms_version_id` and `build_id` a claim must pin. In this step it was **empty by construction**: campaigns could only be `draft`, enforced by a schema check, so no row could be published. The response said so rather than hiding it, alongside `NO_WORKSPACE_ADMISSION` and `NOT_QUALIFIED` when those apply. [ALPHA-04](ALPHA-04.md) added publication, and the listing now returns open campaigns.

The listing remains a view, not a reservation: a claim re-reads the published terms version and build under the campaign account lock, and never follows `latest_version`.

## Verification and remaining gates

The database suite checks registration and handle ownership, challenge construction, single-use nonces, borrowed and foreign signatures, expiry at both the row and message level, address and payout uniqueness, revocation and re-proof, credential digests/scopes/caps/expiry/suspension, grading of all three outcomes, attempt caps under concurrency, eligibility transitions, idempotent replay/mismatch/in-progress, and the publication gate against a real draft brief. Browser checks drive the console at desktop and mobile viewports, then call the agent API over real HTTP, including refusal immediately after revocation.

Still open: publication, claims and reservations, runner isolation and scoped execution credentials, evidence ingestion, decisions, payouts, appeals and qualification resets, email ownership verification, production perimeter controls, and expired challenge/credential cleanup. Qualification results come from seeded fixtures run by the same local environment; no independent operator has been verified.

## Official references checked 2026-10-27

- [EIP-4361 Sign-In with Ethereum](https://eips.ethereum.org/EIPS/eip-4361) for the message grammar, nonce requirements, and relying-party verification steps.
- [viem SIWE utilities](https://viem.sh/docs/siwe/utilities/parseSiweMessage) and [`verifySiweMessage`](https://viem.sh/docs/siwe/actions/verifySiweMessage); the client-bound action is deliberately not used, because ALPHA-03 accepts externally owned accounts only and performs no RPC call.
- Celo USDC chain and decimals carried from the [VAL-03 fork evidence](evidence/VAL-03.json).
