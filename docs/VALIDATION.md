# Validation and evidence register

Last updated: 2026-10-27. Source: [PRD release acceptance scenarios](PRD.md#release-acceptance-scenarios).

**Local capability and application-scaffold checks have run; marketplace release scenarios remain unimplemented.** Record command, date, tested commit/build, fixture, outcome, and sanitized artifact references. Preserve failed and blocked outcomes.

## Capability experiments

| Task | Evidence needed | Result |
| --- | --- | --- |
| VAL-01 | Trace export, build/fixture metadata, assertions, two clean reproductions, redaction | Passed locally; [manifest](evidence/VAL-01.json) |
| VAL-02 | Baseline failure, candidate pass, existing checks, independent verifier | Technical proof passed; [manifest](evidence/VAL-02.json). Independent operator review pending |
| VAL-03 | Verified integration facts and persistent recovery under policy loss and crash after broadcast | 19 checks passed on local Celo fork; [evidence](evidence/VAL-03.json). Production backend/finality and concurrent workers untested |
| VAL-04 | Useful resource output, cost ceiling, receipt, isolation, timeout reconciliation | [Unsigned live quotes](evidence/VAL-04-quotes.json), 13 control cases and [14 fork settlement/recovery checks](evidence/VAL-04.json) passed. Real allocation/output, isolation, trace export, and provider receipt pending |

## Application foundation

ALPHA-01 passed a clean lockfile install, lint/type/build checks, seven disposable-database checks, and 18 desktop/mobile browser checks. The demo exports a fixture summary and leaves independent acceptance/payment unavailable. [Evidence](evidence/ALPHA-01.json) records versions, source hashes, and limits. Queue lease tests cover the harmless smoke handler; they do not establish the assignment or financial invariants below.

ALPHA-02 added invitation-only sessions, workspace roles, authorized project/build records, and immutable draft terms. ALPHA-03 added operator registration, EIP-4361 wallet control, scoped revocable agent credentials, seeded qualification grading with derived eligibility, and a versioned agent API with idempotent mutations. [ALPHA-03 evidence](evidence/ALPHA-03.json) records 49 database checks, 34 browser checks, and the gates that remain, including the empty eligible-work listing.

## Release scenarios

These IDs correspond to the twelve numbered PRD scenarios. Each needs an implementation-level check, not a UI-only demonstration.

| ID | Required outcome | Owning work | Result |
| --- | --- | --- | --- |
| R01 | Concurrent last-slot claims admit one operator and preserve the ceiling | ALPHA-04 | Not run |
| R02 | Valid execution exposing a product failure remains payable independently of discovery | ALPHA-06, ALPHA-08 | Not run |
| R03 | Duplicate defect earns one discovery award; assigned reproduction can earn its own fee | ALPHA-06 | Not run |
| R04 | A test that also passes on baseline cannot establish a regression repair | ALPHA-07 | Negative gate tested in local harness; marketplace integration not run |
| R05 | Build changes cannot silently transfer a result to the new build | ALPHA-02, ALPHA-04, ALPHA-05 | ALPHA-02 proves immutable build/term records and rejects foreign builds; claim/result binding and actual deployment verification remain unimplemented |
| R06 | Crash after broadcast reconciles the original payment without another transfer | ALPHA-08 | Passed in VAL-03 local provider spike; marketplace/outbox integration not run |
| R07 | Resource timeout after settlement retains its commitment until reconciliation | ALPHA-09 | VAL-04 simulated lost/500 responses after actual local USDC settlement; commitment retained until fresh-process chain reconciliation. Live provider and marketplace ledger untested |
| R08 | Policy revocation after acceptance preserves debt, shows the block, and pauses claims | ALPHA-04, ALPHA-08 | VAL-03 preserves a synthetic accepted payable as blocked; marketplace and claims pausing not implemented |
| R09 | Cancellation stops claims and preserves accepted work/disclosed incurred costs | ALPHA-04, ALPHA-09 | Not run |
| R10 | Sensitive evidence is withheld pending redaction and access review | ALPHA-05, PILOT-01 | Not run |
| R11 | A linked agent cannot independently verify its own operator's work | ALPHA-03, ALPHA-06 | ALPHA-03 binds one operator identity per account and one live payout address across operators; separation of discoverer, repairer, and verifier is unimplemented |
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
| 2026-10-26 | VAL-01 | Content hashes in [manifest](evidence/VAL-01.json) | `npm test`; `npm run spike:reproduce`; Playwright trace CLI inspection | Passed | 8 checks; 2 clean browser runs; normal invitation 201, plus alias 400; seeded sensitive values removed; local fixture only |
| 2026-10-26 | VAL-02 | Content hashes in [manifest](evidence/VAL-02.json) | `npm run spike:verify` | Technical proof passed | 2 baseline failures and 2 candidate passes; 13 supporting checks pass on each build; no independent operator claim |
| 2026-10-26 | VAL-03 | Source hashes in [manifest](evidence/VAL-03.json) | `npm run spike:payments`; `npm test` | Local provider capability passed | 19 fork checks; remote-signing guards; actual 0.25 local USDC transfer exactly once after crash/restart; no mainnet funds |
| 2026-10-26 | VAL-04 | Source hashes in [manifest](evidence/VAL-04.json) | `npm run spike:resource-quotes`; `npm run spike:resources`; `npm test` | Local controls passed; resource proof pending | 14 fork checks, 13 resource tests; complete suite 28 passed. Fresh ephemeral payer fixed delegated-code fixture incompatibility; no paid provider requests |
| 2026-10-27 | ALPHA-01 | Source hashes in [manifest](evidence/ALPHA-01.json) | Clean install, lint/type/build, `npm test`, `npm run test:db`, `npm run test:e2e`, local worker smoke | Passed locally | 28 existing checks, seven database checks, 18 browser checks; zero detected axe violations on four routes/two viewports. CI configured but not run remotely; fixture-only app |
| 2026-10-27 | ALPHA-02 | Source hashes in [manifest](evidence/ALPHA-02.json) | `npm run check`, `npm run test:db`, production build, `npm run test:e2e`, private owner invitation | Passed locally | 28 capability, 24 database, 30 desktop/mobile browser checks; real sessions/roles, tenant boundaries, authorized project/build records, append-only terms, edit races, HTTP defenses, and accessibility. Drafts only; no claim/result binding, payment authority, or production readiness claim |
| 2026-10-27 | ALPHA-03 | Source hashes in [manifest](evidence/ALPHA-03.json) | `npm run check`, `npm run test:db`, production build, `npm run test:e2e` | Passed locally | 49 database and 34 desktop/mobile browser checks; wallet proof with single-use nonces, scoped credential lifecycle, qualification grading and eligibility, idempotent agent mutations, and the enforced publication gate. No published work, claims, execution, or payouts |

Raw private traces and credentials are not commit artifacts. Commit sanitized fixtures, test code, and approved evidence summaries; use access-controlled records for private artifacts when the platform exists.
