# Ledger, claims, leases, and cancellation

Verified locally on 2026-10-27. This is the ALPHA-04 foundation for FR03, FR06, FR14, and FR15, and it closes release scenarios R01, R09, and R12 at the application level. Acceptance decisions, evidence, and settlement remain unimplemented. [Evidence](evidence/ALPHA-04.json) records checks and exact source hashes.

## The invariant

Money uses `numeric(78,0)` columns and `BigInt` arithmetic; no amount passes through a float. One `campaign_accounts` row per campaign holds the ceiling, outstanding commitments, accepted liabilities, and finalized spend, and carries the PRD invariant as a table check:

```sql
CHECK (finalized_units + accepted_units + committed_units <= ceiling_units)
```

That row is the single lock point. Every reservation takes `FOR UPDATE` on it first, so claims on one campaign serialize and no application path — including a direct `UPDATE` — can commit beyond the authorized ceiling. `ledger_entries` is append-only and immutable; replaying it must reproduce the stored balances, and the accounting view reports that `reconciled` result rather than assuming it.

| Movement | Effect |
| --- | --- |
| `authorize` | Raises the ceiling from an append-only `budget_authorizations` row. A ceiling never falls |
| `commit` | Reserves one assignment's maximum liability, itemized by category |
| `release` | Returns an unused reservation |
| `reclassify` | Moves part of a commitment to an accepted liability in **one** entry, so the same amount cannot be counted twice |
| `finalize` | Moves an accepted liability to finalized spend. ALPHA-08 owns the transfer |

The maximum liability for one assignment is `price + discovery cap + resource allowance + fee`, where the platform fee rounds **up**, so a reservation is never short of the charge it must cover. Under the pilot's example terms this reserves 3.80 USDC for a 2.00 USDC execution price.

Authorized spending is **not escrow**. The campaign records the builder's declared authorization reference; this step does not verify it on chain, and an accepted liability survives its loss.

## Publication

Publishing offers **one exact terms version**. `campaigns.published_terms_id` is a foreign key to `(campaign_id, id)` in `terms_versions`, and publication re-runs the funding check: the ceiling, less liabilities already accepted or finalized, must cover every offered slot at that version's maximum liability. A later revision is allowed (FR03) but changes nothing until the owner republishes and the check runs again; assignments already claimed keep the version they pinned.

Publication, further authorization, pausing, and cancelling are **owner-only**, matching the ALPHA-02 rule that payment authority belongs to the workspace owner.

| Status | New claims | Live assignments |
| --- | --- | --- |
| `draft` | Not offered at all | None possible |
| `open` | Allowed | Running |
| `paused` | Stopped; the owner can reopen | Continue under their pinned terms |
| `draining` | Stopped | Continue |
| `cancelled` | Stopped permanently | Continue under their pinned terms; accepted obligations stay owed |

## Claims and the attempt fence

A claim takes the campaign account lock, expires anything lapsed, then checks campaign status, workspace admission, service eligibility from ALPHA-03, the delivery deadline, the lifetime slot cap, and the concurrent cap. It re-reads the **published** terms version under that lock, never `latest_version`, and writes an assignment whose composite foreign keys make the pinned `(campaign, terms version, build)` triple structurally consistent. The reservation is committed in the same transaction, and a partial unique index allows one live assignment per operator per campaign.

Each assignment carries an `attempt_token` returned once to the claiming agent. Every operator action matches that token against the live attempt and a lease that has not lapsed:

- A lease defaults to 15 minutes, renews through `heartbeat`, and never extends past the delivery deadline.
- Expiry sets the assignment to `expired`, returns its whole reservation, and frees the slot. The sweep runs in the worker every 30 seconds and inline on every operator action, so a lapsed attempt is fenced even if the worker is down.
- A retired token is refused with `STALE_ATTEMPT` or `ATTEMPT_CLOSED`, however long its runner kept going (R12). A later claim is a **new** assignment with a new token.

Claims are idempotent per operator through the ALPHA-03 `Idempotency-Key` path, and the reservation commits or rolls back with that key: a failed claim leaves no assignment and no committed funds.

## Agent and builder surfaces

Two scopes were added to the credential allowlist, `assignments:read` and `assignments:claim`. **No scope can still move money or sign a payout.** No route accepted work in this step; ALPHA-06 added that as a decision recorded by a person, and an operator scope still cannot authorize payment.

| Route | Purpose |
| --- | --- |
| `GET /api/agent/v1/work` | Open campaigns with slots, remaining budget, and the exact terms version a claim pins |
| `POST /api/agent/v1/assignments` | Claim; requires `Idempotency-Key` |
| `POST /api/agent/v1/assignments/:id/heartbeat` | Renew the lease with the attempt token |
| `POST /api/agent/v1/assignments/:id/release` | Return the claim and its reservation |
| `GET /api/agent/v1/assignments` | The operator's own assignments |
| `POST .../campaigns/:id/publication` | Owner publishes one terms version against a funding check |
| `POST .../campaigns/:id/budget` | Owner authorizes more budget |
| `POST .../campaigns/:id/status` | Owner pauses, reopens, drains, or cancels |
| `GET .../campaigns/:id/ledger` | FR14 accounting, entries, and assignments; reviewer reads are audited |

The builder's accounting view never contains an operator's attempt token.

## What this step deliberately does not do

Acceptance and rejection were implemented here as **ledger primitives only**, reachable from no HTTP route, because accepting work needs the evidence ingestion of ALPHA-05 and the recorded decision of ALPHA-06. [ALPHA-06](ALPHA-06.md) wired them to decisions that carry the criteria, reason, evidence references and actor FR12 requires; payouts ([ALPHA-08](ALPHA-08.md)) and resource reimbursement ([ALPHA-09](ALPHA-09.md)) have since been built on the same primitives. In this step an assignment ended only by release, expiry, or campaign cancellation.

Also still open: campaign completion when obligations resolve, automatic pausing when payment authority disappears (R08), appeals, cleanup of expired rows, and any on-chain verification of the declared spending authorization.

## Verification

The database suite covers fee rounding, underfunded publication, owner-only money actions, a revision that does not change the live offer, pinned terms and build on a claim, the itemized reservation, concurrent last-slot claims admitting exactly one operator, the ceiling as a database invariant under a forced `UPDATE`, budget exhaustion and later authorization, unqualified and unadmitted operators, lease renewal inside the deadline, expiry fencing a live runner, release returning a reservation exactly once, reclassification that releases the remainder and refuses a second bite, settlement that keeps the total constant, cancellation that drains live work while preserving an accepted obligation across a revoked authorization, pause and reopen, the audited reviewer read, and a rolled-back claim leaving no reservation.

Browser checks publish, pause, reopen, and cancel through the interface and read the accounting; the operator journey claims the published campaign over real HTTP, retries the claim idempotently, renews the lease, is refused under a stale token, and releases it while the builder watches the reservation return.
