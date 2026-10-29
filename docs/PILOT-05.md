# The funded payment authority and the shared approval

Verified locally on 2026-10-29. This is PILOT-05, the last of the three gates outside the alpha, and the last one that is code rather than money, recruitment or a deployment. [Evidence](evidence/PILOT-05.json) records the checks and exact source hashes.

Until now a payout was recorded, queued and then blocked, because no payment authority existed. Two things were missing: an adapter that can actually pay, and an account of what the payment authority can actually deliver — which turns out to be the harder half.

## Why a per-campaign budget proves nothing

Trialoom already reserves a campaign's maximum liability atomically against a ceiling the database enforces. That is a promise to operators, and it was treated as if it were also a statement about solvency. It is not.

On Celo a payment under a Remesso policy is drawn from a token approval the builder granted to the allowance contract. The pinned SDK's own type for creating a policy says the budget is

> "Added to your token approval for the allowance contract: the most this and your other policies for this token can ever spend together"

and the live guide is blunter: "that one approval is shared by all their policies for the token", and "a policy has no total of its own". Quoting a payment "reserves nothing: another payment can still use the balance, the daily budget or the allowance."

So two live briefs can each hold an authorized ceiling, each name their own policy, and be funded by a single approval only one of them can drain. Nothing in the per-campaign ledger notices. **This failure cannot appear in a local test with a recording adapter, because nothing there is shared.** It appears the first time a builder has two briefs open against a funded wallet — which is the pilot.

## The approval is modelled as the contended object

`payment_approvals` is keyed by the tuple that identifies an approval on chain — chain, token, payer — not by the workspace, the policy or the authority that references it. A `payment_authorities` row is a workspace's named, revocable handle on one of them: which policy signs, as which agent, under what label.

Everything that can spend commits against that one row, and one table check does the work:

```sql
CONSTRAINT payment_approval_ceiling CHECK (committed_units <= declared_units)
```

Four moves, each an appended entry so the row replays from its own history:

| Move | When | Effect |
| --- | --- | --- |
| `declare` | The builder states the approval they granted | Raises the remainder |
| `commit` | A campaign's budget is authorized | Reserves it against every other brief |
| `settle` | A payout reaches finality | Spend, not release: the remainder falls with it |
| `release` | A brief is cancelled or completed | Returns only what no payable still needs |

Three consequences are worth stating because each one was a decision:

**A second authority on the same wallet describes the approval rather than adding to it.** Declaring is setting a number, not adding one; a handle that states ten when ten is already declared states the same ten. Adding would have recreated the exact bug.

**A declaration can only rise.** An approval that has really shrunk is not a record to edit — it is a shortfall, which shows up when the approval is read. Reducing it means revoking on chain and verifying.

**Settlement consumes the approval.** Finality moves the reservation to `settled` and lowers the declared remainder, mirroring an ERC-20 approval being drawn, so the stored remainder stays directly comparable with what the chain reports.

A close returns a brief's unspendable remainder, computed as what it committed less what it settled less **everything still owed on a payable that has not finalized or been cancelled**. Releasing down to that and no further is what keeps an accepted obligation funded after the brief is shut. Because it is derived from the entries, closing twice releases nothing the second time.

## Declaration, then verification

A declaration is the builder's claim. `verifyAuthority` reads the policy through a provider and records what it said as an immutable observation — allowance, balance, whether the policy is active, and what was committed at the moment of reading.

The solvency test is `min(allowance, balance) >= committed`: an allowance nobody can fund pays nothing, so the smaller of the two is what the approval can reach. Falling short marks the approval `short`, and **nothing is cancelled by the bad news**. A spending authorization was never escrow; withdrawing it cannot cancel a debt. The builder is told how far short it is, and those payouts will block as owed.

With no provider configured, verification **refuses** rather than recording a reading nobody took. An unverified declaration stays visibly unverified.

## The adapter

`src/server/remesso.ts` implements the existing `SettlementAdapter` against `remesso-sdk`. Trialoom keeps the payable, the operation key, the states and the approval accounting; the adapter signs and asks the network.

- A payable carries the authority that was committed for it, so the adapter never chooses a funding source. It refuses a payable with no authority rather than defaulting, because the policy and payer decide whose money moves.
- `maxDebit` is the recipient's amount exactly. A protocol fee appearing later refuses the send instead of spending more of the builder's approval than was reserved.
- A send the SDK reports as `confirmed` means a receipt was seen, which is **inclusion, not finality**. It is mapped to `included`, so finality is only ever read back, and only finality moves the ledger.
- `confirm` calls `reconcile`, which continues a started payment and never starts a new one. A key the provider has no record of comes back `unknown`, which is the only state in which sending again under that key is safe.
- `needs_reconciliation` maps to `uncertain`, which holds the key for the next attempt rather than sending again.

### The journals live in Trialoom's database

The SDK's `remesso-sdk/postgres` storage keeps its payment journals, its signer lock and its nonce floor in PostgreSQL; its `PostgresClient` is declared as a structural subset of postgres.js, so `pg` is bridged to it rather than adding a second driver and a second pool. The SDK is explicit about why this matters: with per-process journals, two workers would each keep their own keys and a retry on the other worker would pay a second time. Trialoom's worker is already multi-process, so this is the correct shape rather than a precaution.

`remesso-sdk` moved from a development dependency to a runtime one. It was only a spike tool before; the API route now imports the adapter at module load, so a production install built with `--omit=dev` would have failed to start. `fflate` needed the same move when exports arrived.

One pg client runs a single statement at a time, while postgres.js allows a reserved connection to be called freely, so queries on one connection are chained. On the connection holding the signer's session advisory lock, overlapping them would be a correctness problem rather than a driver warning.

## What it costs to send

Remesso's fees guide is explicit that **the agent's own key pays** for each agent payment, around 85,000 gas, and that the executor does not cover it. The same page settles a second question: "Policy payments carry no fee. What an agent pays is what arrives." So capping `maxDebit` at the recipient's amount is right, and gas is a separate, platform-funded cost.

`payout_gas` records one reading per transaction, taken from the receipt rather than estimated: the gas used, the price it was actually paid at, their product, and the currency. `CHECK (cost_units = gas_used * effective_price)` means the cost is not a third number someone can disagree with, and `UNIQUE (transaction_hash)` is what lets the adapter report the same receipt on every poll without ever counting it twice. The row is immutable, because a receipt reading is evidence.

**Gas never touches the campaign ledger, the builder's liability or the token approval.** The approval funds the transfer, not its gas; the agent's own balance pays that. The fork check asserts exactly this: the agent's CELO balance falls by precisely the recorded cost, and the payee's USDC rises by precisely the amount owed.

### Currency is the hard part

Gas is paid in CELO unless the transaction names a Celo fee currency, in which case the price and therefore the cost are denominated in that token — the SDK picks CELO when the agent holds at least twice the estimate and otherwise falls back to the policy's token. So a cost in CELO and a fee collected in USDC are **not addable**, and this product has no exchange rate.

The readings are therefore grouped by currency and never converted. Each group reports whether it is denominated in the currency the platform collects its fee in, and only that group could ever be set against revenue. A fee currency this build does not recognise is still recorded, with no decimals, so its cost is visible and openly unconvertible rather than quietly dropped or shifted by a guessed exponent.

This closes one of the economics target's holes and does not make it measurable. It now says "payout gas is recorded but not convertible: 2 transaction(s) cost 0.00085 CELO, and no CELO/USDC rate exists here" instead of "payout gas is not recorded", and it still refuses to print a margin, because platform compute, verification cost, human review and refunds remain unrecorded.

## The approval is re-read on a timer

A declaration believed until somebody presses a button is not an account of what can be paid. Registering an authority now puts its own recurring read on the same outbox every other durable job uses — leased, fenced, visible — in the same transaction that creates it, so an approval cannot exist without something checking on it. Each turn re-reads the approval and **reschedules itself**, rather than depending on a cron the deployment may not have. Revoking the authority ends the job instead of leaving it spinning.

Two facts about the clock, in the same spirit as the review target: an approval is re-read every **6 hours**, and a reading older than **24 hours** is stale. Neither decides anything.

**A read that failed is not a reading.** Without that distinction an RPC outage would be indistinguishable from an approval that is genuinely short, and the quiet version of that mistake is the dangerous one — the record would keep reporting `verified` from a reading taken days ago. So the attempt is recorded before the call, a failure is kept as an error on the approval without touching the previous reading or the state, and a later success clears it. The queue reports four separate things: an approval nobody has read, one whose last read failed, one whose reading has gone stale, and one that does not cover what it is funding.

A failed read is treated as a **wait**, not a failure. A recurring job that died after five bad answers would stop checking exactly when checking matters most, so the retry is sooner than the normal interval and the attempts counter is not spent. The error being surfaced in the queue is what stops a permanently broken reader from being silent.

### What a reading is allowed to do

| Reading | Effect |
| --- | --- |
| The policy is inactive on chain | New claims stop on every brief it funds |
| The approval is short of its commitments | Reported, and nothing else |
| The read failed | Reported as unread; the previous reading stands |

The first is a **fact the chain reported** — the same fact a failed payout would have reported later — so learning it early stops new work exactly as losing the authority does, and erases nothing already accepted. The second is a **moving number** the builder can top up at any moment; pausing live work on it would turn a temporary balance into a stopped campaign. That asymmetry is the whole of the policy.

The worker now also carries the live adapter, which it did not when PILOT-05 landed: `configuredPayments` was reached only by the verification route, so nothing would ever have paid through the adapter in production. It says which adapter it has at startup, because absence is the state of this build and should not look like a working payment path that happens to pay nobody.

## Telling somebody

A condition the platform records and nobody is told about is only a notification if the builder happens to open the queue. So the three conditions the recurring read can find now leave the platform.

Two properties carry the design.

**A notice is raised when a condition becomes true and resolved when it stops.** A partial unique index — one open notice per topic and subject — is the deduplication, in the database rather than in application logic, so two concurrent readers cannot both raise it and a read running every six hours cannot announce the same shortfall four times a day. Resolution is silence: the notice closes with the reason, and a condition that returns is news again.

**A notice says whether anyone was told.** A workspace with nowhere to be told, an endpoint that refused, and a condition that resolved before delivery are three separately recorded outcomes rather than one silence: `undeliverable`, `failed`, `suppressed`. Every attempt is kept, so "nobody was told" and "we tried four times and the endpoint answered 500" are different answers. A destination that is down is not a failing handler, so retrying does not spend the attempts that would retire the job — the undelivered notice sitting in the queue is the thing worth seeing.

Suppression is worth stating as a choice: stale news is worse than none, because a builder told about a shortfall that has since cleared goes looking for something that is not there.

### The destination

A workspace registers one HTTPS URL, held to **the same admission rules as a test target** — HTTPS, no credentials or query in the URL, and an address that is not in private space — because a notice destination is a URL the platform will call on a schedule, which is exactly the shape of request an attacker would like aimed at private space. One live destination per workspace, so "was anyone told?" has one answer.

Each delivery is one signed POST: `X-Trialoom-Timestamp` and `X-Trialoom-Signature`, the latter `sha256=` plus HMAC-SHA256 over `timestamp.body`, keyed with a secret shown once at registration. Signing over the timestamp as well as the body means a captured body cannot be replayed under a new one. Nothing is read from the response beyond its status, and redirects are refused: a receiver that could answer back would be a way into the platform.

The signing secret is **stored rather than digested**, which is the opposite of how a runner host's credential is kept. The asymmetry is inherent — a host presents its credential and the platform only has to recognise it, while here the platform has to present a signature, so it needs the key. It is never returned after registration, never selected by a read path, and never travels in a notice.

**Nothing that leaves the platform carries a credential.** The body is composed by the platform from its own records — no operator prose reaches a destination the platform does not control — and the detail column is held to `event_payload_is_clean`, the same recursive guard the event stream uses, so a key, grant or token is refused at any depth by the table rather than by a careful caller.

| Condition | Raised as | Effect on the work |
| --- | --- | --- |
| The approval is short of its commitments | `authority.short` | None |
| The policy is inactive on chain | `authority.inactive` | New claims had already stopped |
| The approval could not be read | `authority.unreadable` | None |

A notice decides nothing. It is an account of a condition the platform already holds, and no obligation is cancelled and no payment blocked because one was or was not delivered.

## What the fork check establishes

`npm run payments:fork` drives the product's own path against deployed contract code on a disposable Anvil fork of Celo that the script starts and stops. Fourteen checks pass:

a real policy is created by the payer's own wallet; the reader reads that live approval and balance and marks the authority verified; a brief publishes against it; an accepted decision owes a payable bound to the authority and to the operator's proven payout wallet; the worker settles it through the live adapter from `included` to `finalized`; **exactly the owed amount reaches the payee**, carried by **one** signed transaction from the agent; the approval records the spend and its remainder falls; a re-read of the chain agrees the live approval fell by exactly what was paid; the same operation key sent again reports the first payment and moves nothing; a key the provider never saw comes back `unknown`; a policy revoked on chain reads as `short` while the commitment stands; and revoking the authority pauses the brief without erasing the record.

That is the first time value has moved through Trialoom's own code path. **It is not mainnet evidence.** Every transaction goes to loopback, the signing keys are the public Anvil fixture accounts, and the script refuses to run with a real key configured in the environment. Anvil reports `finalized` sixty-four blocks behind `latest`, so the check mines past that distance; real finality timing is unmeasured.

## What remains

- **No mainnet transaction, and no funded wallet.** Nothing here establishes production behaviour, gas cost, real finality timing, or event eligibility.
- **A CELO gas cost cannot be set against USDC revenue.** Recording it was the achievable half; converting it needs a price feed, which would be a new external dependency and a new thing to be wrong about. Until there is one, the economics target reports the two separately and prints no margin.
- **Only payout gas is recorded.** A resource purchase is also sent by a platform wallet and also costs gas; nothing records that, because no live resource adapter exists to read a receipt from. The PRD's economics definition names payout gas specifically, so this is a gap rather than a missed requirement.
- **A receipt that cannot be read is simply not recorded.** The reader never throws into the settlement path — losing a cost record is far better than failing a payment that already settled — so a run of RPC failures at the moment of finality leaves gas unrecorded for that transaction with nothing to retry it, since the job completes at finality.
- **The re-read interval is fixed in code, not per workspace.** Six hours suits a pilot; a busy workspace drawing on a shared wallet would want minutes, and nothing lets it ask for that.
- **A notice goes to a URL, not to a person.** There is still no email and no platform-reviewer channel, so a workspace that registers no destination is back to looking at the queue — the difference is that the platform now records that nobody was told. Review escalation could use this channel and does not yet; that belongs with PILOT-01.
- **No reminders.** An open notice is delivered once and then sits open until the condition clears. A shortfall nobody acts on for a week is not raised again.
- **The agent key comes from the environment.** There is no key management, no rotation, and no hardware signer. A compromised process can spend the whole approval up to the policy's per-payment and per-day caps.
- **One signer.** The SDK's coordinator serializes signing across workers, which is correct, but it also means payout throughput is one transaction at a time per agent address.
- **Nothing reconciles on its own.** `recoverPending` exists in the SDK and is not wired to a schedule; recovery happens when the outbox retries a payable, which is adequate but not the provider's own recommendation.
- **No webhook or indexer.** Payment state is pulled when a job runs. Remesso's signed webhooks and payment-events feed would report inclusion without waiting for a retry.
- **The platform's own recipients are still unconfigured**, so platform fees and resource reimbursements block for a missing recipient rather than for a missing authority. That is a funding decision, not code.
- **An authority is fixed at a brief's first publication.** That is deliberate — commitments would otherwise split across two approvals — but it means moving a live brief to another wallet is not possible without closing it.
- `0.3.1` of the SDK was published on 2026-10-28 and is not adopted here; the pinned `0.3.0` is what the recorded spike hashes and this check were run against.
