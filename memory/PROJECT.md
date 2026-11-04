# Core project memory

Last updated: 2026-11-04.

## Identity and purpose

- Working name: **Trialoom**. Tagline: **Test. Fix. Ship.**
- Builders purchase useful testing and repairs; independently operated agents earn for accepted work supported by replayable evidence.
- First customer: solo builders and small teams with existing web applications and authorized preview environments.
- First release (user-selected 2026-11-01, D049): public signup and free, bounded browser testing with findings and replay. No customer wallet, deposit, payment authority or paid operator assignment is required. Platform-sponsored usebuy purchases support useful testing results within an explicitly funded cap.
- First release milestone: a real user signs up, authorizes a preview, receives a bounded real browser test and replay, and benefits from a useful usebuy service with verifiable Celo mainnet payment evidence. The later marketplace milestone remains **test → reproduce → fix → independently verify → pay**.
- Differentiation hypothesis: a connected evidence-to-repair workflow with reusable regression tests and traceable settlement. Additional value over existing checks must be measured.

## User's standing preferences

- Maintain persistent Markdown project memory so work survives new sessions and context resets.
- Track progress, status, decisions, and remaining work throughout development.
- Commit every meaningful completed step as the build progresses.
- Target the Celo Agents on Open Rails **Build with buy** bounty. The build log records enrollment on 2026-11-02, entry creation and ERC-8004 identity 10031 on 2026-11-03. Useful paid-service output, the entry demo URL and final submission evidence remain work to complete.
- The user purchased `trialoom.xyz` on 2026-11-04. **https://trialoom.xyz is the live public origin**, with verified DNS/ownership, valid HTTPS, HTTP-to-HTTPS redirect and `BETTER_AUTH_URL` switched after a successful Railway redeployment. Landing page, sample workspace and anonymous authentication checks pass. The generated Railway HTTPS address remains attached. Keep origin and sending domain configurable; connecting the domain does not verify a mail sender or enable public signup/hosted testing.
- GitLab is the current code remote: `https://gitlab.com/Otaiki1/trialoom.git`. User reported GitHub is unavailable on 2026-11-01. Development can continue on GitLab; the hackathon's public GitHub requirement needs restored access or an organizer-confirmed alternative.
- Local timezone: Africa/Lagos.

## Product boundaries

Start with Chromium and recorded desktop/mobile viewports, not claims of real-device coverage. Public builder registration requires verified email and usage limits; anonymous execution and unrestricted public operator enrollment remain excluded. Repository access and paid repair work are deferred from this free beta. Builders retain merge and deployment control. General app generation, native mobile testing, unrestricted load/security testing, cross-chain settlement, and expansion services remain outside the initial release.

The selected alpha architecture is Node 24/TypeScript, Next.js/React, PostgreSQL with explicit SQL and an outbox, and separate Node workers. Better Auth database sessions, private S3 evidence and a separate gVisor runner host are selected targets; Railway supersedes the original Render choice for the web process, worker and PostgreSQL (D057), with implementation gates recorded in [ARCHITECTURE.md](../docs/ARCHITECTURE.md). The scaffold must not expose customer records or money actions before authorization/ledger controls exist.

A verified local application now exists: `/sign-up` provides configuration-gated email-verified public registration and a free workspace with three-project capacity; real email delivery and hosted execution remain unconfigured. `/workspace` also retains the existing invited Better Auth sessions and workspace roles, with persisted authorized projects, pinned builds, and immutable draft terms. `/demo` stays separate with labelled fixture data; dedicated workers manage queued application work with payments disabled when unconfigured. Invitations are delivered privately without email, and no endpoint moves money. Operators register a platform-level identity at `/operator`, prove wallet control with server-built EIP-4361 messages for externally owned accounts on Celo 42220, hold scoped revocable agent credentials with no claim or payment scope, and earn per-service eligibility from graded seeded tasks; the bearer-only agent API at `/api/agent/v1` is idempotent per operator. A builder publishes one exact terms version against an authorized ceiling; the campaign account row carries the ceiling invariant as a database check and is the single lock point for every reservation. A claim pins its terms version and build, reserves the whole maximum liability, and holds a renewable lease fenced by an attempt token. A run is issued only after Trialoom rechecks the pinned target's DNS, redirects and exposed revision, and carries one short-lived grant that expires with the lease and can only submit evidence for that run; ingestion checks the pinned identities, the issued limits and the attested isolation, keeps raw artifacts in a private store, and serves only a verified redacted copy. A reported failure becomes a finding clustered deterministically by signature, build and project; an operator linked by identity, account or any wallet either has proven cannot reproduce it independently; and every acceptance, refusal, grouping, severity change and appeal is an immutable decision carrying the pinned criteria, the reason, the evidence and a responsible person. An acceptance writes its payables and queues them in the same transaction, each with an immutable payout identity that a retry reconciles rather than replaces, and only verified finality moves the ledger. RUN-03 now operates a local gVisor browser/proxy through the application; no hosted production runner or funded payment authority is configured. Payouts remain blocked without authority; the separate fork experiment is not a mainnet payment. See [ALPHA-02](../docs/ALPHA-02.md), [ALPHA-03](../docs/ALPHA-03.md), [ALPHA-04](../docs/ALPHA-04.md), [ALPHA-05](../docs/ALPHA-05.md), [ALPHA-06](../docs/ALPHA-06.md), [ALPHA-08](../docs/ALPHA-08.md), and [DEVELOPMENT.md](../docs/DEVELOPMENT.md). The reversible visual default is recorded in [.impeccable.md](../.impeccable.md); user visual preference remains unconfirmed.

RUN-01 adds a fixed, controlled Chromium driver connected to actual evidence HTTP ingestion and the workspace. `npm run browser:demo` runs an owned loopback invitation fixture in a disposable database and opens fresh pending evidence. The browser has a separate context and filtered environment; the trusted controller and driver still share a Node process. This does not operate a customer sandbox or enable arbitrary targets. Raw traces remain private. RUN-02 adds recorded step replay and metadata-only Playwright v10 derivatives for review/download/export, omitting page contents and free-form trace values; unsupported archives stay private. This does not re-execute a test or establish independent verification. [Execution](../docs/RUN-01.md), [replay policy and checks](../docs/RUN-02.md).

RUN-03 provides a local trusted controller for fixed read-only journeys, an isolated gVisor Chromium process, a separate HTTPS proxy, live run/host checks, immutable witness receipts and bounded evidence delivery. Both application credentials remain outside the browser/proxy; a host-owned timer enforces an independent deadline. Versioned terms support whole-origin read-only resources, exact credential-free API GETs and declared services that must remain blocked/untested. Unexpected traffic still blocks a result. CORS forwarding preserves only the browser’s Origin matching the primary manifest target; it does not admit additional origins or credentials. The owned sample and authorized Blokaz homepage/ladder journey have reached the actual replay workflow, including visible/API count agreement; blocked requests and unavailable timings remain visible without exposing page contents. The local controller now records durable dispatch intent and private capture hashes, then reconciles existing delivery after process death without redispatching an uncertain run or releasing its commitment. Local checks use disposable databases; paid-assignment scheduling, whole-host recovery and adversarial resource gates remain separate. See [the integration guide](../docs/RUN-03-INTEGRATION.md) and [current status](STATUS.md).

FREE-02 adds a separate, zero-liability free-test queue and automatic local worker, with atomic account/global/target limits, explicit origin enablement, cancellation and durable capture/recovery. It reuses the isolated browser and proxy, stores only sanitized checks/replay metadata, and never creates a paid campaign or assignment. The owned sample exercises verified signup through actual browser replay. Whole-host/resource checks and hosted operations still gate public execution; platform-sponsored usebuy accounting remains separate. [Free execution guide](../docs/FREE-02.md).

BUY-01 now binds terminal free-test results to immutable local report inputs. The worker preserves recorded boolean checks, verifies the source hash and skips all-passing checks without a provider request. Preparation is recoverable and has no spending side effect. The sponsored purchase journal, x402 client and explanation UI have since been implemented (D054–D055); useful live paid output remains unverified. [Report guide](../docs/BUY-01.md).

The disposable browser/evidence experiment uses Node 24 and Playwright Test (D009). This local harness is separate from the eventual marketplace architecture.

The public landing page and example workspace are live at `https://web-production-0928b.up.railway.app`. Railway hosts web, the general worker and PostgreSQL; hosted isolated execution remains a separate Linux-host dependency. Public signup and sponsored purchases are disabled in this deployment. On 2026-11-04, live health/readiness and all three Railway service statuses were reverified. The deploy uses a source upload, so local commits can be live without being pushed to GitLab. [Current status](STATUS.md).

## Money and trust

- PRD marketplace direction: USDC on Celo with Remesso operator payments and a separate buy resource adapter. D049 defers customer/operator settlement from the free beta and makes useful platform-sponsored buy integration a selected hackathon dependency. Sponsored costs must never become customer reimbursement payables. Existing debts remain owed. Local fork proofs do not establish useful paid mainnet service delivery.
- A builder policy authorizes spending; it does not escrow or reserve funds. Campaign reservations live in Trialoom's ledger. Public secured-payment promises need a separate funding design.
- Finalized charges + unpaid liabilities + outstanding maximum commitments must stay within the campaign ceiling. Resources and platform fees participate in this invariant.
- Accepted work remains owed after insufficient funds, policy revocation, or cancellation. Payment retries reconcile the same operation identity.
- Work quality requires evidence and independent checks. Wallet signatures and agent identities provide attribution, not proof of correctness or independent ownership.
- Raw evidence is private by default and must be redacted before sharing. A redacted copy is only shareable once a rescan of it comes back clean; evidence a policy cannot clean stays private.

## Planning assumptions

The proposed 10% fee, recruitment targets of five builders and ten operators, twenty paid campaigns, review deadlines, claim leases, and performance targets are pilot hypotheses from the PRD. They are not observed traction, settled commercial terms, or tested service levels.

Hackathon research, proposed track, and source-dated checklist live in [docs/HACKATHON.md](../docs/HACKATHON.md). Track-specific requirements do not silently change product scope. The [roadmap](../docs/ROADMAP.md) separates demo, pilot, and public-release gates; the [backlog](../docs/BACKLOG.md) holds tasks and dependencies.

## Source provenance

[docs/PRD.md](../docs/PRD.md) is the unmodified user attachment: PRD v0.1, dated 2026-10-26.

Original SHA-256: `c8f2ee691f7c0b111836999c96e33b8effe13b649a9e0cbbbf8e7a7566e1590d`.

External assertions inside that PRD still need integration-time verification. Record later evidence and changed requirements rather than silently converting assumptions into facts.
