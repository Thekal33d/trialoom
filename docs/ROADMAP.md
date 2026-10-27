# Delivery roadmap

Last updated: 2026-10-27. Baseline: [PRD v0.1](PRD.md). Live task state: [BACKLOG.md](BACKLOG.md).

The product target is an invited marketplace. The hackathon target is a demonstrable slice of the same product. A successful demo does not establish pilot readiness.

| Milestone | Deliverable | Exit evidence | State |
| --- | --- | --- | --- |
| M0 — Project foundation | PRD, persistent memory, incremental commits, roadmap, backlog, hackathon notes | Linked documents and checkpoint commits | Complete |
| M1 — Capability validation | Seeded browser journey, reproducible defect, regression fix, payment recovery experiment, resource evaluation | Replay/export artifacts, baseline/candidate results, recovery outcomes, stack decision | In progress: VAL-01/VAL-03 complete locally; VAL-02 independent review and VAL-04 resource proof pending |
| M2 — Internal alpha | Projects/builds, versioned terms, operator API, bounded claims, evidence review, ledger, provider adapters | Repeatable seeded campaign through settlement; concurrency and restart checks pass | In progress: ALPHA-01 to ALPHA-04 verified locally; invited sessions, roles, project/build records, versioned terms, operator connection and qualification, and the campaign ledger with atomic claims and leases are implemented; execution, evidence, decisions, and settlement pending |
| H — Hackathon demonstration | Usable slice of M1/M2 with selected event requirements | [Hackathon checklist](HACKATHON.md) and verified demo evidence | Not started; track proposed |
| M3 — Invited pilot | Three launch services, reviewer coverage, appeals, caps, exports, retention, real customers | All PRD release scenarios pass; controls and measured metrics support launch | Not started |
| M4 — Public beta | Stronger funding guarantees, scaled qualification, hardened operations | Implemented funding mechanism and security/provider reviews support public promises | Deferred |
| M5 — Expansion | API integrations, release checks, docs validation, recurring work, eventual project creation | Measurable acceptance criteria and demonstrated demand per service | Deferred |

## First working demonstration

Use the PRD's invitation example as a controlled fixture:

1. A builder approves a signup/invitation journey, pinned build, fixture, and bounded budget.
2. A testing operator claims work and supplies a browser trace demonstrating the plus-address invitation defect.
3. A different operator reproduces it in clean sessions; review accepts the finding under published terms.
4. A separately quoted repair produces a reviewable patch and regression test.
5. An independent verifier shows that test failing on the baseline and passing on the candidate, with required existing checks passing.
6. Accepted assignments create distinct payables. Settlement reports inclusion/finality separately and survives a replayed event without paying twice.
7. The builder exports the reproduction, patch, regression results, and payment records. If the proposed buy track is selected, a validated resource purchase supports this actual journey.

The fixture proves mechanics. A genuine customer case is a separate milestone; controlled demo participants must never be described as independent marketplace traction.

## Scope discipline

Build the screens needed for this loop first: project/campaign setup, assignment activity, evidence/repair review, operator work, and payments. Keep resource and settlement providers behind separate adapters. Work records must remain usable during provider outages.

If time runs short, reduce catalog breadth, automation, and decorative UI. Preserve budget controls, operator independence, evidence integrity, payment recovery, and honest state labels. Incomplete evidence stays visibly incomplete.

No engineering calendar is committed until M1 establishes feasibility. The external deadline in [HACKATHON.md](HACKATHON.md) does not waive product release gates.
