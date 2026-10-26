# Current status

Last updated: 2026-10-27 (Africa/Lagos).

## State

**M2 started: the local application scaffold is verified.** The demo workspace, PostgreSQL migrations, and durable smoke worker run locally. M1 still has open independent-operator and paid-resource gates. Authentication, marketplace workflows, and deployment remain pending.

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
| Celo / Remesso capability | Passed on local Celo fork | [Experiment](../spikes/payments/README.md), [19-check evidence](../docs/evidence/VAL-03.json); production integration pending |
| buy resource capability | Local controls passed; provisioning pending | [Experiment](../spikes/resources/README.md), [quotes](../docs/evidence/VAL-04-quotes.json), [14-check fork evidence](../docs/evidence/VAL-04.json) |
| Git remote and public repository | Not configured | Local checkpoint history only |
| Event enrollment and deployment | Not performed | No entry or live demo |

## Next action

**ALPHA-02:** implement invite-only sessions and workspace role checks, then persisted projects, authorized targets, pinned builds, and immutable term versions. Prove unauthorized access is refused and edits apply only to future work. Keep `/demo` separate from real account/project data.

**VAL-02 remains open only for independent operator review:** have a different operator reproduce the baseline/candidate result against pinned source hashes and record their identity/conflicts and evidence. A separate process from this session does not satisfy that requirement. **VAL-04** still needs a funded browser session, useful journey output, trace export, isolation/cleanup checks, and an actual provider receipt; its [experiment notes](../spikes/resources/README.md) define the next funded gate. These gaps do not block architecture selection (D012). See [BACKLOG.md](../docs/BACKLOG.md).

## Dependencies to resolve before implementation or submission

- Implement real authentication/authorization before enabling customer records or business mutations.
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
- CI is configured but has not run on GitHub. Screens use labelled demo data; the calm green/light design is provisional pending user preference.
- No marketplace acceptance or production payment tests have run; local evidence does not establish production readiness.

The unrelated nested `eezex/` repository is untracked in this repository and is excluded from these checkpoints.

## Handoff convention

Keep this file focused on the current state. Append history to [BUILD_LOG.md](BUILD_LOG.md). Use `git log --oneline` for exact checkpoint hashes; do not maintain a self-referential latest-commit field.
