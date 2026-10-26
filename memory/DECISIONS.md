# Decision register

Last updated: 2026-10-26.

Statuses: **Accepted** (user instruction or explicit working decision), **Proposed** (candidate), **Open** (unresolved), **Superseded** (retained with replacement reference).

| ID | Date | Status | Decision and rationale | Revisit when |
| --- | --- | --- | --- | --- |
| D001 | 2026-10-26 | Accepted | Store durable context in `memory/`; use root `AGENTS.md` and `CLAUDE.md` as entry points. This fulfills the user's request across coding sessions. | The workflow stops being useful |
| D002 | 2026-10-26 | Accepted | Make a local commit after each coherent completed step, including relevant tracking updates and verification. User requested incremental commits. | User changes the preference |
| D003 | 2026-10-26 | Accepted | Preserve the supplied PRD v0.1 verbatim as the initial product baseline; label its untested provider and pilot assumptions. | A requirement is explicitly revised |
| D004 | 2026-10-26 | Accepted | Prioritize a complete test/reproduce/repair/verify/pay loop for existing web apps and an invited operator pool, following the PRD. | Capability validation reveals an infeasible dependency |
| D005 | 2026-10-26 | Proposed | Use Remesso for USDC-on-Celo operator payouts, with separate buy resource purchasing. This is the PRD direction, subject to integration evidence. | Payment and resource spikes complete |
| D006 | 2026-10-26 | Open | Choose language, web/API framework, database, job queue, auth, artifact storage, and deployment platform. | Before the application scaffold |
| D007 | 2026-10-26 | Proposed | Target Build with buy for the hackathon; require a useful resource integration for that demonstration while keeping it optional for the general product. See [research and scope](../docs/HACKATHON.md). | Track confirmation and resource validation |
| D008 | 2026-10-26 | Accepted | Follow the PRD's capability-first sequence. Prove execution, evidence, repair, payment recovery, and resource behavior before claiming an operational marketplace. | Evidence justifies a documented sequence change |
| D009 | 2026-10-26 | Accepted | Use Node 24, pinned Playwright Test/Chromium, and fflate for the disposable capability harness. Text-only traces, explicit synthetic-canary redaction, and content hashes make the experiment inspectable. This does not select the marketplace stack or establish a production security boundary. | VAL-05 architecture decision |

## Open product decisions from the PRD

| Decision | Current direction | Required by |
| --- | --- | --- |
| Funding promise | Invited pilot with disclosed authorized-spending model; no secured public rewards yet | Pilot terms |
| Token and contracts | USDC on Celo; verify exact deployment and SDK support | Payment validation |
| Execution access | Scoped fixtures, short-lived credentials, branch-limited repair access | Runner design |
| Resource provider | Validate local/hosted baseline and buy separately | Capability validation |
| Pricing and gas | Operator quotes, published rewards, proposed 10% fee; platform covers payout gas | First paid offer |
| Reviewer coverage | Named platform reviewer for every active pilot campaign | Pilot onboarding |
| Artifact rights | Disclosed rights for builders to retain/reuse purchased work | First paid assignment |
| Brand | Trialoom is a working name; clearance pending | Public launch |

For a material new decision, record its context, considered alternatives, chosen option, consequences, and validating evidence below the table or in a linked document. Do not erase superseded decisions.
