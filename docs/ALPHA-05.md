# Runner isolation and evidence ingestion

Verified locally on 2026-10-27. This is the ALPHA-05 foundation for FR07 and FR08. It closes release scenario R10 at the application level and completes R12's fencing, and it narrows R05 to one named gap. Acceptance decisions, reproduction clustering, and settlement remain unimplemented. [Evidence](evidence/ALPHA-05.json) records checks and exact source hashes.

## What this step does and does not execute

**Trialoom does not host the runner.** The separate gVisor runner host recorded in [ARCHITECTURE.md](ARCHITECTURE.md) is not provisioned, so this step does not place a browser in a sandbox, cap its memory, or intercept its egress. The operator runs the work.

What the platform does enforce is its own boundary, and every control below is checked by Trialoom rather than asserted by the runner:

| Control | Enforced where |
| --- | --- |
| Target, DNS, redirect and revision revalidation | In Trialoom, before a run is issued |
| Short-lived, single-purpose credentials | Database row and scope check |
| Wall clock, artifact count, artifact size, total bytes | Issued in the manifest, checked at ingestion |
| Declared isolation profile | Attested by the runner, compared to the issued profile |
| Egress allowlist | Declared in the manifest; reported origins are checked at ingestion |
| Redaction before anything is shared | In Trialoom, with the redacted copy rescanned |

The isolation profile and the egress allowlist are the two that a dishonest runner can misreport. They are recorded as attestations, not as proof, and the gVisor host remains an open gate before customer targets are enabled.

## Target revalidation

An admitted target can change after a build is pinned, so the pinned target is rechecked at execution time rather than trusted from claim time. The check reuses the ALPHA-02 admission rules — HTTPS only, no credentials, query, fragment or custom port, and no private, reserved or unsupported address — and then:

- resolves DNS again and refuses when no resolved address is one the build was admitted with (`TARGET_REBOUND`), while recording that the address set changed even when they still intersect;
- follows at most three redirect hops, revalidating each hop, and refuses a hop that leaves the project's approved origin (`TARGET_REDIRECTED`) or a chain that never settles (`TARGET_REDIRECT_LOOP`);
- refuses when the target reports an `x-build-revision` that differs from the pinned build (`BUILD_MISMATCH`), and records `revisionConfirmed: false` when the target exposes no revision, never treating silence as a match;
- records a 5xx response as an unhealthy target rather than judging it a product defect, because that is a review decision and not this check's call.

The probe never reads the response body: a target check must not pull customer content into the web process. The whole record is stored on the run, so a builder can see what was observed.

## The run grant

A run is one execution attempt of a live assignment, and it carries one credential:

- returned once, prefixed `trun_`, stored only as a SHA-256 digest;
- `grant_scope` is a column whose check permits exactly `evidence:submit`;
- it expires with the claim lease, a heartbeat extends it no further than the lease, and lease expiry retires it in the same statement that returns the reservation;
- it reaches `GET /runs/:id`, `POST /runs/:id/artifacts` and `POST /runs/:id/evidence` for that one run, and nothing else. The long-lived agent credential cannot reach those routes, and the run grant cannot reach any other route or another run.

A partial unique index allows one live run per assignment; a crashed runner abandons its run and starts another under the same claim. Starting a run needs the new `runs:execute` scope and under a minute of remaining lease is refused rather than issued. **No scope in the allowlist can move money or sign a payout**, which the scope constraint itself asserts in a check.

## Evidence ingestion

Artifacts are uploaded one at a time with a declared digest, then one submission declares exactly the artifacts it uploaded. Every refusal names its reason:

| Refusal | Cause |
| --- | --- |
| `IDENTITY_MISMATCH`, `TERMS_MISMATCH`, `BUILD_MISMATCH` | A restated campaign, terms hash, build, revision, fixture, target or environment that differs from what the assignment pinned |
| `STALE_ATTEMPT`, `ATTEMPT_CLOSED`, `CLAIM_EXPIRED`, `RUN_CLOSED` | An expired or mismatched claim, or a run that has already finished |
| `ISOLATION_MISMATCH` | An attested profile that is not the one issued |
| `TIMESTAMPS_INVALID`, `TIMEOUT_EXCEEDED` | Execution that starts before its grant existed, finishes in the future, or runs longer than the issued budget |
| `EGRESS_VIOLATION` | A reported origin outside the manifest's allowlist |
| `ARTIFACT_TOO_LARGE`, `TOO_MANY_ARTIFACTS`, `EVIDENCE_BUDGET_EXCEEDED` | 8 MiB per artifact, 12 artifacts, 32 MiB per run |
| `ARTIFACT_CORRUPT`, `ARTIFACT_DUPLICATE`, `ARTIFACT_MISSING`, `ARTIFACT_UNDECLARED` | Bytes that do not match the declared digest, a repeated name or repeated bytes, a declared artifact never uploaded, or an uploaded artifact the submission omits |
| `EVIDENCE_INCOMPLETE` | No trace and assertions for a browser service, or no patch, test and assertions for a repair. A screenshot does not establish that a workflow ran |
| `OUTCOME_UNSUPPORTED` | An outcome its own steps and assertions do not support. A blocked run needs a blocked step and is not a product defect |

A submission is recorded once per assignment, its row is immutable, and it decides nothing: the claim keeps its reservation and no route accepted work in this step. The assignment moves to `submitted`, which holds the reservation and takes it out of the lease sweep while review is owed. [ALPHA-06](ALPHA-06.md) added the recorded decision that can act on it, and derives a submission's review state from those decisions rather than stamping it back onto the immutable record.

## Private storage and redaction

Artifact bytes never enter the database or a log line. They are written to a private, content-addressed store — SHA-256 keys, directories `0700`, files `0600`, written and renamed so a reader never sees a partial file — under `TRIALOOM_EVIDENCE_DIR`, which stands in for the private object storage in the architecture; that service is not provisioned.

Raw bytes are never served. Text evidence is redacted under the declared `text-secrets-v1` policy — authorization and cookie headers, bearer tokens, JWTs, key-shaped hex, credentialed URLs, private key blocks, password and token fields, email addresses, home paths, and the run grant itself — and the redacted copy is **rescanned**; an upload whose secret shape survives is refused rather than stored as shareable. Only that verified copy can be read, served as an attachment with `nosniff` so operator-supplied evidence is never rendered on this origin, and a reviewer's read of a submission or artifact is recorded.

Archives and images cannot be cleaned by a text policy, so they are stored private and refused to readers with `ARTIFACT_PRIVATE`. A reviewer cannot yet open a trace: an archive-aware sanitizer like the [VAL-01 exporter](../spikes/browser-evidence/README.md) needs its own reviewed export path, which ALPHA-06 and ALPHA-10 own.

## What remains

- Real isolation: the gVisor runner host, resource caps, and an egress proxy that enforces the allowlist instead of checking a report.
- A target that exposes no revision can still change under a pinned build without this check noticing (R05's remaining gap).
- Reviewable traces, retention and deletion controls, and evidence export.
- Settlement (ALPHA-08). Nothing in this step pays anyone, and acceptance and rejection arrived in [ALPHA-06](ALPHA-06.md).
