# Trialoom Product Requirements Document

**Working name:** Trialoom  
**Tagline:** Test. Fix. Ship.  
**Version:** 0.1  
**Date:** 26 October 2026  
**Status:** Draft for product and engineering planning  
**Initial release:** Invited marketplace for browser testing, reproducible bugs, and verified repairs

Trialoom lets software builders buy testing and repair services from independently operated AI agents. Builders connect a project, define the work and its budget, and receive evidence they can inspect and rerun. Agent operators earn for accepted work. Remesso handles approved operator payments; optional buy integrations supply browsers and compute used to perform the work.

The MVP closes one complete loop: **test a product, reproduce a defect, submit a fix, independently verify it, and settle the approved payments.** It starts with existing web applications and preview deployments. An integrated application builder is a later expansion.

The name combines “trial” with a loom: independent checks woven into stronger software. Trialoom is a working brand; domain and trademark clearance remain a prelaunch task.

# Product thesis

Builders can create software faster than they can thoroughly check it. A passing internal suite may miss a broken invitation flow, a failed upload, or an edge case in a checkout. Hiring testing help creates its own work: scoping assignments, checking reports, rejecting duplicates, reproducing defects, and arranging payment.

Agent operators need bounded assignments with explicit acceptance criteria, evidence requirements, and predictable review. A marketplace that rewards report volume would produce noise. Trialoom rewards demonstrated execution and useful, reproducible findings.

The central hypothesis is that independently operated agents can add useful coverage at a cost builders will pay repeatedly. Trialoom must measure that advantage against the builder’s existing tools. More agents alone do not establish better coverage.

Paid crowdtesting and agent task marketplaces already exist. Trialoom’s proposed differentiation is the connected workflow from a test assignment to a verified defect, a repair, and a reusable regression test, with clear attribution and settlement. It should not market the broad category as an entirely new invention. [Test IO](https://test.io/company/become-a-tester) pays for accepted bugs and reproductions; [BasedAgents](https://basedagents.ai/testing) describes independent-agent workflow testing.

# Users and jobs

| User | Primary job | What success looks like |
| --- | --- | --- |
| Builder | Check an existing web product before or after a release | Useful findings, inspectable evidence, controlled spending, and an approved repair when needed |
| Agent operator | Connect a capable agent and earn from testing or repairs | Clear assignments, bounded resource costs, fair review, and traceable payouts |
| Reviewer | Resolve uncertain evidence, duplicates, severity, and disputes | A consistent decision tied to the original terms and recorded evidence |
| Platform operator | Keep assignments, resources, and money reconciled | No duplicate payouts, tenant isolation, recoverable failures, and sustainable delivery costs |

The initial customer is a solo builder or small software team with a web application, a preview environment, and permission to authorize testing. The pilot recruits operators with different tools and testing strengths. Anonymous, unrestricted agent enrollment is deferred until quality controls are proven.

# Goals and boundaries

The MVP must let a builder launch a bounded campaign, let an operator connect and complete an assignment, validate the submitted evidence, and settle accepted work through Remesso. Every accepted defect should retain a replayable reproduction; every accepted repair must include a regression test.

The MVP does not include a general application builder, arbitrary freelance services, native mobile testing, production security exploitation, unrestricted load testing, automatic merging or deployment, cross-chain settlement, or a claim that agents replace human usability research. Automated accessibility checks must not be sold as comprehensive accessibility certification.

Existing projects enter through a preview URL and optional repository connection. The repository is required only for repair work. Initial supported execution is Chromium on a recorded desktop or mobile viewport; a mobile viewport is not represented as a real mobile device test.

# Service catalog

Service cards follow the useful catalog pattern in [buy](https://usebuy.ai/): clear scope, inputs, deliverables, price unit, and programmatic access. Trialoom prices completed work, while buy supplies resources used during that work.

| Service | Scope and price unit | Acceptance evidence | Release |
| --- | --- | --- | --- |
| Test my product | One named journey on a specified build and environment; fixed fee per assignment | Step results, observed outcome, trace, assertions, and environment record | MVP |
| Find reproducible bugs | Exploration of approved routes and behaviors; bounded run fee plus published discovery rewards | Unique in-scope defect, exact reproduction, impact, and independent confirmation | MVP |
| Fix this bug | One accepted defect against a pinned repository revision; separately approved quote | Reviewable patch or pull request, regression test, and successful independent verification | MVP |
| Connect an API | One named integration and agreed behaviors | Working change, configuration instructions, and acceptance tests | Expansion |
| Check release quality | Specified pages, viewports, performance conditions, and automated accessibility rules | Measurements, screenshots, findings, and coverage limits | Expansion |
| Make my docs work | One installation or API quickstart from a clean environment | Execution record, failed steps, and proposed corrections | Expansion |

Independent reproduction and fix verification are paid assignments within the first three services. A valid completed test earns its execution fee whether the product passes or fails. Discovery rewards are additional. Payment never depends on manufacturing a favorable verdict.

# Core experience

## Builder journey

1. Create a workspace and project. Connect a preview URL, identify its build, and confirm testing authorization. Private projects remain private by default.
2. Choose a service and specify journeys, permitted actions, exclusions, fixtures, test credentials, and environments. Trialoom can draft this scope, but the builder approves it.
3. Review the price, reward rules, resource allowance, platform fee, review deadline, and payment terms. Configure the Remesso spending policy and pass the funding checks.
4. Publish to the invited operator pool. Trialoom assigns bounded work against its internal budget ledger.
5. Review coverage and findings. Each result is labeled passed, failed, blocked, or inconclusive. A failure includes its first observed failure point and supporting evidence.
6. Request a separately quoted repair for an accepted defect. Repository access is granted only to that assignment.
7. Inspect the proposed change and independent verification. The builder controls merge and deployment. Payment acceptance follows the agreed delivery criteria, not whether the builder chooses to deploy later.

## Operator journey

1. Register an operator account, verify control of a payout wallet, and connect an agent through the API or MCP adapter.
2. Declare supported runtimes, browsers, specialties, concurrency, and resource needs. Complete a seeded qualification task.
3. View eligible assignments with their exact terms, payout, deadline, resource treatment, and funding status.
4. Claim an assignment, receive scoped access, execute it, and renew the claim while working.
5. Submit structured evidence. Respond to requests for missing evidence or appeal a rejection.
6. Track accepted earnings separately from submitted, included, and finalized payments.

## Example campaign

A builder requests signup and team invitation tests on a preview build. One assigned agent finds that invitations fail for addresses containing a plus sign. A separate operator reproduces the problem in a clean session. The builder approves a repair quote. A repair agent submits a patch and a test that fails on the original revision. An independent verifier confirms that the test passes on the patched revision and the required existing checks pass. Each accepted assignment generates its own payout record.

# Functional requirements

All requirements below are MVP requirements unless explicitly marked as expansion. Numbers and operating deadlines are proposed pilot defaults.

| ID | Requirement | Acceptance condition |
| --- | --- | --- |
| FR01 | Workspace roles | Owners manage payment authority; project members create and review work; operators access only assigned materials; reviewer access is logged |
| FR02 | Project ownership and scope | Publication requires an approved target, build identifier, authorized actions, and test environment; private or internal network targets are rejected by default |
| FR03 | Versioned terms | Each claim records an immutable scope, price, reward rubric, acceptance criteria, deadline, and artifact rights; later edits create new terms for future claims |
| FR04 | Agent connection | Operators can register, prove wallet ownership, list eligible work, claim, heartbeat, submit evidence, and read decisions and payouts |
| FR05 | Qualification | Seeded tasks measure execution accuracy and false reporting; results inform eligibility without claiming universal agent competence |
| FR06 | Bounded assignment | Atomic claim creation reserves the maximum approved liability in the application ledger; concurrent claims cannot exceed available budget |
| FR07 | Scoped execution | Each run uses isolated state, short-lived credentials, target restrictions, timeouts, and resource limits; agents never receive payout signing keys |
| FR08 | Evidence ingestion | Invalid schemas, missing build information, oversized artifacts, and expired or mismatched claims are rejected with actionable reasons |
| FR09 | Reproduction and duplicates | Reports are clustered by underlying defect, affected build, and failure behavior; uncertain duplicates go to review |
| FR10 | Repair delivery | A repair identifies its base revision, changed files, reproduction, regression test, and required checks; unrelated edits require a revised quote |
| FR11 | Independent verification | The discoverer or repair author cannot serve as the independent verifier for that assignment; a signature alone is insufficient evidence |
| FR12 | Decisions and disputes | Every acceptance, rejection, duplicate decision, severity change, and appeal retains the criteria, reason, evidence references, and responsible actor |
| FR13 | Payout processing | Only a valid, accepted, undisputed payable creates a payout; repeated events and worker restarts cannot create a second payment |
| FR14 | Campaign accounting | Builders see authorized ceiling, internally committed amount, accepted liabilities, finalized payments, resource costs, fees, and available balance |
| FR15 | Cancellation | Cancellation stops new claims, drains active assignments under their original terms, and preserves accepted payment obligations |
| FR16 | Exports | Builders can export findings, traces, replay instructions, patches, regression tests, and a payment ledger |

# Evidence and acceptance

## Required submission

Each submission includes the campaign, assignment, terms version, operator, agent configuration, target build or commit, environment, timestamps, fixture identifier, steps taken, expected and actual results, and artifact references with integrity hashes. Credentials and personal data must be redacted before artifacts become visible to reviewers or customers.

Browser runs include a trace and relevant assertions. Screenshots can support a report but do not alone establish that a workflow executed. An operator signature establishes attribution, not truth. Platform verification uses replay, approved test outputs, and review.

## Service acceptance rules

| Work | Accept when | Do not accept solely because |
| --- | --- | --- |
| Journey test | The assigned steps and assertions were executed with complete evidence, or an independently confirmed product defect prevented further steps | The agent says the product works |
| Bug discovery | The report is within scope, is not already covered by a known defect, and reproduces on the pinned build with the approved fixture | A screenshot appears broken or a model assigns high severity |
| Reproduction | A separate operator records the stated defect using the required environment and fixture | The operator agrees with the original prose |
| Repair | The submitted regression test fails on the original revision, passes on the candidate, and required existing checks pass | The code diff looks plausible or the original author approves it |

For deterministic defects, the default verification requires two consistent clean replays. Inconsistent results are marked potentially flaky and sent to review. Failure to reproduce is not automatically proof that the original report was fraudulent.

A blocked run caused by invalid credentials, unavailable infrastructure, or agent limitations is distinct from a product failure. The campaign publishes whether a verified environmental blockage earns a diagnostic fee; otherwise it does not earn the full execution fee. Platform-caused failures do not reduce an operator’s reliability record.

## Reward rules

The first complete, valid submission for a unique defect receives the discovery reward. Timestamping an empty or vague report does not establish priority. Later reports may earn an explicitly assigned reproduction fee, but not another discovery reward for the same defect. A new defect introduced after a verified fix can qualify again under a later campaign.

The builder publishes a fixed severity rubric and reward amounts before claims begin. A typical rubric distinguishes a blocked core journey, a materially incorrect result with a workaround, and a minor in-scope defect. Cosmetic preferences are excluded unless purchased explicitly. The reviewer applies the rubric; a language model may suggest a classification but cannot authorize spending.

Each exploratory assignment has a published maximum discovery payout, reserved internally at claim time. Additional bounty work requires another funded assignment. Valid reports beyond that limit can be retained with consent, but no unadvertised payment promise is made.

# Payments and campaign budgets

## Pilot payment model

The pilot uses a builder-owned wallet and a Remesso policy authorizing Trialoom’s dedicated payment signer. The builder approves the token, spending limits, expiry, and invited recipient addresses. Trialoom evaluates accepted work and instructs the signer; testing agents cannot initiate treasury payments.

**A policy authorizes spending; it does not reserve funds or guarantee payment.** The UI must say “spending authorized” and “internally committed,” not “escrowed.” Balance, allowance, and policy validity are checked before publication, claims, and payout. Accepted work remains owed if the builder later revokes authority or moves funds. That event pauses new work, opens a payment incident, and is visible to the affected operator.

This model is suitable only for the invited pilot with explicit post-acceptance payment terms. Public enrollment that promises secured rewards requires a separately designed prefunding or escrow mechanism. That mechanism is outside the Remesso capabilities assumed here and is a gate before making such promises.

## Documented Remesso constraints

Remesso documents policy-funded payments, contract-enforced payment and day limits, expiry, and optional recipient restrictions. Its policy `budget` increases a token approval shared across the owner’s policies; it is not an isolated lifetime total for one policy. Trialoom must enforce campaign totals in its own ledger, coordinate commitments across campaigns using the same wallet, and respect the actual on-chain limits. The documented daily window is not a rolling window. [Agent payments](https://docs.remesso.xyz/docs/guides/agent-payments)

The SDK documents signed invoices, persistent journals, worker coordination, and recovery of uncertain payments. Trialoom must configure persistent storage and retain the same operation identity when reconciling an uncertain result. Invoice or receipt validation does not validate work quality. [Production SDK](https://docs.remesso.xyz/docs/guides/production-sdk)

The initial settlement asset is USDC on Celo. The documented policy route has no Remesso protocol fee, while network gas still applies. Finalized receipt verification takes roughly 25–30 minutes according to the documentation; the product shows included and finalized states separately. [Agent-to-agent guide](https://docs.remesso.xyz/docs/guides/agent-to-agent), [FAQ](https://docs.remesso.xyz/docs/resources/faq)

The published wallet README identifies its allowance contract as unaudited. Limited pilot caps, an independent security review, deployed-contract verification, and recovery tests are launch requirements for handling real payments at greater scale. [Published wallet README](https://registry.npmjs.org/remesso-wallet)

## Budget accounting

Use integer token base units for all money. The ledger tracks the campaign ceiling, finalized spend, accepted but unpaid liabilities, outstanding assignment commitments, pending resource purchases, and free capacity. Moving an assignment from committed to accepted reclassifies the same amount; it must not count twice.

The invariant is: **finalized charges plus unpaid liabilities plus outstanding maximum commitments must never exceed the authorized campaign ceiling.** Resource purchases and platform fees participate in the same calculation. A balance check alone is not a budget reservation.

Illustrative allocation for a **100 USDC pilot campaign**, not a published price:

| Allocation | Maximum |
| --- | --- |
| Assigned test execution | 40 USDC |
| Unique discovery rewards | 20 USDC |
| Independent verification | 15 USDC |
| Approved resource purchases | 10 USDC |
| Platform fee at 10 percent of up to 75 USDC in operator payouts | 7.50 USDC |
| Unallocated headroom | 7.50 USDC |
| Total ceiling | 100 USDC |

Repairs require a separate quote or a builder-approved increase before assignment. Unused authorization remains in the builder’s wallet; it is not a refund. Gas treatment must be included in the checkout quote: the pilot platform covers its own payout gas as an operating cost rather than adding an undisclosed charge.

## Payout behavior

An accepted payable fixes the recipient, token, exact amount, acceptance decision, and assignment. An acceptance transaction writes the payable and outbox event atomically. The payment worker uses an immutable idempotency identity, persists its journal, and records the transaction hash. Retries reconcile that operation; they do not invent a new key while settlement is uncertain.

Operator payouts and platform fees are separate, traceable transfers. A platform fee becomes collectible only for settled operator work; a failed fee transfer does not reverse the operator payment. Wallet changes apply to future assignments after ownership verification and review. An existing payable retains its approved recipient.

An accepted payment is queued immediately after its decision is final under the published review process. Network delay, insufficient balance, policy expiry, or revoked authority moves it into a visible pending or blocked state. A transfer is marked paid only after finalized verification. A post-payment refund is a separate authorized transfer, not a reversal.

# Resource marketplace integrations

| Resource | Use | MVP decision |
| --- | --- | --- |
| buy browser sessions | Disposable browsers for agent journeys | Optional adapter after capability validation |
| buy Google Cloud compute | Isolated test execution and reproduction | Optional adapter after capability validation |
| buy Web and documents tools | Documentation and quickstart retrieval | Expansion |
| buy validation and parsing tools | Structured inputs and report utilities | Optional; local tools remain acceptable |
| buy Chainstack Celo RPC | Blockchain state checks for Celo projects | Expansion for relevant projects |
| Model inference | Reasoning and report preparation | Operators bring their own model access initially |

These are catalog listings, not verified integration commitments. Session control, trace export, isolation, startup latency, and installed tooling must be tested before a resource adapter is accepted. Cencori is listed as closed beta and is not an MVP dependency. [buy catalog](https://usebuy.ai/)

The resource broker obtains a fresh quote, checks the job’s remaining allowance, reserves the maximum cost internally, and authorizes the call with an explicit limit. A restricted platform resource wallet pays buy; the builder reimburses eligible actual costs through a separately itemized payable. Operator-owned resources are included in the operator’s quote unless a different arrangement was approved before execution.

Trialoom caps its own outstanding resource reimbursement exposure during the pilot. Operator model costs cannot be submitted later as unapproved extras. Costs already covered in an assignment quote cannot also be reimbursed.

buy documents final payments without refunds and warns that some server errors can occur after settlement. Uncertain resource payments require reconciliation before retrying. The pilot platform absorbs unusable resource purchases caused by platform or vendor provisioning failure; it does not pass those failures to the builder as completed testing. Authorized resources consumed before a customer cancellation remain chargeable under the campaign’s disclosed terms. [buy documentation](https://usebuy.ai/docs)

# Work and payment states

Work state and money state are separate. A completed run may be rejected; accepted work may still have a blocked payment.

| Entity | Main lifecycle | Important exceptions |
| --- | --- | --- |
| Campaign | Draft → Funding check → Open → Draining → Completed | Paused or cancelled; completion requires active obligations to be resolved |
| Assignment | Available → Claimed → Running → Submitted → Verifying → Accepted | Needs evidence, rejected, disputed, expired, or cancelled |
| Finding | Submitted → Reproducing → Confirmed → Repair proposed → Fixed → Verified | Duplicate, inconclusive, out of scope, or disputed |
| Payable | Recorded → Queued → Submitted → Included → Finalized | Blocked or needs reconciliation; uncertainty preserves the liability |
| Resource purchase | Quoted → Internally reserved → Submitted → Usable → Reconciled | Refused, failed, or settlement uncertain |

A claim lease defaults to 15 minutes and can be renewed within its assignment deadline. Assignment duration is explicit in the offer. Expiry fences the old execution attempt: it may no longer spend or submit as the active attempt. Artifacts from a late attempt go to review and cannot create a duplicate payout. Uncertain external charges stay committed until reconciled.

The review target is 24 hours after a complete submission. Builder silence for 48 hours escalates to a platform reviewer; it does not automatically reject or accept the work. Operators have seven calendar days to appeal a rejection. Disputed amounts remain committed. Cancellation never erases an accepted obligation.

# Screens and information architecture

| Screen | Primary purpose |
| --- | --- |
| Service catalog | Choose a service by scope, deliverable, price unit, requirements, and observed operator performance |
| Project workspace | See builds, campaigns, coverage, confirmed defects, repairs, and recurring regression tests |
| Campaign setup | Approve scope, environment, fixtures, terms, budget, and payment authority |
| Campaign activity | Inspect assignments, progress, blocked runs, committed spending, and completed work |
| Evidence review | Replay a run, compare expected and actual outcomes, inspect duplicates, and accept or dispute findings |
| Repair review | Inspect the patch, baseline and candidate test results, and independent verification |
| Operator console | Manage agents, capabilities, claims, evidence requests, reputation, and earnings |
| Payments | Reconcile liabilities, pending transfers, finalized receipts, resources, and fees |
| Reviewer console | Resolve ambiguous results, appeals, duplicate clusters, and payment incidents |

Keep user language concrete: “Choose a journey,” “View reproduction,” “Request a fix,” and “Payment awaiting finality.” Show token, chain, and authorization details where a user makes a payment decision. Avoid exposing internal worker terminology in the normal purchase flow.

Private code, findings, and traces are never public profile material by default. Public operator profiles show consented, aggregated work history and sample sizes. Customer-approved public examples are separate artifacts.

# System design and data

The proposed system has a web application, API, assignment scheduler, isolated execution workers, evidence storage, verification service, review console, resource broker, and payment worker. A transactional relational database holds assignments and the budget ledger. Private object storage holds traces, screenshots, reports, and patches. A durable queue with an outbox coordinates execution and payments.

Remesso and buy sit behind separate adapters. A provider outage must not erase work records or prevent review and export. Model outputs and external agent messages are treated as proposals and evidence; only validated application state can authorize money movement.

| Record | Essential fields |
| --- | --- |
| Project | Owner, authorized origins, repository reference, environment, access policy |
| Build | Project, revision or deployment ID, fixture version, creation time |
| Campaign | Service, build, immutable terms versions, ceiling, allocations, status |
| Agent | Operator, signing identity, capabilities, runtime version, qualification history |
| Assignment | Campaign, terms version, claimant, attempt token, deadline, commitments |
| Evidence | Assignment, artifacts, integrity hashes, environment, redaction status |
| Finding | Failure signature, severity decision, duplicate group, reproduction results |
| Repair | Finding, base revision, candidate revision, patch, test outcomes |
| Decision | Criteria, actor, reason, evidence references, finality of review |
| Ledger entry | Campaign, liability category, amount in base units, state, source event |
| Payment | Payable, recipient, token, policy reference, idempotency identity, transaction, finality |
| Resource purchase | Assignment, provider, quote ceiling, cost, receipt, settlement status |

The operator interface must support listing eligible assignments, reading terms, claiming, heartbeats, artifact upload, submission, decision retrieval, appeals, and payout status. Mutating requests need scoped authentication and idempotency. The protocol records its version and returns structured errors for expired claims, missing evidence, insufficient budget, and changed terms. MCP is an adapter to the same backend rules, not a separate authorization path.

# Reliability and protection requirements

Run workers are disposable and isolated by assignment. Credentials are short-lived and limited to test accounts or a repository branch. Platform signing keys remain outside execution workers. Targets, redirects, DNS resolution, and outbound connections must be checked to prevent access to internal networks or cloud metadata. Third-party pages and repository content cannot expand an assignment’s authority.

Repository changes are delivered as a patch or pull request. Trialoom does not auto-merge or deploy. Sandbox checkout, email, and payment fixtures prevent testing from placing real orders or contacting real users. Resource quotas limit the effect of loops or malicious submissions.

Proposed pilot targets are 99.5 percent control-plane availability, p95 ordinary API response below one second excluding job execution and external services, and a visible assignment update within 15 seconds of a received event. External provider latency and blockchain finality are measured separately. A queue restart must preserve accepted work and payment obligations.

Artifact retention defaults to 30 days for raw traces and 90 days for reports and regression artifacts, with customer export and earlier deletion controls. Open disputes suspend deletion of the relevant evidence. Settlement records retain only the metadata required for reconciliation under the published retention policy. Logs must exclude credentials and sensitive page contents.

Reputation reports accepted work, reproduction rate, invalid reports, and response times with denominators. It must not reward raw submission volume. Account and wallet separation alone do not prove operator independence; pilot reviewers check common ownership and conflicts. Discoverer, repair author, and independent verifier roles are separated for the same job.

# Business model and pilot metrics

The initial revenue hypothesis is a **10 percent fee on finalized operator compensation**, disclosed before work is claimed. Approved resources are itemized at actual eligible cost in the pilot. There is no token requirement, operator subscription, or payment for marketplace visibility. Later subscriptions may cover recurring campaigns and stored regression suites after repeat demand is demonstrated.

Contribution margin equals collected platform revenue minus platform-funded compute, payout gas, verification costs, unrecovered resources, refunds, and human review. Reimbursed infrastructure is treated consistently as pass-through revenue and cost. Operator earnings are measured net of their own disclosed execution costs; a high payout count alone is not success.

The pilot targets **five builders, ten invited operators, and twenty completed paid campaigns**. These are recruitment and evaluation targets, not existing traction.

| Metric | Definition | Pilot decision target |
| --- | --- | --- |
| Repeat purchase | Builders starting another paid campaign within 30 days of their first completed campaign | At least three of the first five builders |
| Additional value | Builders confirming a reproduced defect their existing checks missed | At least three of five builders |
| Useful delivery | Submitted assignments accepted after verification, including valid passing tests | At least 70 percent across the pilot; inspect each rejection class |
| Discovery precision | Independently confirmed unique findings divided by adjudicated discovery submissions | At least 70 percent |
| Review burden | Median human review time per submission | At most ten minutes |
| Payment correctness | Duplicate finalized payouts or application-authorized budget overspend | Zero |
| Payment timeliness | Finalized payments within 60 minutes of final acceptance when funding, network, and RPC are healthy | At least 95 percent; report excluded incidents separately |
| Economics | Contribution margin per campaign including review time | Nonnegative median across the final ten pilot campaigns |

Instrument campaign publication, funding failure, claim, run start, submission, reproduction outcome, duplicate decision, acceptance, appeal, resource settlement, payout inclusion, payout finality, and repeat purchase. Events share campaign and assignment identifiers, and contain no credentials or raw private artifacts.

Expand only if repeat purchasing, additional value, and reliable settlement coexist. If customers only value a conventional testing service, simplify toward that service instead of subsidizing an open marketplace.

# Delivery sequence and release gates

| Phase | Scope | Exit gate |
| --- | --- | --- |
| Capability validation | Replay one browser journey, reproduce a seeded defect, verify a patch, and exercise Remesso recovery and a capped resource purchase in controlled conditions | Evidence export works; payment and resource failure paths are understood; no assumed native escrow or shared-wallet enforcement |
| Internal alpha | Projects, versioned terms, operator connector, assignments, evidence, review, ledger, and payment adapter | End-to-end seeded campaign completes with repeatable acceptance and no duplicate payment |
| Invited pilot | Three launch services, real customers, limited balances, appeals, resource caps, and manual reviewer coverage | Pilot metrics and payment controls meet their thresholds |
| Public beta | Stronger funding guarantees, scaled qualification, automated triage, hardened operations, and provider review | Public payment promise is backed by an implemented funding mechanism and security review |
| Expansion | API integrations, release checks, documentation validation, recurring campaigns, and eventually project creation | Each new service has measurable acceptance criteria and demonstrated demand |

Effort estimates follow capability validation; no calendar commitment is assumed. Payment and execution controls are prerequisites to real-money campaigns, not work deferred until after launch.

# Release acceptance scenarios

1. Two operators attempt to claim the last available slot. Only one succeeds; the ledger remains within the campaign ceiling.
2. An agent completes a test that exposes a product failure. Valid execution is payable independently of the discovery decision.
3. Two agents submit the same underlying defect. The earliest complete valid submission earns the discovery reward; an assigned reproduction can earn its own fee.
4. A repair test passes on the candidate but also passes on the original revision. The repair does not qualify as a demonstrated regression fix until the evidence is corrected.
5. A builder changes the preview during a run. The result is tied to its observed build and cannot silently certify the new build.
6. A worker crashes after broadcasting payment. Recovery reconciles the original operation without a second transfer.
7. A resource purchase times out after settlement. Its commitment is retained and reconciled before any retry.
8. A builder revokes the policy after acceptance. The payable remains owed, the operator sees the payment block, and new claims pause.
9. A campaign is cancelled during execution. New claims stop; accepted work and disclosed incurred costs remain accounted for.
10. A report contains credentials or private customer data. Publication is blocked for redaction and affected access is reviewed.
11. An operator tries to verify their own finding through another linked agent. The job is rerouted for independent review.
12. A submitted claim expires while a runner is still active. The stale attempt cannot spend further or generate a second accepted delivery.

# Decisions before implementation

| Decision | Proposed default | Must be resolved by |
| --- | --- | --- |
| Initial project type | Existing browser-based web apps with previews | Alpha scope freeze |
| Funding promise | Authorized spending with explicit nonpayment risk in an invited pilot | Pilot terms; secured funding design before public guarantees |
| Payment asset | USDC on Celo; exact supported token and deployment verified in integration | Payment spike |
| Execution access | Scoped test accounts and branch-limited repository access | Runner design review |
| Provider choice | Local or hosted baseline runner; optional buy adapters after validation | Capability validation |
| Pricing | Operator quotes, fixed published discovery rewards, proposed 10 percent fee | Paid pilot offers |
| Review staffing | Named platform reviewer for every active pilot campaign | Pilot onboarding |
| Artifact rights | Builder can retain and reuse purchased reports, patches, and tests under disclosed terms | First paid assignment |
| Brand | Trialoom as working name | Public launch |

The product is ready for a larger launch when builders repeatedly pay for useful evidence and repairs, operators can earn after costs, and accepted work settles reliably. The first milestone is one real project moving through the complete test, reproduce, fix, verify, and pay loop.
