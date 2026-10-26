# Core project memory

Last updated: 2026-10-26.

## Identity and purpose

- Working name: **Trialoom**. Tagline: **Test. Fix. Ship.**
- Builders purchase useful testing and repairs; independently operated agents earn for accepted work supported by replayable evidence.
- First customer: solo builders and small teams with existing web applications and authorized preview environments.
- First release: an invited marketplace with **Test my product**, **Find reproducible bugs**, and **Fix this bug**. Reproduction and verification are paid assignments within these services.
- First milestone: one real project completes **test → reproduce → fix → independently verify → pay**.
- Differentiation hypothesis: a connected evidence-to-repair workflow with reusable regression tests and traceable settlement. Additional value over existing checks must be measured.

## User's standing preferences

- Maintain persistent Markdown project memory so work survives new sessions and context resets.
- Track progress, status, decisions, and remaining work throughout development.
- Commit every meaningful completed step as the build progresses.
- Keep the Celo agentic hackathon at the supplied [Loops House arena](https://www.loops.house/builder-arena) in mind.
- Local timezone: Africa/Lagos.

## Product boundaries

Start with Chromium and recorded desktop/mobile viewports, not claims of real-device coverage. Repository access is needed for repair work, not basic preview testing. Builders retain merge and deployment control. General app generation, native mobile testing, unrestricted load/security testing, anonymous public enrollment, cross-chain settlement, and expansion services are outside the initial release.

The system needs a transactional relational ledger, private evidence storage, isolated runners, and durable job/payment recovery. Specific language, framework, database, queue, hosting, and authentication products are not yet chosen.

The disposable browser/evidence experiment uses Node 24 and Playwright Test (D009). This local harness is separate from the eventual marketplace architecture.

## Money and trust

- PRD direction: USDC on Celo, with Remesso for approved operator payments and a separate optional buy resource adapter. Remesso policy payments and crash recovery are proven on a disposable local Celo fork (VAL-03); production integration and paid buy output remain pending.
- A builder policy authorizes spending; it does not escrow or reserve funds. Campaign reservations live in Trialoom's ledger. Public secured-payment promises need a separate funding design.
- Finalized charges + unpaid liabilities + outstanding maximum commitments must stay within the campaign ceiling. Resources and platform fees participate in this invariant.
- Accepted work remains owed after insufficient funds, policy revocation, or cancellation. Payment retries reconcile the same operation identity.
- Work quality requires evidence and independent checks. Wallet signatures and agent identities provide attribution, not proof of correctness or independent ownership.
- Raw evidence is private by default and must be redacted before sharing.

## Planning assumptions

The proposed 10% fee, recruitment targets of five builders and ten operators, twenty paid campaigns, review deadlines, claim leases, and performance targets are pilot hypotheses from the PRD. They are not observed traction, settled commercial terms, or tested service levels.

Hackathon research, proposed track, and source-dated checklist live in [docs/HACKATHON.md](../docs/HACKATHON.md). Track-specific requirements do not silently change product scope. The [roadmap](../docs/ROADMAP.md) separates demo, pilot, and public-release gates; the [backlog](../docs/BACKLOG.md) holds tasks and dependencies.

## Source provenance

[docs/PRD.md](../docs/PRD.md) is the unmodified user attachment: PRD v0.1, dated 2026-10-26.

Original SHA-256: `c8f2ee691f7c0b111836999c96e33b8effe13b649a9e0cbbbf8e7a7566e1590d`.

External assertions inside that PRD still need integration-time verification. Record later evidence and changed requirements rather than silently converting assumptions into facts.
