# Build log

Append entries after meaningful work. Keep current state in [STATUS.md](STATUS.md) and choices in [DECISIONS.md](DECISIONS.md).

Each entry records: date, task ID, work completed, validation and outcome, limitations, and commit subject or a previously created hash. Git history supplies the exact hash for the entry's own commit.

## 2026-10-26 — SETUP-01 — Repository and persistent memory

- Inspected an empty workspace; initialized local Git on `main` using the existing Git identity.
- Preserved the supplied PRD verbatim in `docs/PRD.md`; recorded its SHA-256 in core project memory.
- Added shared `AGENTS.md` instructions, a `CLAUDE.md` entry point, and `memory/` files for context, current status, decisions, and work history.
- Added a README and ignore rules for local credentials, generated output, and private execution artifacts.
- Validation: PRD byte comparison and hash passed; all local links in eight Markdown files resolve. Git's whitespace check initially flagged five intentional Markdown hard breaks in the source PRD; a file-specific attribute preserves that source formatting. No application tests apply because no application exists yet.
- Limitations: technical stack, implementation, integrations, remote repository, and hackathon enrollment remain pending.
- Commit subject: `docs: initialize Trialoom requirements and project memory`.
- Checkpoint: `22e6ce0`.

## 2026-10-26 — SETUP-02 — Delivery and hackathon tracking

- Read the complete PRD and checked the supplied arena plus its linked official event page. Added a dated source snapshot, proposed track, open attribution interpretation, and evidence checklist.
- Created a capability-first roadmap and backlog with task IDs, dependencies, acceptance conditions, and truthful implementation states.
- Mapped FR01–FR16 and all twelve release scenarios; created the validation/evidence register.
- Updated project memory, decision register, handoff, and README navigation.
- Validation passed: local links/anchors across 12 Markdown files, 25 unique task IDs, FR01–FR16 and R01–R12 coverage, verbatim PRD/hash, and Git diff checks. No application tests apply yet.
- Limitations: event setup, integrations, app code, funding, remote publication, and deployment remain undone. Track and technical stack are not confirmed choices.
- Next: VAL-01 runner/evidence experiment; VAL-03/VAL-04 provider validation; VAL-02 regression verification; VAL-05 stack decision.
- Commit subject: `docs: map delivery milestones and Celo hackathon readiness`.

## 2026-10-26 — VAL-01 — Browser reproduction and evidence export

- Added a deliberately defective loopback invitation fixture, clean-context Chromium journeys, structured expected/actual assertions, fixture/build IDs, and source fingerprints.
- Added text-only trace export that removes seeded credential/name canaries, updates changed resource hashes/references, rejects unsupported content, and verifies exported file hashes. Raw traces remain ignored.
- Pinned Node/Playwright/ZIP tooling and documented setup, replay, and boundaries. Preserved a sanitized manifest in `docs/evidence/VAL-01.json`.
- Validation: `npm test` passed 8 checks; `npm run spike:reproduce` passed both fresh replays, each observing normal invitation 201 and plus-address rejection 400. Playwright's trace inspector checks exported actions, requests, and attachments.
- Resolved environment restrictions by running the owned loopback server with the required permission. The first real trace export correctly refused an unsupported attachment; explicit fixture-JSON support was added and tested before successful export.
- Limitations: synthetic fixture, known-value redaction, browser-state isolation only; no production sandbox, independent operator, customer data, or payment proof. A separately created `eezex/` nested repository is outside this work and is excluded from commits.
- Commit subject: `feat: prove browser reproduction and sanitized evidence export`.
- Next: VAL-02 baseline/candidate regression verification.
- Checkpoint: `6727655`.

## 2026-10-26 — VAL-02 — Technical repair verification

- Added a reviewable patch accepting plus aliases, applied only to a disposable copy of the pinned fixture. The original defective fixture remains available for replay.
- Ran the same regression in separate processes: baseline failed twice at the expected 201-versus-400 assertion; candidate passed twice. Both builds passed all 13 supporting checks.
- Added negative gate checks for baseline false positives, unrelated failures, missing/mismatched evidence, and failed existing checks. Technical success explicitly leaves independent operator acceptance pending.
- Exported the patch, structured baseline/candidate results, sanitized candidate traces, source/build fingerprints, and artifact hashes; committed the summary in `docs/evidence/VAL-02.json`. Baseline diagnostic traces remain private under the narrow export policy.
- Validation: `npm run spike:verify` exited successfully after the required baseline failures, candidate passes, supporting checks, unchanged-baseline check, and export hash checks. An initial output-directory collision was fixed before the successful run.
- Limitation: all execution came from the same operator. VAL-02 is still in progress until another operator supplies independent review; no payout or marketplace acceptance is claimed.
- Commit subject: `feat: verify repairs against baseline and candidate builds`.
- Next: VAL-03 payment capability/recovery validation and VAL-04 resource-provider validation.

## 2026-10-26 — VAL-03 — Remesso USDC policy and durable recovery

- Checked current official Remesso documentation and pinned SDK 0.3.0 / viem 2.57.7. Verified USDC address/decimals and deployed Remesso code on an owned Celo fork.
- Added an executable local-only payout experiment with guarded public Anvil accounts, private durable journals, a separate synthetic payable, and child-process fault injection immediately after broadcast.
- Validation: 19 integration checks passed. A replacement worker reconciled the original transaction; another retry reused it. Recipient balance rose exactly 250,000 USDC base units and the sender consumed one nonce. Changed terms, debit/policy limits, disallowed recipient, invalid precision, incorrect receipt amount, and corrupt journals refused. Revocation retained accepted debt as blocked.
- `npm test` passed all 15 supporting checks, including two remote-signing guard tests. Git diff checks passed. Committed the reviewed summary, not signed raw journals, at `docs/evidence/VAL-03.json`.
- Limitations: local-fork funds and synthetic acceptance only; file storage is single-writer. Real backend/finality, multi-worker coordination, transactional application ledger/outbox, and pausing claims remain unimplemented. No mainnet payment, public deployment, or hackathon enrollment occurred.
- Provider discovery also observed unsigned buy quotes; VAL-04 remains in progress for controls and resource-output evidence.
- Commit subject: `feat: prove Remesso payout recovery on a local Celo fork`.
- Next: finish VAL-04 quote caps and uncertain-settlement controls, retaining funded provisioning as a separate gate.

## 2026-10-26 — VAL-04 — Resource quotes, bounded purchasing, and recovery controls

- Read the official buy documentation, inspected pinned buy-core 0.8.4, and recorded unsigned live 402 offers: browser one minute at 3,606 USDC base units; e2-micro VM one hour at 16,753. These are dated quotes, not fixed prices or purchases.
- Added a simulation-only resource adapter with pinned quote terms, successful funding lookup, per-purchase cap, shared ceiling, private durable reservations, and public authorization persistence before dispatch. One intent cannot be retried as a new purchase after uncertain responses or journal reopening.
- Added chain reconciliation requiring nonce plus exact transfer in a successful canonical receipt. Unused authorization releases only after expiry at a finalized block; missing/RPC/term evidence retains liability. No resource output means zero builder charges in the fixture.
- Validation: 14 fork checks passed with real SDK signatures and actual local USDC transfers, followed by a lost response or simulated HTTP 500 and fresh-process recovery. `npm test` passed all 28 checks, including 13 resource cases and negative receipt/quote tests. The live quote command cannot sign; the paid harness rejects live provider URLs.
- Failures resolved: the first unit fixture lacked the x402 envelope's required `error` field; corrected before passing tests. Initial local settlement failed with the public Anvil payer, whose mainnet state contains EIP-7702 delegated code. Read-only checks confirmed the quoted domain/type hash; using a fresh ephemeral EOA passed. Account-type compatibility remains a production check.
- Preserved sanitized quotes and recovery evidence in `docs/evidence/VAL-04-quotes.json` and `VAL-04.json`. Signed payloads/keys are excluded. SDK install audit reported zero vulnerabilities; this is not a security audit.
- Limitations: no real resource allocation, provider receipt, output/trace export, isolation, finality timing, multi-worker journal, or production reimbursement proof. VAL-04 remains in progress. D012 permits architecture selection while these gates remain explicit.
- Commit subject: `feat: validate buy resource caps and uncertain settlement recovery`.
- Next: VAL-05 architecture/stack decision, followed by ALPHA-01; finish independent review and funded resource proof separately.

## 2026-10-27 — VAL-05 — Application architecture selected

- Selected a TypeScript/Next.js modular monolith with a separate Node worker, PostgreSQL/explicit SQL migrations, database outbox and lease fencing, Better Auth sessions, private S3 artifacts, Render containers, and a separate gVisor execution boundary.
- Documented alternatives, transaction/authority boundaries, runtime/module layout, local verification, and deferred integrations in `docs/ARCHITECTURE.md`. D013 resolves the open stack decision; D012 continues to preserve incomplete resource/independence gates.
- Verified current official documentation and package compatibility. Downloaded the official PostgreSQL 18.6 image for isolated local development; no existing database was modified.
- Validation: inspected source requirements and package versions; architecture maps all requested concerns. This checkpoint is a decision, not an implemented authentication, hosting, isolation, or payment claim.
- Commit subject: `docs: select the Trialoom application architecture`.
- Next: ALPHA-01 runnable scaffold and appropriate checks.
