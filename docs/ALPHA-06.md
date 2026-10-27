# Findings, reproduction, and decisions

Verified locally on 2026-10-27. This is the ALPHA-06 foundation for FR09, FR11, and FR12. It closes release scenario R02's decision half and R11's detection, and narrows R03 to one named gap. Payouts are ALPHA-08 and repairs ALPHA-07. [Evidence](evidence/ALPHA-06.json) records checks and exact source hashes.

## Clustering decides nothing

A submission reporting a product failure becomes a **finding** with a failure signature: the failing assertion names and the failing steps' action, expected and actual, each normalized, against the pinned build. Clustering then compares it with what the project already knows about that build:

| Result | What the platform does |
| --- | --- |
| Same signature | Joins the existing defect; `match` is `exact` |
| Same failing assertions, different detail | Attaches to nothing, records the candidates, flags them `uncertain_duplicate` for review |
| Neither | Opens a new defect; `match` is `first` |

That is the whole of the automation. Grouping an uncertain report, awarding a reward, refusing one, or setting a severity is a **recorded decision by a person**: the `decisions` table requires an `actor_id` referencing a real account and a role of `owner`, `reviewer` or `operator`, so no model, agent credential or wallet signature can post one. A defect is keyed by project, build and signature, so the same failure reported under a second campaign on the same build is the same defect.

## Reproduction is independence

The PRD's two consistent replays are two **independent operators** reporting the same failure. Trialoom re-executes nothing: each report is its own operator's run under ALPHA-05, with its own evidence and its own target recheck.

Two operators are linked when they are the same identity, belong to the same account, or have ever proven the same payout wallet — including a wallet one revoked before the other proved it, which is exactly the linked-agent case in R11. A linked report is still recorded, but it cannot count as independent reproduction: the defect stays `unconfirmed` and is flagged `independence_failed` for a reviewer. Two independent reports confirm it.

A clean run of the same assertions on the same build contradicts a reported failure. That marks the defect `flaky` and flags `inconsistent_result`; it is **not** treated as proof that the first report was false.

## Decisions carry their reasons

Every decision row is immutable and holds the matter, the outcome, the criteria applied, the reason, the evidence references, the actor and their role. The criteria are copied from the terms version the claim pinned, not from today's revision, and a referenced artifact, submission or finding must belong to that assignment. The decision is written **before** any money moves, so a second decision on a settled matter is refused by its unique index rather than half-applied.

| Matter | Outcomes | Money |
| --- | --- | --- |
| `execution` | accepted, rejected | Up to the published execution price |
| `discovery` | awarded, declined | Up to the published discovery cap |
| `duplicate` | duplicate | None |
| `severity` | changed | None |
| `appeal` | opened, upheld, overturned | An overturned refusal pays up to the same cap |

## Money, and what independence means for it

Execution and discovery are decided separately, so valid execution is payable whatever happens to the discovery question (R02). The platform fee is charged on the **running payout total** rather than on each award: two separate acceptances of 1 base unit each at 1 bps would otherwise round to two fee units against the single unit the claim reserved. One defect earns one discovery reward, to its earliest complete report; a later report of the same defect is refused the reward and still paid for its execution (R03).

A refusal keeps its reservation for the seven-day appeal window, because a refused amount that has already been released cannot be paid if the appeal succeeds. An operator opens an appeal from their own agent session with the new `appeals:submit` scope, which clears the release schedule entirely; a reviewer resolves it, and an overturned refusal pays while the original decision stays on the record beside its correction. The worker releases what a settled assignment no longer holds once that window closes.

Accepted amounts are now **owed and unpaid**. Nothing in this step transfers anything.

## What remains

- **No reproduction assignment.** Reproduction emerges when a second independent operator happens to report the same failure. A builder cannot commission one, and the PRD's explicitly assigned reproduction fee does not exist, so R03's second half is unimplemented.
- **No rerouting.** R11's linked report is detected, refused as reproduction, and flagged for a reviewer; the platform does not route the job to a different operator.
- **No replay.** Trialoom does not re-execute a trace or verify a claim against one; it compares reports.
- The published severity rubric is prose, and the platform does not check a recorded severity against it. A reviewer applies it.
- No builder-silence escalation, no dispute state beyond an appeal, and no retention or deletion of decided evidence. The `out_of_scope` and `disputed` states exist in the schema for later work and no decision sets them.
- Resource accounting (ALPHA-09) is untouched. Repairs ([ALPHA-07](ALPHA-07.md)) and payouts ([ALPHA-08](ALPHA-08.md)) have since been built on this step: FR11's rule that a repair author cannot verify their own repair reuses the same independence check, and an accepted decision now writes its payable.
