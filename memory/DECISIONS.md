# Decision register

Last updated: 2026-10-27.

Statuses: **Accepted** (user instruction or explicit working decision), **Proposed** (candidate), **Open** (unresolved), **Superseded** (retained with replacement reference).

| ID | Date | Status | Decision and rationale | Revisit when |
| --- | --- | --- | --- | --- |
| D001 | 2026-10-26 | Accepted | Store durable context in `memory/`; use root `AGENTS.md` and `CLAUDE.md` as entry points. This fulfills the user's request across coding sessions. | The workflow stops being useful |
| D002 | 2026-10-26 | Accepted | Make a local commit after each coherent completed step, including relevant tracking updates and verification. User requested incremental commits. | User changes the preference |
| D003 | 2026-10-26 | Accepted | Preserve the supplied PRD v0.1 verbatim as the initial product baseline; label its untested provider and pilot assumptions. | A requirement is explicitly revised |
| D004 | 2026-10-26 | Accepted | Prioritize a complete test/reproduce/repair/verify/pay loop for existing web apps and an invited operator pool, following the PRD. | Capability validation reveals an infeasible dependency |
| D005 | 2026-10-26 | Proposed | Use Remesso for USDC-on-Celo operator payouts, with separate buy resource purchasing. This is the PRD direction, subject to integration evidence. | Payment and resource spikes complete |
| D006 | 2026-10-26 | Superseded | Choose language, web/API framework, database, job queue, auth, artifact storage, and deployment platform. Resolved by D013. | See D013 |
| D007 | 2026-10-26 | Proposed | Target Build with buy for the hackathon; require a useful resource integration for that demonstration while keeping it optional for the general product. See [research and scope](../docs/HACKATHON.md). | Track confirmation and resource validation |
| D008 | 2026-10-26 | Accepted | Follow the PRD's capability-first sequence. Prove execution, evidence, repair, payment recovery, and resource behavior before claiming an operational marketplace. | Evidence justifies a documented sequence change |
| D009 | 2026-10-26 | Accepted | Use Node 24, pinned Playwright Test/Chromium, and fflate for the disposable capability harness. Text-only traces, explicit synthetic-canary redaction, and content hashes make the experiment inspectable. This does not select the marketplace stack or establish a production security boundary. | VAL-05 architecture decision |
| D010 | 2026-10-26 | Accepted | Use pinned Remesso SDK 0.3.0 policy funding for the local USDC payout experiment. Preserve accepted payables outside the SDK journal, reconcile stable keys, and treat inclusion separately from finality. File stores are sequential spike tooling; production needs shared journals and signer coordination. [Evidence and limits](../spikes/payments/README.md). | Production adapter implementation and review |
| D011 | 2026-10-26 | Accepted | Pin buy-core 0.8.4 for the resource spike. Require successful funding reads, explicit token/provider terms, durable reservation/public nonce before dispatch, and chain reconciliation after any uncertain response. Keep paid transport simulation-only until real provisioning/output is verified. [Evidence and limits](../spikes/resources/README.md). | Funded resource experiment and production adapter |
| D012 | 2026-10-26 | Accepted | Proceed to VAL-05 architecture selection using the local execution baseline and now-observed provider constraints. Waiting for paid buy output is unnecessary for selecting the ledger/outbox/runtime; keeping buy optional and disabled contains this open dependency. VAL-04, independent verification, and hackathon readiness remain unfulfilled gates. | Before enabling live resource purchases or closing M1 |
| D013 | 2026-10-27 | Accepted | Select Node 24/TypeScript, Next.js App Router/React, PostgreSQL with explicit SQL and a transactional outbox, separate Node workers, Better Auth database sessions, private S3 artifacts, Render containers, and a separate gVisor runner boundary. Keep ALPHA-01 fixture-only. [Architecture, alternatives, and gates](../docs/ARCHITECTURE.md). | Capability, scale, or deployment evidence contradicts a choice |
| D014 | 2026-10-27 | Proposed | Use a calm, precise light workspace with forest green and muted olive, locally bundled Manrope/DM Sans, and evidence-led layouts. Implemented as a reversible default while the visual preference question is unanswered; not a confirmed user preference. [Design context](../.impeccable.md). | User provides visual direction |
| D015 | 2026-10-27 | Accepted | Implement the first accounts with Better Auth password sessions and one-time owner-issued invitations. Keep public signup disabled; local CLI bootstraps the first owner and saves the link privately. This exercises real access control without an unconfigured email/OAuth provider. Membership is checked transactionally and reviewer access is logged. Email ownership verification, delivery, recovery, and production perimeter controls remain separate gates. [Boundaries](../docs/ALPHA-02.md). | Pilot onboarding and production identity review |
| D016 | 2026-10-27 | Accepted | Make target approvals, pinned builds, and term versions immutable records. Require optimistic version checks plus a campaign row lock for edits. ALPHA-02 exposes draft briefs only; ALPHA-04 must pin exact terms/build IDs when creating claims and reserving liability. This preserves the intended dependency order without creating unfunded offers. Target admission records permission and public DNS, while ALPHA-05 must verify execution/build/egress boundaries. Full FR02/FR03 and R05 remain integration gates. [Design](../docs/ALPHA-02.md). | Claims, publication, and runner implementation |

| D017 | 2026-10-27 | Accepted | Make operator identity platform-level and bound to one authenticated account, and let a builder admit an operator through the existing workspace `operator` membership. Prove wallet control with server-built EIP-4361 messages verified against externally owned accounts only, on Celo 42220, with single-use nonces; store the message and a signature digest, never a reusable signature. Issue scoped, expiring, revocable agent credentials whose allowlist contains no claim or payment scope, and make agent mutations idempotent per operator. Grade seeded qualification server-side and derive eligibility from immutable attempts. Contract accounts, appeals, qualification resets, and claim or payout authority stay out of this step. [Design and limits](../docs/ALPHA-03.md). | Contract-account payouts, independent-operator review, or claim implementation |

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
