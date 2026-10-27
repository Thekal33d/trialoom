# Current status

Last updated: 2026-10-27 (Africa/Lagos).

## State

**M2 in progress: ALPHA-03 operator connection and qualification are verified locally.** On top of ALPHA-02's invitation-only sessions, roles, authorized targets, pinned builds, and immutable draft terms, operators now register a platform-level identity, prove wallet control with EIP-4361, hold scoped revocable agent credentials, and earn per-service eligibility from graded seeded tasks. The agent API is versioned, bearer-only, and idempotent per operator. The eligible-work listing is empty by construction because campaigns cannot be published. Claims, ledger, execution, settlement, and deployment remain pending. M1 still has open independent-operator and paid-resource gates.

| Area | State | Evidence |
| --- | --- | --- |
| Product requirements | Captured | [Original PRD](../docs/PRD.md) |
| Persistent context and work protocol | Established | [Project memory](PROJECT.md), [agent instructions](../AGENTS.md), [Claude entry point](../CLAUDE.md) |
| Build roadmap and tracked work | Established | [Roadmap](../docs/ROADMAP.md), [backlog](../docs/BACKLOG.md) |
| Requirement/scenario coverage | Mapped; not implemented | [Validation register](../docs/VALIDATION.md) |
| Hackathon alignment | Researched; track proposed | [Dated source notes and checklist](../docs/HACKATHON.md) |
| Browser/evidence harness | Working locally | [Experiment](../spikes/browser-evidence/README.md), [manifest](../docs/evidence/VAL-01.json) |
| Repair verification | Technical gate passed; independent review pending | [Repair evidence](../docs/evidence/VAL-02.json) |
| Marketplace architecture | Selected | [Architecture](../docs/ARCHITECTURE.md), D013 |
| Application scaffold | Verified locally | [Run guide](../docs/DEVELOPMENT.md), [ALPHA-01 evidence](../docs/evidence/ALPHA-01.json): demo UI, database/worker, 53 checks, production build; CI configured |
| Accounts and project setup | Verified locally | [ALPHA-02 design and limits](../docs/ALPHA-02.md), [evidence](../docs/evidence/ALPHA-02.json): real sessions/roles, authorized projects/builds, draft term versions; claims/payment authority unavailable |
| Operator connection and qualification | Verified locally | [ALPHA-03 design and limits](../docs/ALPHA-03.md), [evidence](../docs/evidence/ALPHA-03.json): wallet proof, scoped credentials, graded seeded tasks, idempotent agent API; no claimable work or payout authority |
| Celo / Remesso capability | Passed on local Celo fork | [Experiment](../spikes/payments/README.md), [19-check evidence](../docs/evidence/VAL-03.json); production integration pending |
| buy resource capability | Local controls passed; provisioning pending | [Experiment](../spikes/resources/README.md), [quotes](../docs/evidence/VAL-04-quotes.json), [14-check fork evidence](../docs/evidence/VAL-04.json) |
| Git remote and public repository | Not configured | Local checkpoint history only |
| Event enrollment and deployment | Not performed | No entry or live demo |

## Next action

**ALPHA-04:** implement the campaign ledger and atomic claims, leases, and cancellation. A claim must pin one exact immutable `terms_versions.id` and `build_id` inside the claim transaction and must never resolve through `latest_version`; the ALPHA-03 work listing is a view, not a reservation. Publication belongs with funding and reservations, so the `campaigns.status='draft'` check should only be relaxed when a ceiling and commitment accounting exist. Concurrent last-slot claims must admit exactly one operator.

ALPHA-05 then needs runner isolation before any operator executes anything; ALPHA-03 grants no execution access and no scoped runtime credentials.

A local **Trialoom** owner invitation has been created for the user and saved privately under ignored `artifacts/invitations/`. Enrollment awaits the user choosing their password; no email was sent. The local app runs at [the workspace](http://127.0.0.1:3000/workspace). Do not put its private invitation token or the user's email in repository records.

**VAL-02 remains open only for independent operator review:** have a different operator reproduce the baseline/candidate result against pinned source hashes and record their identity/conflicts and evidence. A separate process from this session does not satisfy that requirement. **VAL-04** still needs a funded browser session, useful journey output, trace export, isolation/cleanup checks, and an actual provider receipt; its [experiment notes](../spikes/resources/README.md) define the next funded gate. These gaps do not block architecture selection (D012). See [BACKLOG.md](../docs/BACKLOG.md).

## Dependencies to resolve before implementation or submission

- Complete operator qualification, ledger/claim controls, and runner isolation before enabling published/claimable work or execution.
- Before production onboarding, add the identity/recovery, abuse/perimeter, database privilege, and operational controls listed in [ALPHA-02](../docs/ALPHA-02.md).
- Validate production Remesso coordination/finality and optional paid-resource capabilities; local policy recovery is proven.
- Confirm hackathon enrollment, track, public repository, agent identity, and attribution requirements before submission activity.

No dependency blocks local capability work. Registration, wallet funding, and deployment have not been performed. Paid experiments still require concrete funding details.

## Latest validation

- SETUP-01: original PRD byte comparison/hash and local links passed; preserved source hard breaks have a file-specific Git attribute.
- SETUP-02: documentation links, requirement/scenario coverage, and diff checks are recorded in [BUILD_LOG.md](BUILD_LOG.md).
- VAL-01: 8 Node checks pass; two fresh Chromium journeys reproduced the defect. The export contains sanitized traces, explicit product failures, build hashes, and artifact integrity records.
- VAL-02: baseline regression fails twice for the seeded defect; the same candidate regression passes twice. All 13 supporting checks pass on both builds, including negative acceptance-gate cases. Baseline source remains unchanged.
- VAL-03: 19 fork checks passed: actual USDC policy payment, crash immediately after broadcast, fresh-process recovery, one recipient payment/nonce, receipt validation, revocation preserving debt. Two local-signing guard checks added.
- VAL-04: live unsigned browser/VM quotes recorded; 14 fork checks passed with real SDK EIP-3009 signatures/local USDC settlement and simulated lost/500 responses. Fresh processes matched exact receipts without another purchase. No provider resource was allocated.
- Latest `npm test`: 28 passing checks, including 13 resource-control cases. Signed resource transport is restricted to the simulation fixture.
- ALPHA-01: clean `npm ci --ignore-scripts`, lint/type checks, and production build passed. Seven database tests cover migration serialization/checksums, rollback, deduplication, fencing, process restart, and exhaustion. All 18 browser checks pass, including accessibility scans on four routes at two viewports, report download, mobile navigation, and unavailable-database readiness. Local smoke job enqueued and completed; setup preserves the existing private `.env`.
- ALPHA-03: lint/type checks and production build pass; 49 database checks and 34 desktop/mobile browser checks pass. Covered: server-built EIP-4361 messages bound to origin/scheme/address/nonce/chain 42220, single-use nonces against replay, borrowed challenges, foreign signers and self-written messages, row-level and message-level expiry, one live address claim across operators, one live payout designation, revocation and re-proof, credential digests/scopes/caps/expiry/revocation/suspension, grading of correct, incorrect and false reports, attempt caps under five concurrent submissions, all four eligibility reasons, idempotent replay/mismatch/in-progress/concurrent retry with no key stored after a refusal, and a real draft brief refusing publication. Browser checks drive registration, wallet proof pasted from an external signature, credential issuance, the agent API over real HTTP, and refusal immediately after revocation. No axe violations or document overflow on the operator console. [Evidence](../docs/evidence/ALPHA-03.json).
- ALPHA-02: lint/type checks and production build pass; 28 capability checks, 24 database checks, and 30 desktop/mobile browser checks pass. Real SDK credentials/sessions, invite races, role/tenant isolation, expiry/revocation, SSRF admission, immutable builds/terms, exact base units, concurrent edits, and browser onboarding/setup are covered. No detected axe violations or document overflow on checked account/project/access and demo surfaces. [Evidence](../docs/evidence/ALPHA-02.json) records boundaries and hashes.
- CI is configured but has not run on GitHub. Screens use labelled demo data; the calm green/light design is provisional pending user preference.
- No marketplace acceptance or production payment tests have run; local evidence does not establish production readiness.

The unrelated nested `eezex/` repository is untracked in this repository and is excluded from these checkpoints.

## Handoff convention

Keep this file focused on the current state. Append history to [BUILD_LOG.md](BUILD_LOG.md). Use `git log --oneline` for exact checkpoint hashes; do not maintain a self-referential latest-commit field.
