# The resource adapter and accounting

Verified locally on 2026-10-28. This is ALPHA-09 for the resource integrations the PRD's funding model depends on, and it completes FR14's last column. It closes release scenario R07 at the application level. **No resource has been bought from a real provider**: no resource wallet is configured, the live buy adapter stays disabled, and the default adapter refuses every purchase with a visible reason. [Evidence](evidence/ALPHA-09.json) records checks, the dated source check, and exact source hashes.

## Two separate authorizations

A builder's published allowance and the platform's ability to pay are different facts, and conflating them would spend money Trialoom does not have.

| | Who authorizes it | What it limits |
| --- | --- | --- |
| Assignment resource allowance | The builder, in the published terms | What this assignment may spend and later reimburse |
| Platform resource account | An operator of the platform, as a recorded authorization | Trialoom's own outstanding resource exposure, across every campaign |

The platform account is seeded at nothing and no interface raises it: funding the resource wallet is an operational step, recorded in `resource_authorizations`. A purchase past that cap is refused with `RESOURCE_CEILING_EXCEEDED`, and **the amount is not owed by the builder** — nothing was bought.

## What one purchase does

```
quote → reserved → submitted → usable → reconciled
            ↘ refused (nothing paid)
            ↘ failed (paid, undeliverable, absorbed)
            ↘ uncertain (outcome unknown, reservation held)
```

The broker obtains a **fresh quote**, checks the assignment's remaining allowance and the platform's headroom, reserves the authorized ceiling, and records the purchase durably — all before anything is sent, so a lost response still has an identity to reconcile. The provider call then runs outside any transaction and its answer is applied under the purchase's row lock.

The limit is the caller's, not the provider's. A quote above the `maxAmountUnits` the call authorizes is refused with `QUOTE_ABOVE_LIMIT` before anything is signed, as is one about to expire (`QUOTE_EXPIRED`) or priced in another token, network or precision (`QUOTE_TOKEN_UNEXPECTED`). A table check enforces what the code promises: `quoted_units <= ceiling_units` and `cost_units <= ceiling_units`, so an explicit limit is one that cannot be exceeded.

A retried request returns the purchase it already started rather than authorizing a second one, enforced by `UNIQUE (assignment_id, idempotency_key)`. An assignment may buy eight resources at most, however much is authorized.

## Who bears the cost

The platform resource wallet pays the provider. The builder reimburses the **eligible actual cost** — not the quote, and not the ceiling — through one itemized payable whose recipient is that restricted wallet and never an operator. `UNIQUE (resource_purchase_id)` on `payables` is what makes a cost already reimbursed impossible to reimburse again: the database, not the code, forbids it.

| Outcome | Builder | Platform |
| --- | --- | --- |
| Usable, reconciled | Owes the actual cost | Records it as spent |
| Refused before settlement (4xx, 503) | Owes nothing | Spends nothing |
| Paid but undeliverable (`provision_failed`) | **Owes nothing** | Absorbs it |
| Authorization never settled | Owes nothing | Spends nothing |
| Settled above the authorized limit | Owes nothing yet | Reservation held for a person |

A purchase the platform could not deliver is absorbed deliberately: a provisioning failure is not completed testing, and passing it to the builder as one would charge for nothing. The money really did leave the wallet, so it is recorded as spent against the platform's own cap.

## Uncertainty, and why a commitment is retained

buy documents payments as final with no refunds, and its own guidance is not to retry `500 provision_failed` or `500 settle_uncertain`, because settlement may already have happened. So Trialoom never buys again to find out. An uncertain purchase is resolved by asking whether the transfer settled — the adapter's `resolve`, which is what `buy receipts --resolve` does against the token contract — and the provider's own answer is not the source of truth.

Until that resolves, the purchase **keeps its reservation**, and no release path can give it back (R07). `heldForResources` is consulted by every `releaseCommitment`, so an expired, released or decided assignment still holds what an unresolved purchase might cost. A purchase whose charge is undecided holds the whole ceiling it was authorized under; one already charged to the builder holds its known cost until reconciliation turns that into an accepted liability. Neither can be spent twice.

Reconciliation is the only place the platform's reserve becomes spend, which is what stops an unresolved purchase from being bought again against the same headroom.

## Spending is its own authority

Buying is the one operator action that spends, so it needs the long-lived credential and the new `resources:purchase` scope. A **run grant cannot reach the route at all**: the grant's routes are an allowlist of reading its own run and submitting evidence, so the credential that travels with the runner cannot spend, and a leaked grant cannot either. The operator console does not check that scope by default; a credential created in one click has no spending authority.

No scope names a wallet, a signer, a recipient or a transfer, and the payee comes from a quote the platform validated against the settlement token — never from the operator.

## What remains

- **No real purchase.** No resource wallet is configured, the live buy adapter is not written, and the default adapter refuses everything. The proof here is the application half against a recording fixture; VAL-03 and VAL-04 proved EIP-3009 settlement and recovery on a disposable local fork. VAL-04's remaining gate — provisioning one capped browser session, connecting a runner, exporting a trace, and reconciling a real receipt — is unchanged by this step.
- **The spike's quote observations have aged.** On 2026-10-28 the published buy documentation lists gateway `/v1/...` capabilities, Chainstack Celo RPC, Cencori and Google Cloud VMs; the browser-session route VAL-04 quoted on 2026-10-26 is no longer in that list. A fresh quote must be taken before any purchase, and the recorded SKUs are fixtures, not commitments.
- **Reconciliation is an adapter promise, not a chain read.** `resolve` is where a token-contract query belongs; nothing here reads a chain, verifies a receipt, or handles a reorg.
- **An unresolvable purchase needs a person.** It holds its reservation indefinitely, which is the point, but there is no incident queue, notification, or write-off path, and a settled cost above the authorized limit is recorded as uncertain with no way to resolve it in the product.
- **Operator-owned resources are out of scope entirely.** They are included in the operator's own quote, are never recorded here, and can never be reimbursed — which is how the PRD's "costs already covered in an assignment quote cannot also be reimbursed" is honoured, by having no path at all rather than a check.
- No cancellation-time rule of its own: authorized resources consumed before a cancellation stay chargeable because a reconciled cost is already an accepted liability, but nothing distinguishes them in the record.
- The platform's cap is global and raised only in the database. There is no per-campaign or per-builder resource limit, no balance or allowance check against the real wallet, and no fee on a reimbursement.
