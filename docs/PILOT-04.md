# Pilot instrumentation and the decision targets

Verified locally on 2026-10-29. This is PILOT-04, the second of the three gates outside the alpha. The invited pilot's exit condition is that its metrics meet their thresholds; none of them was measured. [Evidence](evidence/PILOT-04.json) records checks and exact source hashes.

Retrofitting measurement after twenty campaigns means you have run the pilot and learned nothing, which is why this came before connecting a wallet.

## The event stream

An append-only `events` table with a **closed topic list**: a metric may only rest on an event the table admits, so a new measurement needs a migration rather than a string. Every row carries the workspace, project, campaign and assignment identifiers the PRD asks events to share, so one timeline joins work, decisions and money.

The PRD names thirteen things to instrument. All thirteen are emitted:

| Event | Emitted at |
| --- | --- |
| `campaign.published` | A brief is offered to operators |
| `campaign.funding_failed` | A publication is refused for budget |
| `assignment.claimed` | An operator takes a slot |
| `run.started` | A grant is issued after target revalidation |
| `evidence.submitted` | A submission is ingested |
| `reproduction.outcome` | Clustering decides what a report is |
| `duplicate.decided` | A person groups an uncertain report |
| `decision.accepted` | Any money-moving decision |
| `appeal.opened` | An operator appeals a refusal |
| `resource.settled` | A purchase stops being uncertain |
| `payout.included` | A transfer reaches a block |
| `payout.finalized` | A transfer reaches finality |
| `purchase.repeated` | A builder publishes again |

A fourteenth, `review.opened`, exists because review burden is the one target no existing record can answer: nothing else knows when a person started looking.

### Two properties worth stating

**Events commit with the write they describe.** `emit` takes the caller's client, so a claim that rolls back leaves no claim event and a measurement never counts something that did not happen.

The exception is a **refusal**. A funding failure rolls its own transaction back, so that one is emitted afterwards on the pool. Without that, the stream would record only the publications that succeeded, and funding failure — a thing the PRD explicitly wants instrumented — would be structurally invisible.

**No credentials reach analytics.** The emitter drops forbidden keys, redacts every string value through the same `text-secrets-v1` policy that cleans evidence, and caps lengths. A table check then refuses those keys **at any depth**, including inside arrays, so a careless caller cannot name a secret into a stream that is read in bulk. Events are immutable: a metric computed from a record somebody could edit afterwards is not a measurement.

> The first version of that check read only the top-level keys, so a secret one level down passed a guard this document described as refusing it. `0013_event_payload_guard.sql` replaced it with a recursive key scan, and a check now asserts a forbidden key is refused at four different depths.

## The eight targets

Each one reports its definition, threshold, value, numerator, denominator, whether it meets the target, and **whether its inputs exist**.

| Target | Threshold | Measurable today |
| --- | --- | --- |
| Repeat purchase | ≥3 of first 5 builders | **No** — completion needs a finalized payout |
| Additional value | ≥3 of 5 builders | **No** — nobody records the judgement |
| Useful delivery | ≥70% | Yes, with each rejection class listed |
| Discovery precision | ≥70% | Yes, once a discovery decision is recorded |
| Review burden | ≤10 minutes median | Partly — only reviews done through the screen |
| Payment correctness | Zero | Yes, and complete whatever has happened |
| Payment timeliness | ≥95% within 60 minutes | **No** — no payout has reached finality |
| Economics | Nonnegative median margin | **No** — most of the cost side is unrecorded |

**A target whose inputs do not exist reports what is missing instead of a number.** This is the central decision of the step. Economics could easily print a positive figure by treating unrecorded compute, gas, verification and review cost as zero — and that figure would be worse than useless, because the exit gate would be read off it. Instead it names each missing input and reports what *is* known — finalized fee revenue, unrecovered resource cost — as parts, never summed into a margin.

Payment correctness is the one target that is complete regardless: a duplicate finalized payout either exists or does not, and the ceiling invariant is a table check rather than a sample.

Discovery precision was briefly in the "not measurable" column for the wrong reason: its query joined projects on a workspace id, so the denominator was structurally zero and the target reported "no input" however many findings were adjudicated. No check awarded a discovery decision and then read the metric, so nothing caught it. Both are fixed: the query counts the adjudicated submissions and the confirmed defects they were about, and a check awards a decision and asserts the numerator and denominator move.

The readiness view also shows the **stream's own coverage**, because a target resting on an event that has never fired is not measuring anything and the reader should see that directly.

## What remains

- **Review burden is an upper bound, and only for reviews done on the screen.** It measures the span from a reviewer opening a submission to the decision, which includes any time they spent away. A decision recorded without opening the review surface — through the API, say — has no measurable review time, and the metric says how many of those there are rather than quietly reporting a partial median.
- **Additional value needs a product change, not instrumentation.** Whether a defect was already covered by the builder's own checks is a judgement, and the honest options are to ask the builder at the discovery decision or to leave the metric empty. It is empty.
- **No per-builder breakdown.** Repeat purchase and additional value are stated per builder in the PRD; they are computed per workspace here, which is the same thing only while one workspace means one builder.
- **No cost rates anywhere.** Verification cost and human review time carry no money rate, so neither converts into margin even once measured.
- **No instrumentation of the agent API's own health** — latency, error rates, rate-limit pressure — and no retention policy on the stream, which will grow without bound.
- The metrics are computed on read, with no materialization. That is fine at pilot size and will not be at scale.

The stream is now readable per campaign as well as in aggregate: a brief shows its own activity beside its evidence, which is the record the targets are computed from.
