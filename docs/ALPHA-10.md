# Core screens and exports

Verified locally on 2026-10-28. This is ALPHA-10 for FR16, and it completes what FR01, FR12 and FR14 need to be *reachable* rather than merely recorded. [Evidence](evidence/ALPHA-10.json) records checks and exact source hashes.

Two things were genuinely missing after ALPHA-09: a builder could not take their own record out of the platform, and nothing answered "what is waiting, and on whom" without reading every brief in turn. This step builds both. It does not redesign the information architecture; the screens the PRD lists that remain unbuilt are named at the end.

## An export is a file a builder can keep

`GET /api/v1/workspaces/{w}/projects/{p}/campaigns/{c}/export` returns a zip:

| File | What it holds |
| --- | --- |
| `manifest.json` | The workspace, project, campaign, **every** terms version with its content hash, the builds, the redaction policy, counts, and a content hash of itself |
| `findings.json` | Every report with its clustering outcome and independence, and the defects they cluster into |
| `replay.json` | Per submission: the pinned revision, fixture and target, what the terms permitted and excluded, the attested isolation profile and agent configuration, the issued limits, the observed origins, the steps and assertions, the target recheck, and each artifact's digest |
| `decisions.json` | Every decision with the criteria **the claim pinned**, the reason, the evidence references and the actor's role |
| `repairs.json` | The quote, the delivered patch's digests and changed files, the regression replays, and each independent verification |
| `payments.json` | The accounting by category, every payable with its state and reason, and every resource purchase |
| `withheld.json` | Each artifact not included, with the reason it was not |
| `artifacts/` | The verified redacted copy of every artifact that has one |

The manifest's `contentHash` is taken over what the file actually holds — the body serialized, re-parsed, then canonicalized — and the manifest states the recipe: remove `contentHash`, serialize with sorted keys, take the SHA-256. A hash the holder cannot recompute would prove nothing to them. It is also returned as `X-Trialoom-Export-Hash`.

### What never leaves

Raw artifact bytes are not exported, in any form. Beyond that, **operator-supplied prose is redacted too**: a step's `actual` field or a summary can carry a secret the artifact policy never saw, and a file travels further than a screen does, so every string leaf in an exported document goes through `text-secrets-v1`. The policy keeps the field name and removes the value, so the prose stays readable.

An artifact this platform cannot verify as clean — an archive, an image — is named in `withheld.json` with its digest and the reason, not included unchecked. That is the same rule the screens follow, and the export does not weaken it.

Exporting is a **builder** capability: an owner or a project member. A reviewer reads the screens and the queue; taking a copy of the whole record is the builder's own decision. Every export is recorded as an audit event, because it takes the record out of the platform.

## One queue for what is waiting

`GET /api/v1/workspaces/{w}/attention` answers, for every published brief in the workspace:

- submissions awaiting a decision, and how long the oldest has waited,
- reports clustering could not group, and defects flagged for review,
- open appeals, and repair quotes awaiting approval,
- repairs awaiting independent verification,
- payouts blocked or needing reconciliation, and what is owed and unpaid,
- resource purchases holding a reservation,
- live assignments.

Every count is **derived**, so the queue cannot disagree with the records it reads: a submission is awaiting review exactly when no execution decision exists for its assignment, and it leaves the queue the moment one does. Briefs are ordered busiest first.

The queue also names **what can pay**, added in PILOT-05: each live payment authority with how lately its approval was read, whether that reading is stale, whether the read failed, and whether the approval still covers what the briefs drawing on it have committed. Like the clock facts below, none of it decides anything — a short or stale approval is reported, and no obligation is cancelled and no payment blocked on the strength of a reading. The queue also says whether anyone was **told**: a condition the platform raised and could not deliver is worse than one it merely recorded, because the builder has no reason to come and look.

The PRD's review promise appears here as two facts about the clock: a submission is late after **24 hours** and escalates to a platform reviewer after **48**. Escalation changes nothing about the work — the assignment stays submitted, no decision exists, and silence neither accepts nor rejects. Reviewers see the same queue under its own name, and that read is recorded like every other reviewer read.

The campaign panel carries the same facts for the one brief a builder is looking at, so "awaiting a decision", "blocked and still owed" and "holding a reservation" are visible where the builder acts rather than only in a roll-up.

## What this did not change

FR01, FR12 and FR14 were already enforced and already shown: workspace roles gate every route and reviewer reads are audited; decisions carry criteria, reason, evidence references and actor; the campaign panel shows the ceiling, committed, accepted, finalized, resource and fee columns with a replay check on the stored balances. This step made them reachable from one place and did not re-implement them.

## What remains

- **The information architecture is still panels, not screens.** The PRD lists a service catalog, a campaign setup flow, a repair review screen and a reviewer console as distinct destinations. What exists is one project page with a panel per concern, plus the queue added here. That is navigable but it is not the IA the PRD describes, and no service catalog exists at all.
- **No operator export.** FR16 is a builder capability and that is what was built. An operator cannot export their own assignments, evidence or earnings record.
- **No export of a whole project or workspace.** An export is one brief at a time, capped at 200 artifacts and 64 MiB; a larger brief is refused with `EXPORT_TOO_LARGE` rather than paginated or streamed.
- **Escalation is visible, not actioned.** The queue marks a brief escalated after 48 hours. Nothing notifies a platform reviewer, assigns one, or tracks that they picked it up, because there is no platform-reviewer role or notification channel in this build.
- **No payment incident queue.** The PRD's reviewer console resolves payment incidents; the queue counts payouts needing reconciliation and resource purchases holding a reservation, but offers no action on either, and a purchase settled above its authorized limit still needs a person with database access.
- The export's redaction is the same text policy as everywhere else: it recognizes known secret shapes and cannot promise to catch an unknown one. An archive is withheld rather than cleaned, so a builder who needs a trace still has no reviewed export path for one (PILOT-01).
- Nothing here is paid, merged or deployed: the limits of ALPHA-07, ALPHA-08 and ALPHA-09 are unchanged.
