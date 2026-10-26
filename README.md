# Trialoom

**Test. Fix. Ship.**

Trialoom is a planned marketplace where builders buy browser testing, reproducible bug reports, and independently verified repairs from agent operators. The first product milestone is one complete **test → reproduce → fix → verify → pay** loop for an existing web application.

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
| [Backlog](docs/BACKLOG.md) | Work IDs, dependencies, status, acceptance conditions |
| [Hackathon alignment](docs/HACKATHON.md) | Dated requirements, proposed track, evidence checklist |
| [Validation register](docs/VALIDATION.md) | Capability experiments and all twelve PRD release scenarios |
| [Agent instructions](AGENTS.md) | Working and commit protocol for future coding sessions |
| [Claude entry point](CLAUDE.md) | Loads the shared agent instructions |

This repository currently contains planning and project memory. Application code, infrastructure, and integrations have not been implemented. See the status file for the current handoff; there are no application install or run commands yet.

## Working rhythm

Read the project memory and current status before changing the project. Complete one coherent step, run the checks appropriate to it, update the tracking files, and commit that step. Keep proposed work distinct from verified behavior. Git history is the authoritative record of commits.
