# Build with buy review — 2026-11-04

Private project assessment using the live `loops evaluate --event agents-on-open-rails --sponsor build-with-buy` rubric, with repository inspection. This is team feedback, not a judge's verdict.

## Alignment summary

Trialoom fits the track through platform-sponsored inference that explains real browser observations for builders. The local integration is implemented, but there is no verified paid service output or external-user benefit yet. Publishing the landing page and filling the entry form does not establish those results.

**Fresh assessment requested by the user: credible fit, not bounty-ready on current evidence.** The concept does not need replacing; the paid service must demonstrate useful contribution to a builder's actual testing task. This is an assessment of available evidence, not a prediction of the prize outcome.

## Fresh read-only checks

- Loops entry still names Build with buy, the registered wallet and `https://trialoom.xyz`. The live evaluator still uses 40% use-case quality, 35% integration depth and 25% demand.
- Local journal contains zero purchases and zero sponsored outputs; the authorized 50,000-unit budget has zero reserved/settled units. This confirms no recorded paid-service proof, not an assertion that the wallet has never made any other transaction.
- Live homepage and health return 200. Health says testing is unavailable; the homepage says signup is being prepared and no sponsor wallet is configured. The signup page also remains unavailable.
- Anonymous GitLab API confirms the repository is public. Its `main` is `a8df98d9b73c788b3a3ac60c945451468740bfed`, 23 local commits behind at the time of review. Those missing commits include the latest payment corrections. No fetch, push or deployment was performed.
- The public FAQ says independent users qualify Build with buy, defines independence using prior independently funded Celo wallet activity, and also welcomes new users under other measurements. It does not explain how those measurements apply to email-only users of a platform-sponsored service. This remains an organizer question; it is not grounds to invent a requirement that every free user must pay or to assert that email registrations qualify. [Official FAQ](https://www.loops.house/agents-on-open-rails).

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
- **The paid output's usefulness is the main product concern.** [The actual free-test projection](../src/server/free-test-reports.ts) passes only three or four boolean checks to the provider. [The prompt](../src/server/buy-report.ts) correctly forbids invented status codes, causes or fixes. Consequently, the model may only restate the failed check. This is an inference from the input contract, not an observed provider failure: no real output exists yet. Demonstrate that the paid advice gives a builder an actionable next step beyond the raw pass/fail display. Extend the sanitized evidence only if that first real test shows the input is insufficient; do not manufacture context.
- The entry description predates deployment and identity registration. It also describes rented browsers/machines as if they were current capabilities; those are future plans. Update the copy after the paid proof, through the required draft/approval workflow.
- GitLab is public and was accepted by the form, but the GitHub requirement is unresolved. Local commits have not been pushed during this work. `hasIdentity` and `firstTaggedTx` remain null in Loops; the identity has separate chain evidence, while paid activity does not exist. Keep attribution evidence and obtain organizer clarification rather than asserting eligibility.

## Per-criterion assessment

| Criterion | Current evidence → next improvement |
| --- | --- |
| Use case quality / problem solved — 40% | Clear builder testing task with real local replay; benefit still inferred → observe a named consenting external builder using the result and record what it helped them do. |
| Depth of integration — 35% | Worker, request binding, signing, budget and receipt validation implemented; provider input currently limited to boolean checks → demonstrate a paid answer that materially improves a builder's next action and retain its finalized receipt. |
| Demand for consumed agents — 25% | Zero recorded paid calls or sponsored outputs; no verified external-user benefit → document useful demand from actual tests and clarify the independent-user qualifier; do not manufacture repetitive calls or claim internal fixtures as users. |

## Bounty fit

**Build with buy — partial.** The product and local integration exist, with a registered funded wallet. Missing evidence: a useful paid Celo mainnet call, matching receipt and real user benefit. Submission-host and attribution questions also need resolution. No numeric score or eligibility claim is made.

## Top three next steps

1. Prove the full path on one real browser observation: exact useful provider request, capped paid call, finalized receipt and advice displayed beside the result. Have a builder explain what the advice helped them do. An internal fixture can validate plumbing; it does not establish external demand.
2. Resolve the public signup and hosted execution gates for an external builder trial. Measure time/steps saved and observe genuine repeat use if it occurs. In parallel, ask the organizers what evidence counts for platform-sponsored, email-only users and whether the public GitLab repository is accepted. No such message was sent in this assessment.
3. Synchronize the repository within the user's authorization, refresh the entry copy to match demonstrated behavior, and retain final confirmation before **2026-11-09 09:00 GMT / 10:00 Africa/Lagos**. [Official event](https://www.loops.house/agents-on-open-rails).

## Verification limits

This review re-read code and current entry/site/journal state; it did not re-run the 293-test suite, make a purchase or change the live product. One generic sponsor-knowledge query returned technical documentation without resolving eligibility. Automatic approval review blocked an earlier project-specific external query; the completed lookup sent only a general question about public rules. The unanswered organizer questions remain explicit, and no external message or submission edit was made.
