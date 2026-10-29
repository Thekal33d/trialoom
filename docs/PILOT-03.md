# Runner isolation and the egress witness

Verified locally on 2026-10-29. This is PILOT-03, the first of the three gates outside the application that stand between the alpha and an invited pilot. It replaces one attestation with a verification. [Evidence](evidence/PILOT-03.json) records checks and exact source hashes.

## The problem this solves

Until now, isolation was the agent's word about itself. A submission declared `isolation: { freshBrowserContext: true, … }` and the origins it reached, and the platform checked those declarations against what it had issued. Both came from the same party — the one being constrained. An agent could reach anything and simply not mention it.

Target admission was already real: DNS is re-resolved, every redirect hop is revalidated against the approved origin, and the exposed revision is rechecked before a grant is issued. What was missing was any constraint *during* the run.

## What changed: the witness

Egress is now reported by the **proxy**, not the agent, and the two are compared.

A **runner host** registers under a written contract and gets its own credential. That credential is the whole point: it is held by the host, never injected into the sandbox, so an agent that has been taken over cannot write its own alibi. A host reads the allowlist its proxy must enforce from Trialoom — not from the runner it is constraining — and reports what it allowed and denied while the run is open.

At ingestion the platform compares the two accounts:

| Disagreement | What it means | Result |
| --- | --- | --- |
| The agent claims an origin the proxy never saw | The evidence does not describe this run | `EGRESS_UNWITNESSED` |
| The proxy saw an origin the agent did not declare | The run concealed traffic | `EGRESS_CONCEALED` |
| A witnessed run produced no witness at all | The promise was worth nothing | `EGRESS_UNWITNESSED` |
| The proxy reports *allowing* an origin the manifest forbids | That proxy is not enforcing | `EGRESS_NOT_ENFORCED` |

Denied attempts are kept beside the evidence: a run that tried to leave its allowlist and was stopped is a fact a builder should see, not a line in a log the operator controls.

## Isolation is a property of the run

Rather than pretend enforcement exists everywhere, the gap is now explicit in the data model. A run has a level, decided when the grant is issued by binding a registered host:

- **`attested`** — the agent's own word. What every run before this was, and all an unenforced host can honestly offer.
- **`witnessed`** — a registered host with a sandbox, an ephemeral filesystem and an enforcing proxy that reports egress itself.

Terms carry a `minimumIsolation`, chosen in the terms form, and hosts are admitted under Workspace access — because admitting one says where this workspace's customer code may run, which is an access decision. A brief that requires `witnessed` refuses to issue a grant with no host (`ISOLATION_REQUIRED`) or with a host that only attests (`ISOLATION_INSUFFICIENT`); the check runs when the grant is issued, not when the slot is claimed. A brief written before this existed requires `attested`, which is what it meant. **A pilot campaign requires `witnessed`; the local harness stays `attested`.**

A table check refuses a host that claims the witnessed level without declaring a sandbox, an ephemeral filesystem and an enforcing proxy — so an incoherent claim cannot exist in the database to be trusted later.

Only a workspace owner registers or revokes a host, because a host decides where customer code runs. Revoking one stops new runs naming it and invalidates its credential; runs it already witnessed keep their record, because what it saw still happened.

## The host contract

Published at `GET /api/host/v1/contract` and in every run manifest, so the runner and the builder read the same terms. Version `runner-host-v1` requires a conforming host to: sandbox each run away from the host kernel; give it an ephemeral filesystem and a fresh browser profile and destroy both; inject only the run grant and that run's fixture credentials, never the host credential or a payout key; allow **no network path out except the egress proxy**; report what the proxy allowed and denied under the host credential; and enforce the published wall clock, memory, process and artifact limits.

The contract also states, in the same document, what the platform verifies itself and **what is still only asserted**. That third list is the honest part:

- that the sandbox exists and is what the host says it is,
- that the filesystem and browser profile were really fresh,
- that the proxy was the only network path rather than one of several.

## The reference proxy

`runners/egress-proxy.ts` implements the enforcing half: it denies every origin outside the allowlist, opens a CONNECT tunnel only for an admitted one, counts allowed and denied requests per origin, and reports batches to Trialoom under the host credential. A CONNECT tunnel carries a host and port and never a path, so an enforced boundary constrains **origins** — which is exactly what the manifest allowlist names.

It is a reference that makes the protocol testable, not the production host. The sandbox around it, making it the only route out, and the resource caps are the host operator's responsibility.

## What this does not make true

**Trialoom still does not run the host.** Registration is an *accountability* boundary, not a cryptographic one: a host an operator controls can still misreport. What registration buys is a named party whose access can be revoked, a declared contract their evidence is held against, and a second credential an owned agent does not hold. Enforcement becomes a guarantee only when the platform runs the hosts — and when it does, nothing in the product changes except who registers them.

- **The sandbox is unverified.** No attestation, no measured boot, no image digest. A host says `gvisor` and the platform records that it said so.
- **Concealment is unreachable today.** A run manifest publishes exactly one allowed origin, so the agent's claim set cannot exceed the witness's. The rule is implemented and checked directly, and becomes reachable the moment an allowlist names more than one origin — a fixture host or an identity provider.
- **Nothing rate-limits a lying host.** A host can report plausible traffic for a run it never executed. The comparison catches disagreement with the *agent*, not collusion between an operator and their own host.
- **Credential and resource isolation are still contract text.** The platform does not verify that fixture credentials were scoped, that limits were enforced, or that the filesystem was destroyed.
- **No host-side enforcement of the time budget.** Wall clock is still checked after the fact at ingestion.
- The reference proxy does not inspect TLS, so it cannot constrain paths or detect tunnelling over an allowed origin.

The remaining two gates are unchanged: a funded payment authority, and instrumentation of the PRD's events and metrics.
