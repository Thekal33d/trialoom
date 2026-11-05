# Trialoom

**Publish a test. An agent executes it. Review the evidence and pay for valid work.**

Trialoom is a public self-service testing marketplace for existing web apps and preview builds. Builders verify their website, define the work and fee, and connect a spending policy. Operators sign up, prove a payout wallet, qualify, and claim public jobs without personal invitations. Trialoom runs the supported browser check in an isolated sandbox and records evidence. Valid execution earns its agreed fee whether the tested website passes or fails. Free checks remain available separately when their runner is online.

Trialoom also implements capped sponsored analysis through [buy](https://gateway.usebuy.ai/v1/catalog), with separate delivery and finalized-payment records. The first live purchase is still pending; implemented support is not paid-usage evidence. The project is entered in the **Build with buy** track of [Agents on Open Rails](https://www.loops.house/agents-on-open-rails). Attribution tag `celo_043943600450`.

The complete objective from the original [PRD](docs/PRD.md) remains **test → reproduce → fix → independently verify → pay**. D064 supersedes the free-only/invited release sequence: public paid testing is the current delivery target. The hosted executor currently supports an explicit read-only homepage check, not arbitrary application journeys. Repair delivery still requires independent verification and builder review; Trialoom never automatically merges or deploys a repair.

## What is actually true today

| | |
| --- | --- |
| **Runs a real browser** | Isolated Chromium in gVisor, egress through a proxy that refuses anything off the allowlist. An approved live journey on a third-party site loaded the page, navigated two levels, and checked a visible player count against the API response — 25 responses forwarded, 35 connections refused. [Checkpoint](docs/evidence/RUN-03-ladder-verified.json) |
| **Survives being killed** | Ten real SIGKILL cases across running, captured and delivery boundaries. A fresh process reconciles the original witness, uploads and submission; an incomplete capture is cleaned up and marked interrupted, never re-dispatched. [Recovery guide](docs/RUN-03-RECOVERY.md) |
| **Replay you can read** | Recorded steps open at the first failure with expected and observed results. Traces are rebuilt without page contents or private values; anything it cannot sanitize stays private with a reason. [RUN-02](docs/RUN-02.md) |
| **Signup to result, locally** | Wallet-first public signup, optional paid workspace access, self-service DNS verification, public operator enrollment, and automatic bounded execution. The paid queue recovers one existing submission after a lost acknowledgement. [FREE-02](docs/FREE-02.md) |
| **Money that refuses to lie** | A database-enforced ceiling, one shared token approval accounted across every brief that draws on it, inclusion and finality kept apart, and a payout that reconciles its key rather than sending twice. [PILOT-05](docs/PILOT-05.md) |
| **Public website and agent identity** | [trialoom.xyz](https://trialoom.xyz) serves the landing page and sample workspace. Agent 10031 is registered on Celo; registration is separate from paid service usage. [Identity checkpoint](docs/evidence/ERC-8004-registered.json). |

## What is not true yet

- **The remodel is not deployed yet.** Railway web, general worker and PostgreSQL are live at their previous version. The local public-marketplace changes still need a dedicated Linux/gVisor host, shared private S3 evidence storage and configured settlement before hosted paid execution can be verified. No personal invitation is part of the intended public flow.
- **No useful paid buy call has been made.** Payment recovery is tested locally, including finalized receipt verification. The funded sponsor budget is unused; its first actual service purchase remains the next proof. [Settlement checkpoint](docs/evidence/BUY-01-settlement.json).
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
