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
