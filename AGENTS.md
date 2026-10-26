# Trialoom working instructions

## Resume a session

1. Read [memory/PROJECT.md](memory/PROJECT.md), [memory/STATUS.md](memory/STATUS.md), and the latest entries in [memory/BUILD_LOG.md](memory/BUILD_LOG.md).
2. Read [memory/DECISIONS.md](memory/DECISIONS.md) and the relevant sections of [docs/PRD.md](docs/PRD.md). Follow any roadmap and backlog linked from the status file.
3. Inspect `git status --short --branch` and recent commits before editing. Preserve existing user changes.
4. Continue the current objective using the next action and recorded dependencies. Treat proposals as proposals; record any material choice when it becomes settled.

## Product guardrails

- Build the complete test, reproduce, repair, independently verify, and pay loop. Start with invited operators and existing web apps with preview builds.
- Valid test execution can earn its fee whether the tested product passes or fails. Discovery rewards are separate.
- Use integer token base units for money. Reserve maximum assignment liability atomically. Reclassification from commitment to payable must not double-count funds.
- Spending authorization is not escrow. Keep accepted obligations visible even if payment authority or funding disappears.
- Only valid application decisions authorize payments. Models, external agents, signatures, and screenshots cannot establish acceptance on their own.
- Persist payout identities and reconciliation state. Uncertain settlement must not create another transfer or free its commitment prematurely.
- Separate work state from payment state and transaction inclusion from finality.
- Require independent reproduction and verification. A repair's regression test must fail on the original revision and pass on the candidate.
- Keep credentials, signing keys, private traces, and customer code out of Git and logs. Isolate runners; constrain targets, resources, and repository access.
- Deliver repairs for builder review. The Trialoom product must not automatically merge or deploy them.
- Check live official sources before integrating external contracts, payment SDKs, or hackathon requirements. Never invent contract addresses or claim eligibility without evidence.

## Track each meaningful step

- Update `memory/STATUS.md` with the actual state, active work, blockers, and one concrete next action.
- Append a dated entry to `memory/BUILD_LOG.md`: task ID, changes, checks and outcomes, limitations, and commit subject or an already existing commit hash.
- Record architectural choices and material scope changes in `memory/DECISIONS.md`. Update `memory/PROJECT.md` only when durable context changes.
- Update relevant backlog, roadmap, and evidence entries when they exist. A task is done only when its acceptance conditions are met; a scaffold or mock is not a verified integration.
- Record dates in ISO format. Project timezone: Africa/Lagos. Preserve official deadline timezones and show the local equivalent where useful.

## Commit every completed step

The user explicitly requested incremental commits throughout the build. This is a standing project preference.

1. Finish a small, coherent step and run appropriate checks. Do not add tests that merely restate documentation or trivial implementation.
2. Review the diff for accidental changes and secrets; update the tracking files in the same step.
3. Stage explicit paths belonging to the step. Never sweep unrelated user changes into a commit.
4. Commit with a descriptive subject, such as `docs: ...`, `feat: ...`, `fix: ...`, or `test: ...`. Include the backlog ID in the body when available.
5. Verify the commit and working tree. Report the checkpoint and any unfinished work truthfully.

If a check or commit fails, record the reason and resolve it when possible. Do not claim a commit exists until it succeeds. Do not rewrite history, change Git identity, push, publish, or spend funds solely because local commits are requested. Existing authorization from the user still applies.

## Source of truth

The original PRD lives in `docs/PRD.md`; its initial copy is verbatim. Track later requirement changes explicitly with a decision and rationale. `memory/STATUS.md` describes current state, `memory/BUILD_LOG.md` records work history, and Git records exact commits. Avoid maintaining competing copies of status or the full PRD.
