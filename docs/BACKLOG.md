# Build backlog

Last updated: 2026-10-27. Source: [PRD](PRD.md). Milestones: [ROADMAP.md](ROADMAP.md).

States: **Ready**, **In progress**, **Blocked**, **Not started**, **Done**, **Deferred**. Ready means dependencies permit work. Done requires acceptance evidence and a checkpoint commit. Dependencies identify tasks, not elapsed time.

## Foundation and capability validation

| ID | Milestone | Work | State | Depends on | Acceptance / evidence |
| --- | --- | --- | --- | --- | --- |
| SETUP-01 | M0 | Repository and persistent memory | Done | — | PRD preserved byte-for-byte; linked memory/instructions; commit `22e6ce0` |
| SETUP-02 | M0 | Roadmap, backlog, hackathon notes, validation register | Done | SETUP-01 | Dated sources; mapped requirements; truthful status and next action; documentation checkpoint |
| VAL-01 | M1 | Runner and evidence spike | Done | SETUP-02 | Two clean Chromium reproductions, build/fixture IDs, assertions, sanitized traces and verified hashes; [recorded evidence](evidence/VAL-01.json) |
| VAL-02 | M1 | Repair verification spike | In progress | VAL-01 | Technical proof passed: baseline fails twice, candidate passes twice, supporting checks pass on both; [evidence](evidence/VAL-02.json). Independent operator review remains pending |
| VAL-03 | M1 | Remesso and recovery spike | Done | SETUP-02 | 19 checks passed on local Celo fork: deployed code/USDC, durable journal, policy loss, actual crash after broadcast and fresh-process recovery without duplicate transfer. [Evidence](evidence/VAL-03.json), [production limits](../spikes/payments/README.md) |
| VAL-04 | M1 | Paid resource capability spike | In progress | SETUP-02 | [Live unsigned quotes](evidence/VAL-04-quotes.json), 13 control tests and [14 local settlement/recovery checks](evidence/VAL-04.json) passed. Useful paid output, isolation, trace export, and provider receipt remain pending |
| VAL-05 | M1 | Architecture and stack decision | Done | VAL-01, VAL-03, VAL-04 constraints (D012) | [Accepted architecture](ARCHITECTURE.md), D013: stack/process/data/auth/storage/isolation/hosting choices, alternatives, local run plan, and explicit open gates |

VAL-03/VAL-04 start with documentation and controlled environments. A later paid experiment needs its concrete wallet, amount, and funding authority established; this planning request does not provide those details.

The local execution baseline and observed provider constraints are sufficient for VAL-05 (D012). This sequencing decision does not close VAL-04 or waive the paid-resource, independent-review, alpha, or hackathon gates.

## Internal alpha

| ID | Work | State | Depends on | PRD coverage | Acceptance / evidence |
| --- | --- | --- | --- | --- | --- |
| ALPHA-01 | Application scaffold | Done | VAL-05 | System design | Verified clean install/build/start, safe local env/Compose, seven migration/worker checks, 18 desktop/mobile browser checks, CI configured; [evidence](evidence/ALPHA-01.json), [run guide](DEVELOPMENT.md) |
| ALPHA-02 | Roles, projects, builds, immutable terms | Done (foundation) | ALPHA-01 | FR01–FR03 | Invited sessions/role checks, authorized target/build records, append-only terms and edit conflicts verified; [evidence](evidence/ALPHA-02.json). Drafts only; exact claim binding/publication remain ALPHA-04 and execution/build verification ALPHA-05 (D016) |
| ALPHA-03 | Operator connection and qualification | Done (foundation) | ALPHA-02 | FR04–FR05 | Wallet control, seeded qualification, eligible work, versioned/scoped API, idempotent mutations verified in [ALPHA-03](ALPHA-03.md) and [evidence](evidence/ALPHA-03.json); claim mutations still require ALPHA-04 |
| ALPHA-04 | Ledger, claims, leases, cancellation | Done (foundation) | ALPHA-02 | FR03, FR06, FR14–FR15 | Exact terms/build binding per claim, database-enforced ceiling, concurrent claim cap, stale-attempt fencing and preserved obligations verified in [ALPHA-04](ALPHA-04.md) and [evidence](evidence/ALPHA-04.json); acceptance decisions and payouts remain ALPHA-06 and ALPHA-08 |
| ALPHA-05 | Runner isolation and evidence | Done (foundation) | VAL-01, ALPHA-03, ALPHA-04 | FR07–FR08 | Target/redirect/DNS/revision revalidation, lease-bound single-purpose run grants, schema/hash/size/time checks, verified redaction and private storage checked in [ALPHA-05](ALPHA-05.md) and [evidence](evidence/ALPHA-05.json); Trialoom does not host or sandbox the runner, so the gVisor host and an enforcing egress proxy remain open |
| ALPHA-06 | Findings, reproduction, decisions | Done (foundation) | ALPHA-05 | FR09, FR11–FR12 | Deterministic clustering with uncertain groupings sent to review, linked operators refused as reproduction, and immutable decisions carrying criteria, reason, evidence and actor verified in [ALPHA-06](ALPHA-06.md) and [evidence](evidence/ALPHA-06.json); no reproduction assignment, no rerouting, and no replay |
| ALPHA-07 | Repair workflow | Ready | VAL-02, ALPHA-06 | FR10–FR11 | Quote, pinned base, scoped patch, baseline/candidate checks, independent verification, builder review |
| ALPHA-08 | Payables, outbox, settlement | Ready | VAL-03, ALPHA-04, ALPHA-06 | FR13–FR14 | Atomic acceptance/payable/outbox; immutable payout identity/recipient; restart recovery; blocked/included/finalized states; fee treatment |
| ALPHA-09 | Resource adapter and accounting | Not started | VAL-04, ALPHA-04, ALPHA-05 | Resource integrations | Capped quotes, separate resource wallet, eligible actual costs, no double reimbursement, uncertainty reconciliation |
| ALPHA-10 | Core screens and exports | Not started | ALPHA-02 through ALPHA-08 | FR01, FR12, FR14, FR16 | Builder/operator/reviewer flows; evidence and payment exports; clear pending/blocked states |
| ALPHA-11 | End-to-end seeded campaign | Not started | ALPHA-07 through ALPHA-10 | Release scenarios | Repeatable test-to-payment loop with commands, artifacts, recovery results in [VALIDATION.md](VALIDATION.md) |

## Hackathon, pilot, and later

| ID | Milestone | Work | State | Depends on | Acceptance / evidence |
| --- | --- | --- | --- | --- | --- |
| HACK-01 | H | Event setup and track choice | Ready | SETUP-02 | Complete setup items in [HACKATHON.md](HACKATHON.md); resolve rule interpretation; record real entry identifiers |
| HACK-02 | H | Selected event integration requirements | Not started | HACK-01, VAL-03, VAL-04 | Verified implementation and references for selected checklist; no mock-derived proof |
| HACK-03 | H | Demo and submission evidence | Not started | HACK-02, ALPHA-11 | Usable demo, reproducible setup, meaningful real usage, sanitized evidence, limitations, final commit |
| PILOT-01 | M3 | Appeals, operations, privacy, security | Not started | ALPHA-11 | Appeals and reviewer coverage; retention/export controls; isolation/payment review; all release scenarios pass |
| PILOT-02 | M3 | Invited customer campaigns and measurement | Not started | PILOT-01 | Disclosed terms/caps; all PRD pilot metrics measured with denominators and real costs |
| BETA-01 | M4 | Public guarantees and scale | Deferred | PILOT-02 | Implemented guarantee model, reviewed contracts/providers, qualification and incident readiness |
| EXPAND-01 | M5 | Additional services and app creation | Deferred | Pilot demand evidence | Acceptance criteria and demonstrated demand per service |

Pilot completion requires every PRD requirement beyond its alpha slice. Manual operation in a demo is not an implicit waiver of the PRD.
