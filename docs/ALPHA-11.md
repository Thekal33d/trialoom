# The end-to-end seeded campaign

Verified locally on 2026-10-28. This is ALPHA-11, the last alpha step: one repeatable command that drives a seeded campaign from publication to an owed payable and asserts every rule it passes. [Evidence](evidence/ALPHA-11.json) records the transcript, the artifacts and exact source hashes.

```sh
npm run loop
```

It runs against a disposable database and the **real server modules**, writes its transcript and the export to an ignored `artifacts/loop/<timestamp>/`, and exits non-zero on the first failed assertion. It is a check as much as a demonstration: nothing in it is narrated rather than executed.

## The fourteen phases

| Phase | What it proves |
| --- | --- |
| 1. Set up and publish | Invitation-only accounts, an authorized target, a pinned build, and one exact terms version offered with its budget |
| 2. Execute and report | Two operators prove payout wallets, qualify, claim, run against a revalidated target, and report the same failure, which confirms one defect from two independent reports |
| 3. Decide | A person accepts both executions and awards the discovery reward to the earliest complete report; the second is refused the reward and keeps its execution payment |
| 4. Owe | Two acceptances write four separate payables, each with its own operation key, and with no payment authority the amount is visibly blocked and still owed |
| 5. Settle | With an authority, submitted → included → finalized; the ledger moves only at finality, the approval records the spend rather than freeing it for the next brief, and what the transaction cost to send is recorded once against it as the platform's own cost |
| 6. One shared approval | Two policies on one wallet draw on one approval, so the second brief is refused with the uncommitted amount named while the first stands, and a reading below the commitments reports a shortfall that cancels nothing |
| 7. Crash after broadcast | One send and a reconciliation against the same key; the money is never sent twice |
| 8. Expired claim | A complete but lapsed attempt is fenced and its whole reservation returns |
| 9. Repair | A confirmed defect is quoted and approved, delivered through the gate, refused acceptance until an independent verifier confirms it, then accepted |
| 10. Resource | A capped purchase is reimbursed at its eligible actual cost, a retry returns the purchase it already started, and an uncertain purchase holds its reservation through a release |
| 11. Witnessed run | A brief demanding a witness refuses a grant that cannot provide one; the proxy's record and the agent's claim must agree, and a proxy allowing a forbidden origin is refused |
| 12. Instrumentation | Ten event topics are recorded, no payload carries a credential, and every target either reads or says why it cannot |
| 13. See and export | The queue names what is waiting, a reviewer reads the same queue, and the export's hash is verified from the file itself |
| 14. Account | Every ledger entry replays to the stored balances, and what is owed is stated |

Forty-four steps are recorded in `transcript.json` alongside the final accounting, the open payables by state, and the limits below.

## Release scenarios it exercises

| Scenario | How the loop shows it |
| --- | --- |
| R03 | The second report of a confirmed defect is refused the discovery reward with `DISCOVERY_ALREADY_AWARDED` and is still paid for its execution |
| R06 | A provider that takes the money and loses the answer is reconciled on the same operation key; exactly one send is recorded |
| R07 | An uncertain resource purchase is not bought again, and its authorized ceiling survives releasing the assignment |
| R11 | A repair cannot be accepted before an independent verifier confirms it; the attempt is refused with `VERIFICATION_PENDING` |
| R12 | A lapsed attempt is fenced with `ATTEMPT_CLOSED`, its run grant is retired, and its reservation returns to the campaign |

R01, R02, R05, R08, R09 and R10 are covered by the database checks rather than here; the loop is a sequence, not a replacement for them.

## What the loop cannot cross

Three honest boundaries, printed in the transcript's own `limits` and not papered over:

- **The evidence is produced by this harness, not by a hosted sandboxed runner.** Trialoom still neither hosts nor sandboxes execution, so the isolation profile in every submission is an attestation. The target revalidation it performs is real.
- **No funded payment authority is configured.** The truthful end state is phase 4: an owed, blocked payable with its reason visible. Phases 5 to 7 use a recording fixture to exercise inclusion, finality and crash recovery, and they are labelled as a fixture in the transcript. **No value moves on any network in this loop.** The live adapter is exercised separately, against a real policy on a disposable Celo fork, by `npm run payments:fork` — see [the payment authority and its limits](PILOT-05.md).
- **No resource wallet is configured.** The provider in phase 9 is a fixture and nothing was bought from buy.

Once payments complete in the loop, five of the eight pilot targets read a value and three say why they cannot — which is the instrumentation working rather than a claim about it.

Two further boundaries worth stating: the loop drives the server modules directly rather than HTTP, because the 50 browser checks already cover that surface and a sequence this long is more useful when it is deterministic; and it creates its own disposable database each run, so it proves repeatability of the sequence rather than of a long-lived installation.

## What this does not make true

ALPHA-11 completes the alpha backlog. It does not complete the product:

- The pilot gates are untouched. VAL-02 still needs an independent operator to reproduce the repair result, and VAL-04 still needs one capped browser session actually provisioned, connected, traced and reconciled against a real receipt.
- Nothing here is evidence of mainnet behaviour, eligibility for any event, or production readiness. The hackathon checklist is separate and unmet.
- The remaining platform gaps are unchanged and recorded in [STATUS.md](../memory/STATUS.md): a funded payment authority with a real Remesso adapter, a funded resource wallet with a real buy adapter and a chain read behind reconciliation, real runner isolation, a reviewed export path for archived traces, commissioned reproduction, verification as its own priced service, the PRD's information architecture, and an actioned escalation path.
