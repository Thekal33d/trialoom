# Trialoom

**Test. Fix. Ship.**

Trialoom is being built as a marketplace where builders buy browser testing, reproducible bug reports, and independently verified repairs from agent operators. The first product milestone is one complete **test → reproduce → fix → verify → pay** loop for an existing web application.

The project is being developed with the Celo agentic hackathon in mind. USDC on Celo and Remesso are the PRD's proposed operator settlement path; buy is a candidate provider for paid execution resources. Integration behavior still needs validation.

## Start here

| File | Purpose |
| --- | --- |
| [Project memory](memory/PROJECT.md) | Durable product context, constraints, and user preferences |
| [Current status](memory/STATUS.md) | What exists, current milestone, blockers, and the next action |
| [Decisions](memory/DECISIONS.md) | Accepted choices, proposals, and unresolved questions |
| [Build log](memory/BUILD_LOG.md) | Dated work history and validation evidence |
| [Product requirements](docs/PRD.md) | Original user-supplied PRD, preserved verbatim |
| [Roadmap](docs/ROADMAP.md) | Milestones and exit gates |
| [Development guide](docs/DEVELOPMENT.md) | Local setup, commands, checks, and scaffold boundaries |
| [Architecture](docs/ARCHITECTURE.md) | Selected stack, process/data boundaries, and implementation gates |
| [Backlog](docs/BACKLOG.md) | Work IDs, dependencies, status, acceptance conditions |
| [Hackathon alignment](docs/HACKATHON.md) | Dated requirements, proposed track, evidence checklist |
| [Validation register](docs/VALIDATION.md) | Capability experiments and all twelve PRD release scenarios |
| [Agent instructions](AGENTS.md) | Working and commit protocol for future coding sessions |
| [Claude entry point](CLAUDE.md) | Loads the shared agent instructions |

The local [browser/evidence experiment](spikes/browser-evidence/README.md) reproduces a seeded invitation defect twice, exports sanitized traces, and verifies a regression repair. The [Remesso experiment](spikes/payments/README.md) proves USDC policy payments and crash recovery on a local Celo fork. The Next.js application now has [invited accounts, workspace roles, authorized projects, pinned builds, and immutable draft terms](docs/ALPHA-02.md) plus [operator connection and qualification](docs/ALPHA-03.md), a [campaign ledger with atomic claims and leases](docs/ALPHA-04.md), [scoped run grants with evidence ingestion](docs/ALPHA-05.md), [clustered findings with recorded decisions](docs/ALPHA-06.md), [a quoted and independently verified repair workflow](docs/ALPHA-07.md), [payables settled through an idempotent outbox](docs/ALPHA-08.md), [capped resource purchases reimbursed at their eligible cost](docs/ALPHA-09.md), [exports plus a queue of what is waiting](docs/ALPHA-10.md), [one command that drives the whole loop](docs/ALPHA-11.md), and [instrumentation of the pilot's own decision targets](docs/PILOT-04.md), backed by PostgreSQL. No funded payment authority and no resource wallet are configured, so accepted work is recorded as owed, every payout is blocked with a visible reason, and no resource has been bought from a real provider; Trialoom does not yet run the sandboxed runner host, though [egress is witnessed by a registered host's proxy rather than reported by the agent](docs/PILOT-03.md); it issues no repository access and never merges or deploys a repair, and production infrastructure and provider integrations remain pending.

## Run the application

For fresh evidence from an actual browser execution, follow [the real browser walkthrough](docs/RUN-01.md): `npm run browser:demo` tests the owned invitation app and opens its newly submitted result in Trialoom for review.

For a prepared hands-on sample, follow [Try Trialoom locally](docs/TRY-TRIALOOM.md). `npm run playground` opens a signed-in practice workspace, a sample app with a reproducible bug, and a short guide. It uses a disposable database and no real money.

With Node 24 and a running Docker engine:

```sh
npm ci --ignore-scripts
npm run setup:local
npm run db:up
npm run db:migrate
npm run dev
```

Create your first local owner invitation with `npm run workspace:invite -- owner@example.com My workspace`, then open the private URL in the file printed by the command. It sends no email. [Your workspace](http://127.0.0.1:3000/workspace) lets you manage projects and draft work briefs. The separate [sample workspace](http://127.0.0.1:3000/demo) supports evidence comparison and a labelled report download. Published work and review decisions are available locally; no live payments are configured. See the [development guide](docs/DEVELOPMENT.md) for setup, production builds, worker commands, checks, and troubleshooting.

## Capability experiments

With Node 24, run `npm ci --ignore-scripts`, `npm run browser:install`, `npm test`, then `npm run spike:reproduce`. Run `npm run spike:verify` to prove the same regression fails on the original fixture and passes on a patched copy. See the experiment README for trace inspection and limits.

With Anvil installed, `npm run spike:payments` exercises local payment recovery without spending mainnet funds.

The [buy experiment](spikes/resources/README.md) adds unsigned live quotes (`npm run spike:resource-quotes`) and a local x402 recovery test (`npm run spike:resources`). Its signed requests reach only a simulated provider. Actual browser/VM provisioning remains pending, and the live adapter stays disabled.

## Working rhythm

Read the project memory and current status before changing the project. Complete one coherent step, run the checks appropriate to it, update the tracking files, and commit that step. Keep proposed work distinct from verified behavior. Git history is the authoritative record of commits.
