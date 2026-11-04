# Build with buy review — 2026-11-04

Private project assessment using the live `loops evaluate --event agents-on-open-rails --sponsor build-with-buy` rubric, with repository inspection. This is team feedback, not a judge's verdict.

## Alignment summary

Trialoom fits the track through platform-sponsored inference that explains real browser observations for builders. The local integration is implemented, but there is no verified paid service output or external-user benefit yet. Publishing the landing page and filling the entry form does not establish those results.

## Verified strengths

- Real isolated browser execution and recovery: [free dispatcher](../src/server/free-test-dispatch.ts), [runner](../scripts/free-preview-runner.ts), [local evidence](evidence/FREE-02.json) and [crash recovery](RUN-03-RECOVERY.md).
- The paid request is bound to immutable sanitized observations; passing reports skip purchases: [report preparation](../src/server/free-test-reports.ts), [provider boundary](../src/server/buy-report.ts).
- The worker actually calls the purchase path when a signer and authorized budget exist: [worker](../workers/free-tests.ts), [purchase journal](../src/server/sponsored.ts), [x402 adapter](../src/server/buy-x402.ts). The 2026-11-04 fixes require finalized exact-transfer evidence and preserve the original payer, expiry and reservations. [293-check checkpoint](evidence/BUY-01-settlement.json).
- Advisory explanations appear beside their own deterministic checks and cannot change a test result: [result UI](../src/components/free-test-history.tsx).
- The registered entry now links to [trialoom.xyz](https://trialoom.xyz); [ERC-8004 identity 10031](evidence/ERC-8004-registered.json) exists. [Entry checkpoint](evidence/HACK-01-demo.json).

## Gaps and risks

- No actual paid call, useful provider answer or exact finalized receipt has exercised the product path. A quote and simulated gateway tests are not that proof.
- Hosted signup, email delivery, isolated execution and sponsored purchases remain disabled. The public URL offers the landing page and sample workspace, not an operational free testing beta. [Deployment evidence](evidence/FREE-03.json).
- No observed external-user benefit or measured time savings. The entry's “20–40 minutes” claim is an unvalidated estimate and should be removed or supported.
- The entry description predates deployment and identity registration. It also describes rented browsers/machines as if they were current capabilities; those are future plans. Update the copy after the paid proof, through the required draft/approval workflow.
- GitLab was accepted by the form, but the GitHub requirement is unresolved. Local commits have not been pushed during this work. `hasIdentity` and `firstTaggedTx` remain null in Loops; the identity has separate chain evidence, while paid activity does not exist. Keep attribution evidence and obtain organizer clarification rather than asserting eligibility.

## Per-criterion assessment

| Criterion | Current evidence → next improvement |
| --- | --- |
| Use case quality / problem solved — 40% | Clear builder testing task with real local replay; benefit still inferred → observe a named consenting external builder using the result and record what it helped them do. |
| Depth of integration — 35% | Worker, request binding, signing, budget and receipt validation implemented → run the exact product path against buy and retain useful output plus finalized receipt. |
| Demand for consumed agents — 25% | Zero verified paid calls or repeat users → document useful demand from actual tests; do not manufacture repetitive calls or claim internal fixtures as users. |

## Bounty fit

**Build with buy — partial.** The product and local integration exist, with a registered funded wallet. Missing evidence: a useful paid Celo mainnet call, matching receipt and real user benefit. Submission-host and attribution questions also need resolution. No numeric score or eligibility claim is made.

## Top three next steps

1. Obtain one genuine browser observation, purchase its useful explanation within the existing cap, and retain output plus finalized payment evidence in the durable journal.
2. Complete signup email and hosted execution gates, then observe one external builder completing a test and using its result. Measure benefit rather than repeating the entry's estimate.
3. Resolve GitLab acceptance, synchronize the repository, refresh entry claims and evidence, and retain final confirmation before **2026-11-09 09:00 GMT / 10:00 Africa/Lagos**. [Official event](https://www.loops.house/agents-on-open-rails).
