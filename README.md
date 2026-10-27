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

The local [browser/evidence experiment](spikes/browser-evidence/README.md) reproduces a seeded invitation defect twice, exports sanitized traces, and verifies a regression repair. The [Remesso experiment](spikes/payments/README.md) proves USDC policy payments and crash recovery on a local Celo fork. The Next.js application now has [invited accounts, workspace roles, authorized projects, pinned builds, and immutable draft terms](docs/ALPHA-02.md) plus [operator connection and qualification](docs/ALPHA-03.md), a [campaign ledger with atomic claims and leases](docs/ALPHA-04.md), [scoped run grants with evidence ingestion](docs/ALPHA-05.md), [clustered findings with recorded decisions](docs/ALPHA-06.md), and [payables settled through an idempotent outbox](docs/ALPHA-08.md), backed by PostgreSQL. No funded payment authority is configured, so accepted work is recorded as owed and every payout is blocked with a visible reason; Trialoom does not yet host or sandbox the runner, and repairs, resource accounting, production infrastructure, and provider integrations remain pending.

## Run the application

With Node 24 and a running Docker engine:

```sh
npm ci --ignore-scripts
npm run setup:local
npm run db:up
npm run db:migrate
npm run dev
```

Create your first local owner invitation with `npm run workspace:invite -- owner@example.com My workspace`, then open the private URL in the file printed by the command. It sends no email. [Your workspace](http://127.0.0.1:3000/workspace) lets you manage projects and draft work briefs. The separate [sample workspace](http://127.0.0.1:3000/demo) supports evidence comparison and a labelled report download. Claims and payments are not enabled. See the [development guide](docs/DEVELOPMENT.md) for setup, production builds, worker commands, checks, and troubleshooting.

## Capability experiments

With Node 24, run `npm ci --ignore-scripts`, `npm run browser:install`, `npm test`, then `npm run spike:reproduce`. Run `npm run spike:verify` to prove the same regression fails on the original fixture and passes on a patched copy. See the experiment README for trace inspection and limits.

With Anvil installed, `npm run spike:payments` exercises local payment recovery without spending mainnet funds.

The [buy experiment](spikes/resources/README.md) adds unsigned live quotes (`npm run spike:resource-quotes`) and a local x402 recovery test (`npm run spike:resources`). Its signed requests reach only a simulated provider. Actual browser/VM provisioning remains pending.

## Working rhythm

Read the project memory and current status before changing the project. Complete one coherent step, run the checks appropriate to it, update the tracking files, and commit that step. Keep proposed work distinct from verified behavior. Git history is the authoritative record of commits.
