# Build with buy review — 2026-11-09, deadline eve

Private assessment against the live rubric fetched today with
`loops evaluate --event agents-on-open-rails --sponsor build-with-buy`. The weights
it returns are **use case quality and the problem solved 40%**, **depth of the
integration 35%**, **demand created for the agents consumed 25%**. Team feedback,
not a verdict and not an eligibility determination. Submission closes
**2026-11-09 09:00 GMT** (10:00 Africa/Lagos).

## Alignment summary

The entry is complete by the platform's own check — `loops project fields` returns
`missing: []` — and three quarters of the rubric's weight sits on the two criteria
this project is strongest on. The integration is not a wrapper: it is a payment
path with a pinned asset table, domain-separator verification, deterministic
nonces and reconciliation against finalized chain state. The weak criterion is the
lightest one, and it is weak for an honest reason: one paid call exists and there
are no independent users yet.

## What is genuinely strong

- **A named user and a quantified cost.** The description opens on a solo founder
  or two-person team with no QA, and puts the current cost at 20–40 minutes per
  release. The rubric's heaviest criterion asks for exactly this.
- **The purchase decision is wired into production and ran today.** The Railway
  worker starts with `{"event":"worker.sponsor","adapter":"buy-x402"}`
  ([`workers/main.ts:35`](../workers/main.ts)), and the completed check of
  00:10 UTC produced a real row in `buy_report_inputs` recording
  `status: skipped`, `skip_reason: all_checks_passed`. That is the gate working:
  a passing test has nothing to explain, so nothing is bought. Evidence the path
  is live rather than scaffolded.
- **Depth, in lines that do something.** ~1,900 lines across
  [`src/server/buy-x402.ts`](../src/server/buy-x402.ts) (474),
  [`src/server/sponsored.ts`](../src/server/sponsored.ts) (781),
  [`src/server/buy-report.ts`](../src/server/buy-report.ts) (313) and
  [`src/server/free-test-reports.ts`](../src/server/free-test-reports.ts) (174).
  Three Celo stablecoins are pinned with the EIP-712 domain each declares, and the
  domain is rebuilt and compared against the token's own `DOMAIN_SEPARATOR` before
  anything is signed — needed because USDT and USAT expose no `version()` on
  chain. The authorization nonce is `keccak256(intentKey)`, so a retry signs the
  same nonce and the token itself refuses a second use.
- **A verified mainnet receipt.** 0.01 USD₮ to Cencori inference,
  `0x339fe5f4…2943ef` in block 82243718, reconciled against finalized state
  ([checkpoint](evidence/BUY-01-paid-call.json)).
- **An ERC-8004 identity that answers from the chain.** Re-checked today:
  `ownerOf(10031)` is the agent wallet, registry `balanceOf` is 1, and the
  `data:` URI decodes to the registration file naming Trialoom.
- **A privacy boundary enforced in code, not prose.** At most twelve closed
  observations leave the product; `projectFreeTestReport` preserves recorded
  booleans and refuses to infer a cause.

## Gaps and risks

- **Demand is one call (25% criterion).** The bounty asks for "verified paid calls
  … and new demand for the agents consumed", plural. There is one, from the
  project's own wallet. This is not closable honestly before 09:00 GMT: the free
  check allowance is three per account per UTC day and today's three are spent,
  and manufacturing calls from our own wallet would contradict both the entry's
  own statement that there are no independent users and this project's standing
  rule against claiming unearned evidence. The two-person independent test is the
  real route and it lands after the deadline.
- **Two of today's three checks were lost to our own bug.** Both `homepage` runs
  against the DNS-verified external domain died as `PREVIEW_PROCESS_STOPPED`
  before the umask fix landed. Those are exactly the runs that record `blocked`
  and therefore buy an explanation, so the bug cost the one chance at an automatic
  purchase inside the window. Fixed in `259da9a`; the cost is already paid.
- **Only inference is actually bought.** The sponsor lists machines, browsers,
  data and 600+ tools. The description's "the same path is how it rents isolated
  browsers and disposable machines as demand grows" is conditional and defensible,
  but a skeptical judge reads quickly. Wiring a second service is a multi-hour
  build and is not advisable at this hour.
- **`celo.hasIdentity` and `firstTaggedTx` read `null` on the platform.** The
  identity is six days old and verifiable on chain, so this is the platform's
  indexing. `missing: []` suggests it does not block validity, but it is worth
  asking the organizers rather than assuming.
- **No walkthrough video.** `videoUrl` is optional and empty. The live demo and
  the `/demo` example report mitigate it; a judge who will not sign up still sees
  a real report.

## Per-criterion assessment

| Criterion | Weight | Where it stands | What would move it |
| --- | --- | --- | --- |
| Use case quality and the problem solved | 40% | Strong. Named user, quantified cost, working product at a live URL | A short walkthrough video; nothing structural |
| Depth of the integration | 35% | Strong. Real signing, verification, budget and reconciliation, wired into the production worker and exercised today | A second bought service — too large for the remaining window |
| Demand created for the agents consumed | 25% | Weak and honestly stated. One verified call, no independent users | Independent users running checks that find something. After the deadline |

## Bounty fit

**Build with buy · 5 winners, $200 each** — partial. Met: a real problem for a
named user, a product that pays for a service it does not own, over x402 on Celo
mainnet, with a verified paid call from the project's recorded wallet. Unmet: *new
demand* for the agent consumed, in the plural sense the description asks for. The
missing piece is independent users, not code.

Not targeting **Open Corridors: USA₮ with x402** — the settled call is USD₮
(Tether USD, `0x48065fbB…`), not USA₮. `USAT` is pinned in `buyAssets` and would
sign correctly, but the wallet holds USDT and that track asks for real users
settling USA₮. Claiming it on one asset-swapped call would be the kind of reach
this project has refused elsewhere.

## Top three next steps before 09:00 GMT

1. **Add one sentence to the entry description** recording that the production
   worker evaluated today's completed check automatically and recorded
   `skipped: all_checks_passed`. It converts "the path exists" into "the path ran
   in production today, and declined to spend because there was nothing to
   explain". Cheap, honest, and it speaks to the 35% criterion. Needs the user's
   approval, as every entry change has.
2. **Ask the organizers the three open questions** — repo-at-registration,
   `hasIdentity: null`, and the x402 attribution conflict. Drafted; there is no
   CLI channel, so it needs the user to post it.
3. **Leave the demand criterion alone.** The correct answer is the independent
   test, which lands after Friday's judging starts. Record it as what it is.

## What was explicitly not done

No second account was created and the per-account daily allowance was not raised,
although either would have produced another workspace screenshot and another paid
call. Both would have broken the guarantee the evidence is meant to demonstrate.
