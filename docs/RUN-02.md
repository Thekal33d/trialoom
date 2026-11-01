# View a recorded browser run

RUN-02 · 2026-11-01 · Recorded steps, browser actions, HTTP responses, and a sanitized trace download.

## Try it

With the [local setup](DEVELOPMENT.md) ready, run `npm run build` and `npm run browser:demo`. Use the signed-in Chromium window it opens. The fresh **Canopy — real Chromium run** result opens with **Recorded replay** expanded at the failed plus-alias invitation.

- Choose a numbered step, **Previous step**, or **Next step** to compare expected and observed results. The standard email receives HTTP 201; the plus alias receives HTTP 400.
- Expand **Assertions**, **Browser actions**, or **HTTP responses** for supporting evidence.
- Choose **Download sanitized trace** to keep a Playwright ZIP. **Export this brief** includes that same derivative, its hash and policy, alongside the other redacted evidence.
- Reopen it using **View replay** in **Execution and evidence** or beside the finding under **Reports and decisions**.

Keep the launcher running while testing. Closing its browser removes that session's disposable database and private run files. The earlier prepared playground contains placeholder traces: its submitted steps remain inspectable, but it explicitly reports browser actions unavailable and offers no trace download. Start a fresh browser run to test the new trace path; old private archives are not automatically migrated.

This is recorded inspection. It does not revisit the website, reproduce the bug independently, accept work, create a payable, or send a payment. It shows steps/assertions from the submitted evidence document separately from action/request metadata extracted from the trace; it does not invent a timestamp mapping between them. There is no video or page snapshot playback.

## What leaves private storage

`playwright-metadata-v1` accepts one Playwright trace context using format version 10, verified against the installed Playwright 1.64.1. It rebuilds a new ZIP containing `trace.trace`, `trace.network`, and `replay.json` from a closed set of fields:

- Enumerated browser/action types, mapped action identifiers, relative millisecond timings, and completed/error/incomplete action states.
- Enumerated HTTP methods, numeric response status and timing, with generated `redacted.invalid` addresses. Absolute wall time is replaced by an epoch origin.

It omits DOM snapshots, screenshots, source files, attachments, selectors, typed values, original URLs and paths, headers, cookies, request/response bodies, console messages, error details, and original identifiers. Unknown methods become a fixed generic label. Arbitrary trace strings are never copied, including values a secret-pattern detector would miss. Output text is rescanned under the known-secret policy, including the live run grant. Submitted report prose uses the existing `text-secrets-v1` rules for known secret shapes; that policy is not a universal customer-data classifier.

The ZIP reader never extracts files. It caps compressed input at 8 MiB, declared and actual expansion at 32 MiB, and entries at 512; checks paths, duplicate names, local/central consistency, overlap, CRC, supported compression, encryption flags and data descriptors; and caps parsed streams at 10,000 records and each line at 1 MiB. Unsupported formats, future versions, malformed records and excessive archives remain private with an explicit reason. Browser traces disguised as text cannot fall through to text-only redaction.

The original artifact and its original SHA-256 remain private. The derivative has its own content-addressed key and SHA-256, verified again before replay, download and export. The campaign export manifest binds each included derivative's hash and actual filename, including repeated names across runs.

## Access and rendering

The replay route is `GET /api/v1/workspaces/:workspace/projects/:project/campaigns/:campaign/submissions/:submission/replay`. It uses the existing workspace role check and full workspace/project/campaign/submission binding. Owners, members and reviewers can inspect evidence; operators and unrelated accounts cannot. Replay reads are audited; artifact reads by reviewers remain audited. Responses use `Cache-Control: no-store`.

The interface renders escaped React text and fixed metadata. It never embeds captured HTML, executes trace scripts, or fetches captured target URLs. Downloads are attachments with `nosniff`, their own policy header, and the derivative hash. No trace is sent to a public viewer service.

For optional local inspection of the downloaded ZIP, use the installed viewer:

```sh
node node_modules/playwright/cli.js show-trace /absolute/path/to/redacted-browser.trace.zip
```

Playwright's viewer can show its action and network metadata; snapshots and source panes have no captured content. The browser check opens the derivative in a loopback-only viewer process with an allowlisted environment. Playwright hides low-level getters by default and labels their count. See the official [Trace Viewer guide](https://playwright.dev/docs/trace-viewer) for the viewer controls; the sanitization limits above are Trialoom's policy.

## Verification

- `node --env-file-if-exists=.env --test tests/runner.test.ts tests/trace-redaction.test.ts tests/exports.test.ts`: 39 checks passed, including malformed/oversized/lying-size archives, removal of synthetic private values, ingestion, tenant/campaign refusal, unsupported legacy traces, corrupted-derivative refusal, export hashes and audit records.
- `npm run test:e2e -- tests/browser/evidence.spec.ts`: 20 desktop/mobile browser checks passed, including the unavailable-trace explanation and existing evidence/decision/export paths.
- `npm run browser:demo -- --smoke`: fresh actual 201/400 execution, first-failure step selection, navigation, finding link, failed-load retry, sanitized download/export identity, anonymous/foreign-submission refusal, desktop/mobile axe and overflow checks, Playwright viewer compatibility, and all RUN-01 interruption/repaired-fixture scenarios passed.
- Lint, strict types, production build, documentation links and diff checks passed. The three existing dynamic-filesystem tracing build warnings remain.

The scoped feature checks are not a comprehensive security audit or a production-isolation certification. The operated customer runner, independent operators, pilot operations/privacy/security, deployment and funded pilot gates remain open. [Evidence summary](evidence/RUN-02.json).
