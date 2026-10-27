# The repair workflow

Verified locally on 2026-10-27. This is ALPHA-07 for FR10 and FR11. It closes release scenario R04 and completes R11's repair half. [Evidence](evidence/ALPHA-07.json) records checks and exact source hashes.

A repair is the one service where an operator changes the builder's code. Everything here exists so that a payment for that change rests on a decision the builder authorized in advance and on a result someone unconnected to the author reproduced.

## A quote authorizes the work before it exists

A repair is bought against **one confirmed defect, one pinned build, and the paths it may change**. The workspace owner is the only role that can approve one, because approving a quote is approving a spend.

| Refusal | When |
| --- | --- |
| `DEFECT_UNCONFIRMED` | The defect is not confirmed: a repair is not bought for a guess |
| `SERVICE_MISMATCH` | The brief is not a repair brief |
| `CAMPAIGN_CLOSED` | The brief is already published: the approval comes first |
| `NOT_ADMITTED` | The named operator is not admitted to the workspace |
| `QUOTE_EXISTS` | The brief already has a quote |

Publishing then checks the offer against the approval. A repair brief with no approved quote is refused (`REPAIR_QUOTE_MISSING`), as is one whose terms pin a different build (`QUOTE_BUILD_MISMATCH`) or price the work at anything other than the approved amount (`QUOTE_PRICE_MISMATCH`). Without those checks the quote would decide nothing: a builder could approve one amount and publish another.

The quoted operator holds the **first slot**. Until they have claimed it, any other operator's claim is refused with `REPAIR_AUTHOR_FIRST`, so a verifier cannot take the slot the repair itself needs. After that, everyone else in the brief is a verifier. This means a repair brief must publish at least two slots for verification to be possible at all.

## The gate is a refusal, not a score

R04's rule is that a regression test which also passes on the original revision demonstrates nothing. Trialoom applies it as a **condition of recording a repair at all**: the `repairs` table's `gate_state` column admits only `'passed'`, so a row exists only for evidence that met the gate. Evidence that does not is refused, the whole submission transaction rolls back, and the operator can correct and resubmit under the same claim — nothing is recorded against them.

The gate requires:

- every clean replay on the original revision **fails** (`REGRESSION_UNPROVEN`),
- every clean replay on the candidate revision **passes** (`REGRESSION_UNPROVEN`),
- the replays on the original revision exercise exactly one assertion, and the candidate replays exercise that same one (`INCONSISTENT_REPLAYS`),
- that assertion is one the defect's own findings recorded (`UNRELATED_FAILURE`).

Two consistent clean replays per revision are the minimum, so neither side can rest on a single run. A delivery is measured against its quote besides: `BASE_MISMATCH` if it is not built on the quoted revision, `CANDIDATE_UNCHANGED` if nothing changed, `SCOPE_EXCEEDED` if it touches a path the quote does not cover, `FILE_UNCHANGED` if a listed file has identical contents before and after, and `REQUIRED_CHECK_FAILED` if a named check does not pass on **both** revisions.

What is recorded is the patch digest, the regression test digest, the changed files with their before and after digests, both revisions, the replays, the required checks, and a plain-language statement of what the gate saw. The row is immutable.

## Verification is independence, again

A confirmation is refused from the repair's author, from every operator who reported the defect, and from anyone linked to them by the ALPHA-06 rule — the same identity, the same account, or any payout wallet either has ever proven (`INDEPENDENCE_FAILED`). This is R11's repair half, resting on the same check as its discovery half.

A verifier carries **their own replays**, not an approval: there is no path that confirms a repair without evidence. A confirmation must meet the same gate the delivery met and must exercise **the same assertion** the delivery was measured against, so a confirmation that ran a different test is refused rather than counted. A verifier may also refute or report an inconclusive result; a refutation is recorded and nothing is confirmed. One verification per operator per repair.

## What a repair submission is, and is not

The pinned service decides what evidence a submission needs and what it means:

| Role | Required evidence | What is recorded |
| --- | --- | --- |
| Author | `patch`, `test`, `assertions` | One repair, if it passes the gate |
| Verifier | `trace`, `assertions` | One verification with its own replays |

Repair briefs do **not** cluster their submissions into defects. Clustering is keyed by the pinned build, while a repair submission describes the candidate revision, so recording one there would attach a result to the wrong revision. For the same reason a repair author's clean run does not mark the original defect flaky.

## Money

A repair author's execution decision is refused with `VERIFICATION_PENDING` until an independent verifier has confirmed the repair. A builder who likes the patch cannot accept it on their own say-so.

A verifier is paid through **partial acceptance**: their execution decision must state an amount, below the published repair price (`VERIFICATION_PRICE_REQUIRED`). The published price buys the repair, not a verification of it, and defaulting a verifier's acceptance to the author's price would pay a smaller job the larger fee. This is a deliberate stopgap, not a design: verification has no brief and no price of its own yet.

Accepted amounts are owed and queued under ALPHA-08. Nothing here is paid.

## Trialoom does not apply the repair

A passed gate means the evidence may be reviewed. The delivery is returned as `for_builder_review` and the defect's repair state moves `none → quoted → delivered → verified → accepted`. There is no merge, no deploy, no write to the builder's repository, and no step that applies a patch anywhere. The builder does that themselves, outside Trialoom.

## What remains

- **Repository access is declared, not issued.** A repair brief states the paths it may change, and the delivery is measured against them, but Trialoom holds no repository credentials and grants no repository access. How the operator obtains the code is outside the platform.
- **Nothing is re-executed.** The gate reads the replays the operator reports; Trialoom does not run the regression test, apply the patch, or verify that the patch digest corresponds to the changed files. Both sides report, and independence is what makes the pair meaningful.
- **Verification is not its own service.** It has no brief, no quote, no qualification distinct from `repair`, and no price except the partial acceptance above. A builder who publishes a one-slot repair brief gets no verification and therefore no payable repair.
- **One repair per brief.** A quote, a delivery and its verifications are one-to-one with the campaign. A second attempt needs a second brief.
- A refuted or inconclusive verification is recorded and flags nothing: no review flag, no appeal path of its own, and no rule about how many refutations outweigh a confirmation.
- Severity, resource accounting (ALPHA-09) and the end-to-end seeded run (ALPHA-11) are untouched.
