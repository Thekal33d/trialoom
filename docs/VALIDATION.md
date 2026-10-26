# Validation and evidence register

Last updated: 2026-10-26. Source: [PRD release acceptance scenarios](PRD.md#release-acceptance-scenarios).

**Application checks have not run: no implementation exists.** Record command, date, tested commit/build, fixture, outcome, and sanitized artifact references when checks are implemented and executed. Preserve failed and blocked outcomes.

## Capability experiments

| Task | Evidence needed | Result |
| --- | --- | --- |
| VAL-01 | Trace export, build/fixture metadata, assertions, two clean reproductions, redaction | Not run |
| VAL-02 | Baseline failure, candidate pass, existing checks, independent verifier | Not run |
| VAL-03 | Verified integration facts and persistent recovery under policy loss and crash after broadcast | Not run |
| VAL-04 | Useful resource output, cost ceiling, receipt, isolation, timeout reconciliation | Not run |

## Release scenarios

These IDs correspond to the twelve numbered PRD scenarios. Each needs an implementation-level check, not a UI-only demonstration.

| ID | Required outcome | Owning work | Result |
| --- | --- | --- | --- |
| R01 | Concurrent last-slot claims admit one operator and preserve the ceiling | ALPHA-04 | Not run |
| R02 | Valid execution exposing a product failure remains payable independently of discovery | ALPHA-06, ALPHA-08 | Not run |
| R03 | Duplicate defect earns one discovery award; assigned reproduction can earn its own fee | ALPHA-06 | Not run |
| R04 | A test that also passes on baseline cannot establish a regression repair | ALPHA-07 | Not run |
| R05 | Build changes cannot silently transfer a result to the new build | ALPHA-02, ALPHA-05 | Not run |
| R06 | Crash after broadcast reconciles the original payment without another transfer | ALPHA-08 | Not run |
| R07 | Resource timeout after settlement retains its commitment until reconciliation | ALPHA-09 | Not run |
| R08 | Policy revocation after acceptance preserves debt, shows the block, and pauses claims | ALPHA-04, ALPHA-08 | Not run |
| R09 | Cancellation stops claims and preserves accepted work/disclosed incurred costs | ALPHA-04, ALPHA-09 | Not run |
| R10 | Sensitive evidence is withheld pending redaction and access review | ALPHA-05, PILOT-01 | Not run |
| R11 | A linked agent cannot independently verify its own operator's work | ALPHA-03, ALPHA-06 | Not run |
| R12 | Expired attempts cannot spend further or create another accepted delivery | ALPHA-04, ALPHA-05 | Not run |

## Additional gates

- FR01–FR16 coverage: work is mapped in [BACKLOG.md](BACKLOG.md); validate full PRD acceptance text before closing it.
- Financial invariant: include resources/fees, reclassification, shared-wallet campaigns, outbox replay, concurrent workers, integer base units.
- Provider claims: verify versions, token/contracts, allowances, limits, fees, and finality using current official documentation and observed results.
- Runner protection: test target/redirect restrictions, DNS/internal-network boundaries, credential isolation, deadlines, resource caps.
- Pilot operations: check retention/dispute holds, exports, reviewer coverage, appeal windows, instrumentation, measured performance/reliability targets.
- Hackathon: complete [HACKATHON.md](HACKATHON.md) separately; passing software checks alone does not establish eligibility.

## Recorded outcomes

| Date | Task/scenario | Tested commit/build | Procedure | Result | Evidence / limitations |
| --- | --- | --- | --- | --- | --- |
| 2026-10-26 | SETUP-01 | `22e6ce0` | PRD byte comparison/hash, local links, staged diff | Passed | Original preserved; no application claims |
| 2026-10-26 | SETUP-02 | Working tree for this documentation checkpoint | Local links/anchors, unique task IDs, FR/scenario coverage, PRD comparison/hash, diff checks | Passed | 12 Markdown files, 25 tasks, FR01–FR16, R01–R12; no application tests |

Raw private traces and credentials are not commit artifacts. Commit sanitized fixtures, test code, and approved evidence summaries; use access-controlled records for private artifacts when the platform exists.
