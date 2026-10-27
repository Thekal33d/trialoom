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

## 2026-10-27 — ALPHA-01 — Runnable workspace and durable worker

- Built a Next.js/React workspace with responsive overview, filter/search recovery, before/after evidence, downloadable demo report, payments explanation, and guide. Canopy is an example project; fixture results explicitly retain pending independent review and no payment authority. Bundled fonts locally and recorded the provisional visual direction in `.impeccable.md` while awaiting user preference.
- Added an isolated loopback PostgreSQL 18.6 Compose service, private generated configuration, append-only checksum migrations, transaction helper, and separate Node worker. Durable `system.ping` jobs exercise deduplication, leases, stale-token fencing, atomic local effects, retries, and recorded exhaustion. No customer or financial tables/handlers are enabled.
- Added Biome, strict TypeScript, documented install/start/migrate/worker/check commands, and pinned GitHub CI actions with a disposable database. CI is configured but not executed remotely; no Git remote exists.
- Validation: clean `npm ci --ignore-scripts` and production build passed; lint and type checks passed; all 28 existing checks, seven database checks, and 18 desktop/mobile browser checks passed. Four routes at two viewports have no detected axe WCAG A/AA violations or document overflow. Inspected rendered desktop/mobile pages. The local smoke identity `alpha01-smoke` was enqueued and completed. Re-running setup preserved the ignored `.env` with mode 0600.
- Resolved initial failures: browser scans caught insufficient muted-text contrast; darkened text and increased small labels, then reran successfully. Corrected a test's outdated heading locator. Loopback fixture tests initially hit sandbox `EPERM`; the authorized local-server run passed. Dependency installation reports zero known vulnerabilities; this is not a security audit.
- Sanitized evidence, exact source hashes, commands, versions, and limitations are recorded in `docs/evidence/ALPHA-01.json`. The original PRD is unchanged. Generated browser artifacts and local credentials remain ignored; the unrelated `eezex/` repository is untouched.
- Limitations: synthetic UI only; no authentication, real campaigns, acceptance/ledger, live payments/resources, private storage, runner isolation, or deployment. ALPHA-01 does not complete ALPHA-10 or any marketplace release scenario. Independent operator review and real resource provisioning remain open M1 gates.
- Commit subject: `feat: scaffold the Trialoom workspace and durable worker`.
- Next: ALPHA-02 invite-only sessions, workspace roles, persisted projects/builds, and immutable terms.

## 2026-10-27 — ALPHA-02 — Invited accounts and immutable project terms

- Added Better Auth PostgreSQL sessions, password verification, invitation-only onboarding, owner-managed invitations/membership, last-owner protection, transaction-scoped role checks, and append-only reviewer/access auditing. Public signup is disabled; existing accounts must authenticate before accepting another invitation. Membership removal takes effect on the next request.
- Added explicit target permission, public-HTTPS/DNS admission, immutable project/build records, and draft campaigns with immutable term versions. Terms include pinned build/fixture identity, scope, acceptance/rewards, exact integer USDC amounts, deadlines, rights, and payment/resource rules. Campaign locking and expected-version checks refuse stale concurrent edits without altering prior versions.
- Built real sign-in/join, project/build/brief setup, version history, and workspace-access screens. `/demo` stays separate. Added shared database request limits, same-origin mutations, bounded JSON bodies, private response headers, generic unexpected errors, and a narrow authentication endpoint allowlist. D015/D016 record choices and implementation boundaries.
- Added safe auth configuration and private invitation CLI. Applied migrations 0002/0003 locally. At the user's request, created one Trialoom owner invitation and saved it to an ignored mode-0600 file; user password selection is pending. No email was sent. Local production server is running on loopback port 3000; the workspace redirects unauthenticated users and database readiness returns 200.
- Validation: `npm run check` passed (lint, strict types, 28 capability checks); all 24 database checks passed; `npm run build` passed; all 30 production-browser checks passed at desktop/mobile Chromium viewports. Checked invitation/session lifecycle, access changes, unauthorized/foreign-workspace refusal, DNS/IP rejection, immutable records, exact large token values, concurrent edits, origin/body/rate limits, and persistence after reload. Axe scans detected no WCAG A/AA violations or document overflow on checked surfaces; rendered sign-in, projects, terms, and access screens were reviewed. Final lint/type checks also passed after test-selector fixes.
- Resolved initial failures: upgraded Zod from vulnerable 4.4.3 to 4.6.7 (GHSA-mrhx-c7xc-m3w5) and pinned current ipaddr.js 2.5.0; production dependency audit reports zero known vulnerabilities. Corrected environment-fixture typing. Browser checks initially matched Next.js's hidden route announcement and then a prefilled textarea's label text; scoped alerts to main content and selected the textbox by its accessible role/name. The complete setup journey has a 60-second test budget; final runs took 8.3 seconds desktop and 15.6 seconds mobile. No application error was suppressed to pass a test.
- Preserved evidence/source hashes in `docs/evidence/ALPHA-02.json`, updated the run guide, architecture, roadmap/backlog, validation, and memory. PRD SHA-256 remains unchanged; private config, invitation links, browser credentials/traces, and the unrelated `eezex/` repository are excluded from the commit.
- Limitations: draft work only. No publication, claim/reservation ledger, acceptance, payment authority, operator credentials/qualification, runner isolation, deployment, or useful paid-resource proof. Invitation delivery does not prove email ownership. Target/revision declarations still require runtime verification in ALPHA-05. Exact claim-to-terms binding belongs to ALPHA-04; full FR01–FR03/R05 and marketplace release gates are not claimed complete. CI is configured but has not run remotely.
- Commit subject: `feat: add invited workspaces and immutable project terms`.
- Next: ALPHA-03 operator connection and qualification; ALPHA-04 ledger/claims is also ready. Preserve the open independent-review and funded-resource gates.

## 2026-10-27 — ALPHA-03 — Operator connection and qualification

- Checked current official sources before choosing the signature flow: the EIP-4361 grammar, nonce rules, and relying-party verification steps, plus viem's SIWE utilities and the client-bound `verifySiweMessage` action. Chose server-authored EIP-4361 messages with ERC-191 recovery and no RPC dependency; ERC-1271/ERC-6492 contract accounts are refused rather than silently accepted. Moved pinned viem 2.57.7 into production dependencies.
- Added migration `0004_operators.sql`: platform-level operator identity bound to one account, single-use wallet challenges storing the verbatim message, proven wallets with partial unique indexes for one live address across operators and one live payout designation, scoped agent credentials with a database-enforced allowlist, four seeded qualification tasks with server-side answer keys, immutable attempts, a derived eligibility projection, and an operator-keyed idempotency table.
- Implemented wallet proof that verifies only the stored message, validates origin authority, scheme, address, nonce, chain 42220 and time, recovers the signer, consumes the nonce in the same transaction, and stores a signature digest rather than a reusable signature. Revocation releases the address and clears payout designation without cancelling accepted obligations.
- Implemented graded qualification separating accuracy failures from false reports, a three-attempt cap serialized by an advisory lock, and eligibility recomputed from immutable attempts with four explicit reasons. A false report is not cleared by later passes.
- Added the versioned agent API: bearer credentials only, cookies refused, scopes enforced, per-operator idempotency that replays a stored response, refuses a mismatched request, waits out a concurrent duplicate, and leaves no key after a refusal. The eligible-work listing joins admission, eligibility, and the exact terms version a claim must pin, and names the publication gate instead of hiding the empty result. Assignment routes answer 501.
- Built the operator console at `/operator` and routed operator-role members there from the workspace. The app asks for no private key; the operator signs the message in their own wallet and pastes the signature. A credential secret is shown once.
- Validation: `npm run check` passed (lint, strict types, 28 capability checks); 49 database checks passed; `npm run build` passed; all 34 production-browser checks passed at desktop and mobile Chromium viewports with no detected axe violations or document overflow. Reviewed the rendered desktop console.
- Resolved failures during the step: the challenge insert first violated the non-empty message check, fixed by generating the row id and message before the single insert; viem's `generateSiweNonce` returns 96 characters, so the nonce constraints were widened; two expiry tests violated `expires_at > issued_at` and `expires_at > created_at` until both timestamps were moved back; the publication-gate assertion passed vacuously until a real project, build, and draft brief were created. No application error was suppressed to pass a check.
- Preserved evidence, 94 source hashes, limits, and the checked official sources in `docs/evidence/ALPHA-03.json`; recorded the design in `docs/ALPHA-03.md` and the choice as D017.
- Limitations: no published work, claims, reservations, leases, heartbeats, evidence ingestion, decisions, or payouts. Externally owned accounts only. A wallet signature is attribution, not proof of correct work or of independent operation. Seeded tasks measure fixture accuracy and false reporting, not general agent competence. No appeal or qualification reset exists; no runner isolation or execution access is granted; expired challenges, credentials, and idempotency keys are not cleaned up. Independent operator review and funded resource proof remain open.
- Commit subjects: `feat: prove operator wallet control and scope agent credentials`, `feat: grade seeded qualification and serve a scoped agent API`, `feat: add the operator console and agent API browser checks`.
- Next: ALPHA-04 ledger, atomic claims, leases, and cancellation; a claim must pin one exact terms version and build inside its own transaction.
