# Current status

Last updated: 2026-10-27 (Africa/Lagos).

## State

**M1 in progress: browser, repair, payout recovery, and resource-payment controls have local proofs.** VAL-01 and VAL-03 are complete locally. VAL-02 independent operator review and VAL-04 real resource provisioning remain open. There is no deployed marketplace application yet.

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
| Application scaffold | In progress | ALPHA-01: Next.js, PostgreSQL migrations, separate worker, local tooling and CI |
| Celo / Remesso capability | Passed on local Celo fork | [Experiment](../spikes/payments/README.md), [19-check evidence](../docs/evidence/VAL-03.json); production integration pending |
| buy resource capability | Local controls passed; provisioning pending | [Experiment](../spikes/resources/README.md), [quotes](../docs/evidence/VAL-04-quotes.json), [14-check fork evidence](../docs/evidence/VAL-04.json) |
| Git remote and public repository | Not configured | Local checkpoint history only |
| Event enrollment and deployment | Not performed | No entry or live demo |

## Next action

**ALPHA-01:** implement and verify the selected scaffold: web shell, explicit PostgreSQL migrations, harmless durable worker flow, safe local configuration, and CI. Keep public routes fixture-only until real authentication/authorization is implemented in ALPHA-02.

**VAL-02 remains open only for independent operator review:** have a different operator reproduce the baseline/candidate result against pinned source hashes and record their identity/conflicts and evidence. A separate process from this session does not satisfy that requirement. **VAL-04** still needs a funded browser session, useful journey output, trace export, isolation/cleanup checks, and an actual provider receipt; its [experiment notes](../spikes/resources/README.md) define the next funded gate. These gaps do not block architecture selection (D012). See [BACKLOG.md](../docs/BACKLOG.md).

## Dependencies to resolve before implementation or submission

- Implement the selected architecture and verify database/worker/browser behavior before closing ALPHA-01.
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
- No marketplace acceptance or production payment tests have run; local evidence does not establish production readiness.

The unrelated nested `eezex/` repository is untracked in this repository and is excluded from these checkpoints.

## Handoff convention

Keep this file focused on the current state. Append history to [BUILD_LOG.md](BUILD_LOG.md). Use `git log --oneline` for exact checkpoint hashes; do not maintain a self-referential latest-commit field.
