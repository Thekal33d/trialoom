# Payables, the outbox, and settlement

Verified locally on 2026-10-27. This is the ALPHA-08 foundation for FR13 and the payment half of FR14. It closes release scenario R08 and reproduces R06's recovery at the application level. **No funded payment authority is configured in this build**, so every payout is recorded, queued and then blocked with a visible reason. [Evidence](evidence/ALPHA-08.json) records checks and exact source hashes.

## One acceptance, one payment identity

An accepted decision writes its payables and enqueues their jobs **in the same transaction**. A payment therefore never exists without the acceptance behind it, and an acceptance never exists without its queued payment; a rolled back decision leaves neither.

Each payable fixes what it owes and to whom:

| Fixed at acceptance | Why |
| --- | --- |
| Recipient, token, chain, decimals | A later wallet change applies to future work, not to an existing payable |
| Exact amount and category | The amount owed is the amount decided, itemized for the ledger |
| Decision and assignment | Every payment traces to the record that authorized it |
| `operation_key` | The identity a retry reconciles, and the outbox dedupe key, so a repeated event is one job |

A database trigger refuses any rewrite of the key, amount, token, decision, kind, an approved recipient or a recorded hash, and refuses deletion outright. A payable accepted before the operator designated a payout wallet is recorded `blocked` with `no_payout_wallet` and binds that address once it exists — an empty recipient is filled in once, never replaced.

Operator payouts and platform fees are **separate transfers**. A fee waits for the operator work it rests on to reach finality, and a failing fee transfer leaves that finalized payment alone.

## Restart cannot pay twice

The worker sends only on a payable with no previous attempt. The attempt is committed before the network call, so every later attempt asks the provider to **confirm that same key** rather than sending again:

- A crash after broadcast leaves the payable `needs_reconciliation`; the next worker confirms the key and records the original hash. Nothing is sent a second time.
- `unknown` — the provider has no record of the key — is the one answer that makes sending again safe, and it is still sent under the **same** key. This matches the SDK's own rule that a new key may pay again only once the failure is certain.
- An error around the call is treated as uncertainty, never as failure.

The outbox gives at-most-once enqueueing, and a wait that is not a failure returns the job to the queue without consuming the attempts that protect against a genuinely failing handler. A provider that answers is such a wait: polling a payout from `submitted` through `included` does not count against the limit, which was a real defect until PILOT-05 found it — a chain whose `finalized` tag lagged more than four polls retired the job silently and left the payout stuck at `included`. Only a refusal spends an attempt, and exhaustion is recorded as `dead` rather than leaving a job that looks live and will never be claimed.

## Inclusion is not finality

`submitted` records a broadcast and its hash, `included` records a block, and `finalized` records verified finality — the Remesso documentation puts that at roughly 25–30 minutes. **Only finality moves money in the ledger**, from accepted to finalized, itemized by category so the entries still replay to the stored balances. A builder and an operator see the three states separately; a payout is called paid only at the last one.

Losing payment authority blocks the payout with a visible reason, keeps the debt, and pauses new claims on that campaign (R08).

## The provider boundary

`SettlementAdapter` is a two-method boundary: Trialoom owns the payable, the operation key and the state; an adapter owns signing and the network. The default adapter is `unconfigured`: it refuses every send with `payment_authority_unavailable` and reports every key as never started. That is the truthful state of this build — the amount is owed and recorded, and nothing pretends it was paid.

Checked live on 2026-10-27: the [Remesso production SDK guide](https://docs.remesso.xyz/docs/guides/production-sdk) (durable Postgres journals, `idempotencyKey`, `reconcile`, `recoverPending`, `needs_reconciliation`, shared locks for workers on one signing key) and the [agent payments guide](https://docs.remesso.xyz/docs/guides/agent-payments) (a policy budget is a shared token approval, not a per-policy total; the daily window is fixed, not rolling; a policy without recipients is open and can only be narrowed by revoking it). `remesso-sdk@0.3.0` is still the published version. Those facts shape this design; none of them is implemented against a funded wallet here.

## What remains

- **No real transfer has happened.** No wallet, policy, signer or fee recipient is configured, and the adapter that would call Remesso is not written. VAL-03 proved the recovery pattern on a disposable Celo fork; this step proves the application half against a recording fixture.
- No cross-campaign coordination of a shared wallet approval, no balance, allowance or policy validity check before publication or claim, and no on-chain verification of the declared authorization.
- No reorg handling: finality is whatever the adapter reports.
- A `needs_reconciliation` payable with an unknown outcome waits for a person. There is no incident queue, no notification, and no refund path — a refund would be a separate authorized transfer, not a reversal.
- Resource purchases were not in the ledger at this step, leaving FR14's resource column empty. [ALPHA-09](ALPHA-09.md) fills it: a reconciled purchase reclassifies its eligible cost and pays it as a `resource` payable through this same outbox.
- Workers run one at a time here. Several workers sharing one signing key need the SDK's shared journal and lock, which is not set up.
