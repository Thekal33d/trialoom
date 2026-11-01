# Delivery roadmap

Last updated: 2026-11-01. Baseline: [PRD v0.1](PRD.md). Live task state: [BACKLOG.md](BACKLOG.md).

D049 changes the first release to a **public-signup free testing beta**, with useful platform-sponsored usebuy calls for the selected Build with buy track. [Free beta scope](FREE-BETA.md) defines the launch path. The paid marketplace remains a later objective; a demo does not establish release readiness.

| Milestone | Deliverable | Exit evidence | State |
| --- | --- | --- | --- |
| M0 — Project foundation | PRD, persistent memory, incremental commits, roadmap, backlog, hackathon notes | Linked documents and checkpoint commits | Complete |
| M1 — Capability validation | Seeded browser journey, reproducible defect, regression fix, payment recovery experiment, resource evaluation | Replay/export artifacts, baseline/candidate results, recovery outcomes, stack decision | In progress: VAL-01/VAL-03 complete locally; VAL-02 independent review and VAL-04 resource proof pending |
| M2 — Internal alpha | Projects/builds, versioned terms, operator API, bounded claims, evidence review, ledger, provider adapters | Repeatable seeded campaign through settlement; concurrency and restart checks pass | ALPHA-01–ALPHA-11 complete locally as foundations. RUN-01 connects actual controlled Chromium execution to HTTP evidence ingestion; RUN-02 adds recorded replay and metadata-only trace downloads/exports. RUN-03 now verifies local gVisor/proxy dispatch through live permissions, witness/evidence delivery and owned replay. Blokaz homepage/scripts/approved fonts have loaded. The approved live ladder journey now passes with visible/API count agreement and a sanitized replay; auth/RPC stay blocked and untested. Controller-process recovery is verified with durable journals and ten real crash cases; FREE-02 adds automatic free-test dispatch; whole-host recovery and adversarial resource gates remain open. Production runner isolation, PILOT-01 operations/privacy/security, real participants, and funded pilot work remain open. |
| F — Public free testing beta | Verified signup, bounded sponsored testing, evidence/replay, hosted operations | FREE-01–FREE-04 and BUY-01; one genuine external user journey | In progress: verified signup and local automatic free-test/replay path implemented; sponsored purchases, runner release checks and hosting remain open |
| H — Hackathon demonstration | Usable slice of M1/M2 with selected event requirements | [Hackathon checklist](HACKATHON.md) and verified demo evidence | In progress: Build with buy selected; enrollment and paid output pending |
| M3 — Later paid invited pilot | Three launch services, reviewer coverage, appeals, caps, exports, retention, real customers | All PRD release scenarios pass; controls and measured metrics support launch | Not started |
| M4 — Public paid marketplace | Stronger funding guarantees, scaled qualification, hardened operations | Implemented funding mechanism and security/provider reviews support public promises | Deferred |
| M5 — Expansion | API integrations, release checks, docs validation, recurring work, eventual project creation | Measurable acceptance criteria and demonstrated demand per service | Deferred |

## Later marketplace demonstration

Use the PRD's invitation example as a controlled fixture:

1. A builder approves a signup/invitation journey, pinned build, fixture, and bounded budget.
2. A testing operator claims work and supplies a browser trace demonstrating the plus-address invitation defect.
3. A different operator reproduces it in clean sessions; review accepts the finding under published terms.
4. A separately quoted repair produces a reviewable patch and regression test.
5. An independent verifier shows that test failing on the baseline and passing on the candidate, with required existing checks passing.
6. Accepted assignments create distinct payables. Settlement reports inclusion/finality separately and survives a replayed event without paying twice.
7. The builder exports the reproduction, patch, regression results, and payment records. A validated resource purchase supports this actual journey when included; the free beta has its own narrower demonstration in FREE-BETA.md.

The fixture proves mechanics. A genuine customer case is a separate milestone; controlled demo participants must never be described as independent marketplace traction.

## Scope discipline

For the later marketplace, build the screens needed for its loop: project/campaign setup, assignment activity, evidence/repair review, operator work, and payments. Keep resource and settlement providers behind separate adapters. Work records must remain usable during provider outages.

If time runs short, reduce catalog breadth, automation, and decorative UI. Preserve budget controls, operator independence, evidence integrity, payment recovery, and honest state labels. Incomplete evidence stays visibly incomplete.

No engineering calendar is committed until M1 establishes feasibility. The external deadline in [HACKATHON.md](HACKATHON.md) does not waive product release gates.
