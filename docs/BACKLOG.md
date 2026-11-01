# Build backlog

Last updated: 2026-11-01. Source: [PRD](PRD.md). Milestones: [ROADMAP.md](ROADMAP.md).

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

## Public free beta — selected first release (D049)

The user selected public signup, free bounded testing and the Build with buy bounty. [FREE-BETA.md](FREE-BETA.md) defines acceptance and deferred marketplace scope.

| ID | Work | State | Depends on | Acceptance / evidence |
| --- | --- | --- | --- | --- |
| FREE-00 | Release scope and bounty requirements | Done | User decision | D049; fresh official event and free buy catalog review; no enrollment, purchase or deployment claimed |
| FREE-01 | Verified public signup and free workspace | In progress | FREE-00 | Email possession, atomic signup, workspace isolation, explicit free entitlement, paid/operator boundaries, desktop/mobile flow |
| FREE-02 | Bounded free test and automatic runner | Not started | FREE-01, RUN-03 | Quotas and global ceiling, authorized targets, automatic dispatch/recovery, observed output and replay, no customer liability |
| BUY-01 | Sponsored buy report explanation | In progress | FREE-00, RUN-02 | Exact catalog/quote; closed sanitized inputs; useful Cencori output; reserved platform cap, durable intent/reconciliation, Celo receipt; no customer reimbursement |
| FREE-03 | Hosted staging and launch operations | Not started | FREE-01, FREE-02 | HTTPS/app/worker/Postgres/private evidence; real mail/recovery; backup restore, roles, monitoring, retention and abuse controls |
| FREE-04 | Real-user release and submission | Not started | FREE-02, BUY-01, FREE-03, HACK-01 | Real signup-to-replay journey, useful paid output, demo/repo/identity and submission confirmation |

## Hands-on trial

| ID | Work | State | Depends on | Acceptance / evidence |
| --- | --- | --- | --- | --- |
| PRACTICE-01 | Prepared hands-on local walkthrough | Done | ALPHA-10 | Visible signed-in sample workspace, separate real invitation bug, persisted practice decision and redacted ZIP export, disposable data cleanup; [guide and checks](TRY-TRIALOOM.md). No hosted agent, independent human review, or live payment claimed. Commit `13245b7`; user reported the prepared test worked on 2026-10-31. This feedback does not close production release gates. |
| RUN-01 | Connect controlled browser execution to the workspace | Done | ALPHA-05, PILOT-03 | Actual Chromium journey and trace, build-bound HTTP uploads, fresh pending review/export, buggy and repaired results, expiry/cancellation/revocation/time-cap checks; [guide](RUN-01.md), [evidence](evidence/RUN-01.json). Controlled local fixture and administrative test setup only; no hosted or arbitrary-site execution, independent verification, trace replay UI, or payment. Commit subject: `feat: submit real Chromium evidence to the workspace` |
| RUN-02 | Recorded replay and sanitized browser trace | Done | RUN-01 | View replay on findings/evidence, first-issue step navigation, assertions and trace metadata, authenticated sanitized download/export with integrity checks, unsupported/archive refusal, desktop/mobile verification and real Playwright viewer compatibility; [guide](RUN-02.md), [evidence](evidence/RUN-02.json). No DOM/video playback or target re-execution. Sanitizer checkpoint `6ae7c4a`; UI commit subject: `feat: add recorded replay and sanitized trace downloads` |
| RUN-03 | Operated isolated browser runner for authorized previews | In progress | RUN-02, PILOT-03 | Local dispatch, live permissions, independent witness, bounded evidence and owned replay verified. External timer and four active stop checks pass. Blokaz homepage/scripts/approved Google Fonts load without budget exhaustion; additional backend/auth/RPC requests remain denied. Immutable dependency scope and replay verified. Exact API GET/exclusion policy and owned positive/negative controls pass. The approved live ladder now passes with visible/API count agreement and sanitized replay ([verified checkpoint](evidence/RUN-03-ladder-verified.json)). Buffered-response timing, original-pin DNS intersection and unavailable trace duration handling are verified. Durable per-run journals and fresh-process recovery now pass ten real crash cases with no duplicate delivery or released commitment ([checkpoint](evidence/RUN-03-recovery.json)). Adversarial resource checks are next; automatic dispatch and whole-host recovery remain open; [guide](RUN-03-INTEGRATION.md), [evidence](evidence/RUN-03-integration.json). |

## Internal alpha

| ID | Work | State | Depends on | PRD coverage | Acceptance / evidence |
| --- | --- | --- | --- | --- | --- |
| ALPHA-01 | Application scaffold | Done | VAL-05 | System design | Verified clean install/build/start, safe local env/Compose, seven migration/worker checks, 18 desktop/mobile browser checks, CI configured; [evidence](evidence/ALPHA-01.json), [run guide](DEVELOPMENT.md) |
| ALPHA-02 | Roles, projects, builds, immutable terms | Done (foundation) | ALPHA-01 | FR01–FR03 | Invited sessions/role checks, authorized target/build records, append-only terms and edit conflicts verified; [evidence](evidence/ALPHA-02.json). Drafts only; exact claim binding/publication remain ALPHA-04 and execution/build verification ALPHA-05 (D016) |
| ALPHA-03 | Operator connection and qualification | Done (foundation) | ALPHA-02 | FR04–FR05 | Wallet control, seeded qualification, eligible work, versioned/scoped API, idempotent mutations verified in [ALPHA-03](ALPHA-03.md) and [evidence](evidence/ALPHA-03.json); claim mutations still require ALPHA-04 |
| ALPHA-04 | Ledger, claims, leases, cancellation | Done (foundation) | ALPHA-02 | FR03, FR06, FR14–FR15 | Exact terms/build binding per claim, database-enforced ceiling, concurrent claim cap, stale-attempt fencing and preserved obligations verified in [ALPHA-04](ALPHA-04.md) and [evidence](evidence/ALPHA-04.json); acceptance decisions and payouts remain ALPHA-06 and ALPHA-08 |
| ALPHA-05 | Runner isolation and evidence | Done (foundation) | VAL-01, ALPHA-03, ALPHA-04 | FR07–FR08 | Target/redirect/DNS/revision revalidation, lease-bound single-purpose run grants, schema/hash/size/time checks, verified redaction and private storage checked in [ALPHA-05](ALPHA-05.md) and [evidence](evidence/ALPHA-05.json); Trialoom does not host or sandbox the runner, so the gVisor host and an enforcing egress proxy remain open |
| ALPHA-06 | Findings, reproduction, decisions | Done (foundation) | ALPHA-05 | FR09, FR11–FR12 | Deterministic clustering with uncertain groupings sent to review, linked operators refused as reproduction, and immutable decisions carrying criteria, reason, evidence and actor verified in [ALPHA-06](ALPHA-06.md) and [evidence](evidence/ALPHA-06.json); no reproduction assignment, no rerouting, and no replay |
| ALPHA-07 | Repair workflow | Done (foundation) | VAL-02, ALPHA-06 | FR10–FR11 | Owner-approved quote binding the published build and price, an author-first slot, a regression gate that refuses evidence rather than scoring it, independent verification carrying its own replays, and an execution decision that waits for that confirmation, verified in [ALPHA-07](ALPHA-07.md) and [evidence](evidence/ALPHA-07.json); no repository access is issued, nothing is re-executed, and no repair is merged or deployed |
| ALPHA-08 | Payables, outbox, settlement | Done (foundation) | VAL-03, ALPHA-04, ALPHA-06 | FR13–FR14 | Atomic acceptance/payable/outbox, immutable payout identity and recipient, restart recovery without a second transfer, separate blocked/included/finalized states and fee treatment verified in [ALPHA-08](ALPHA-08.md) and [evidence](evidence/ALPHA-08.json); no funded payment authority, so no transfer has happened |
| ALPHA-09 | Resource adapter and accounting | Done (foundation) | VAL-04, ALPHA-04, ALPHA-05 | Resource integrations | Capped purchases against a fresh quote, a platform resource account separate from the builder's allowance, reimbursement of the eligible actual cost exactly once, a platform-absorbed provisioning failure, and a commitment retained until an uncertain settlement is reconciled, verified in [ALPHA-09](ALPHA-09.md) and [evidence](evidence/ALPHA-09.json); no resource wallet is configured and the live buy adapter stays disabled, so nothing has been bought |
| ALPHA-10 | Core screens and exports | Done (foundation) | ALPHA-02 through ALPHA-09 | FR01, FR12, FR14, FR16 | A builder exports one brief as a zip holding the record, replay instructions and the redacted evidence with a recomputable hash, and a derived queue names every pending and blocked thing across a workspace for builders and reviewers alike, verified in [ALPHA-10](ALPHA-10.md) and [evidence](evidence/ALPHA-10.json); the information architecture is still panels rather than the PRD's distinct screens, there is no operator export, and escalation is visible but not actioned |
| ALPHA-11 | End-to-end seeded campaign | Done (foundation) | ALPHA-07 through ALPHA-10 | Release scenarios | `npm run loop` drives one seeded campaign from publication to an owed payable in 11 phases and 30 asserted steps, exercising R03, R06, R07, R11 and R12, writing its transcript and export to ignored `artifacts/loop/`, verified in [ALPHA-11](ALPHA-11.md) and [evidence](evidence/ALPHA-11.json) and recorded in [VALIDATION.md](VALIDATION.md); the evidence is harness-produced and the payment authority and resource provider are recording fixtures, so no value moved |

## Hackathon, pilot, and later

| ID | Milestone | Work | State | Depends on | Acceptance / evidence |
| --- | --- | --- | --- | --- | --- |
| HACK-01 | H | Event setup and track choice | In progress | SETUP-02 | Complete setup items in [HACKATHON.md](HACKATHON.md); resolve rule interpretation; record real entry identifiers |
| HACK-02 | H | Selected event integration requirements | In progress | HACK-01, BUY-01 | Verified implementation and references for selected checklist; no mock-derived proof |
| HACK-03 | H | Demo and submission evidence | Not started | HACK-02, ALPHA-11 | Usable demo, reproducible setup, meaningful real usage, sanitized evidence, limitations, final commit |
| PILOT-03 | M3 | Runner isolation and the egress witness | Done (foundation) | ALPHA-11 | A registered host under a written contract reports what its proxy allowed and denied under its own credential, the platform compares that with the agent's claim, and a witnessed run with no witness is refused, verified in [PILOT-03](PILOT-03.md) and [evidence](evidence/PILOT-03.json); Trialoom does not run the host, so the sandbox itself is still asserted |
| PILOT-04 | M3 | Pilot instrumentation and decision targets | Done (foundation) | ALPHA-11 | All thirteen instrumented events plus `review.opened` on an append-only closed-topic stream, and the eight PRD decision targets computed with their definitions, thresholds and inputs, verified in [PILOT-04](PILOT-04.md) and [evidence](evidence/PILOT-04.json); three targets report what is missing rather than a number, because their inputs do not exist |
| PILOT-05 | M3 | Funded payment authority and the shared approval | Done (foundation) | ALPHA-08, ALPHA-11 | One token approval is shared by every policy a wallet grants, so the approval itself is the accounted object: a table check refuses two briefs promising the same units, finality spends the approval instead of freeing it, and a reading below the commitments is reported without cancelling a debt. The live Remesso adapter moved USDC on a disposable Celo fork through the product's own path, verified in [PILOT-05](PILOT-05.md) and [evidence](evidence/PILOT-05.json); payout gas is read from each receipt and reported in the currency it was paid in, which closes one of the economics target's holes without making it measurable. No mainnet transaction and no funded wallet |
| PILOT-01 | M3 | Appeals, operations, privacy, security | Not started | ALPHA-11, PILOT-03, PILOT-04 | Appeals and reviewer coverage; retention/export controls; payment review; all release scenarios pass |
| PILOT-02 | M3 | Invited customer campaigns and measurement | Not started | PILOT-01 | Disclosed terms/caps; all PRD pilot metrics measured with denominators and real costs |
| BETA-01 | M4 | Public guarantees and scale | Deferred | PILOT-02 | Implemented guarantee model, reviewed contracts/providers, qualification and incident readiness |
| EXPAND-01 | M5 | Additional services and app creation | Deferred | Pilot demand evidence | Acceptance criteria and demonstrated demand per service |

Later paid marketplace pilot completion requires every PRD requirement beyond its alpha slice. The free beta follows D049 and FREE-BETA.md. Manual operation in a demo is not an implicit waiver of the PRD.
