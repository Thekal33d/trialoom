# Trialoom

**You authorize a preview URL. Trialoom tests it in a sandbox and shows you what it saw.**

A builder signs up, authorizes a web app they control, and asks for a bounded browser test. Trialoom runs it in an isolated browser whose only route out is a proxy that denies every origin outside the run's allowlist, then returns the observed results, the findings, and a recorded replay you can step through. The first release is a **public free beta**: no wallet, no deposit, no spending approval.

Trialoom pays for services it does not own — it sponsors an external explanation of a test result through [buy](https://gateway.usebuy.ai/v1/catalog) — which is why it is entered in the **Build with buy** track of [Agents on Open Rails](https://www.loops.house/agents-on-open-rails). Attribution tag `celo_043943600450`.

The longer objective, from the original [PRD](docs/PRD.md), is the complete loop: **test → reproduce → fix → independently verify → pay**. The marketplace half of that is built and exercised locally; the free beta is the part being released first ([D049](docs/FREE-BETA.md)).

## What is actually true today

| | |
| --- | --- |
| **Runs a real browser** | Isolated Chromium in gVisor, egress through a proxy that refuses anything off the allowlist. An approved live journey on a third-party site loaded the page, navigated two levels, and checked a visible player count against the API response — 25 responses forwarded, 35 connections refused. [Checkpoint](docs/evidence/RUN-03-ladder-verified.json) |
| **Survives being killed** | Ten real SIGKILL cases across running, captured and delivery boundaries. A fresh process reconciles the original witness, uploads and submission; an incomplete capture is cleaned up and marked interrupted, never re-dispatched. [Recovery guide](docs/RUN-03-RECOVERY.md) |
| **Replay you can read** | Recorded steps open at the first failure with expected and observed results. Traces are rebuilt without page contents or private values; anything it cannot sanitize stays private with a reason. [RUN-02](docs/RUN-02.md) |
| **Signup to result, locally** | Public email-first signup, a free workspace, atomic per-account and per-origin quotas, and an automatic runner. [FREE-02](docs/FREE-02.md) |
| **Money that refuses to lie** | A database-enforced ceiling, one shared token approval accounted across every brief that draws on it, inclusion and finality kept apart, and a payout that reconciles its key rather than sending twice. [PILOT-05](docs/PILOT-05.md) |

## What is not true yet

- **Nothing is deployed and no domain exists.** Everything above runs locally.
- **No mainnet transaction has ever been made.** Payment recovery is proven on a disposable Celo fork, and the live adapter has moved USDC only there.
- **No paid `buy` output exists.** The provider seam is verified and report inputs are bound; no purchase has been made. [BUY-01](docs/BUY-01.md)
- **No ERC-8004 identity is registered.** The registry address is verified and the registration file is drafted. [ERC-8004](docs/ERC-8004.md)
- **No independent operator** has reproduced a repair, so that gate stays open.

Claims in this repository are meant to be checkable. Each one links to a dated checkpoint, and where an input does not exist the record says so instead of reporting a number.

## Run it

With Node 24 and Docker running:

```sh
npm ci --ignore-scripts
npm run setup:local
npm run db:up
npm run db:migrate
npm run dev
```

Then pick one:

```sh
npm run playground      # a signed-in practice workspace with a seeded bug
npm run browser:demo    # drive a real Chromium test and open its result
npm run loop            # the whole marketplace loop, asserted, in 44 steps
```

`npm run loop` drives one seeded campaign from publication to a finalized payout against a disposable database and the real server modules, and exits non-zero on the first failed assertion — it is a check as much as a demonstration. [Try Trialoom locally](docs/TRY-TRIALOOM.md) is the guided version.

## Checks

```sh
npm run check      # lint, strict types, capability checks
npm run test:db    # database behaviour against a disposable database
npm run test:e2e   # desktop and mobile browser checks, with accessibility scans
```

`npm run payments:fork` additionally drives a real payable through the live Remesso adapter against a disposable Anvil fork of Celo: a real policy, exactly the owed amount reaching the payee in one signed transaction, and the gas it cost read from the receipt. It refuses to run with a real signing key in the environment.

## Where things are written down

Current state is [memory/STATUS.md](memory/STATUS.md); history is [memory/BUILD_LOG.md](memory/BUILD_LOG.md); accepted choices are [memory/DECISIONS.md](memory/DECISIONS.md). The [backlog](docs/BACKLOG.md) carries work IDs and acceptance conditions, the [roadmap](docs/ROADMAP.md) the milestones, the [validation register](docs/VALIDATION.md) the PRD's release scenarios, and [docs/evidence/](docs/evidence/) the dated checkpoints with source hashes. [docs/HACKATHON.md](docs/HACKATHON.md) records the event requirements as verified against the live source, with the date of each reading.

[AGENTS.md](AGENTS.md) is the working protocol: finish a coherent step, run its checks, update the tracking files, commit that step, and keep proposed work distinct from verified behaviour.
