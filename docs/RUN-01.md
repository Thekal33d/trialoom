# A real browser run in the workspace

RUN-01 · 2026-11-01 · Controlled local execution, submitted through the application HTTP API.

## Run it

After the [local setup](DEVELOPMENT.md), with Docker running:

```sh
npm run db:up
npm run browser:install  # first time only
npm run build           # after application changes
npm run browser:demo
```

Chromium executes the invitation journey, then leaves a signed-in workspace open on **Canopy — real Chromium run**. The brief **Test teammate invitations — fresh browser evidence** starts without findings. After execution it contains the newly submitted result, pending your review. Open its redacted report/assertions or choose **Export this brief**. No acceptance decision is made for you and no payment is sent.

The normal address returns HTTP 201. The valid plus alias returns HTTP 400 because of the owned fixture's deliberate bug. These responses, the displayed messages, assertion outcomes, browser version, timestamps, driver hash, and fixture build hash come from this execution. The trace is a real Playwright ZIP, not the placeholder archive used by the earlier playground.

Use the browser window the command opens; another browser will not share its session. Keep the command running while reviewing. Closing the browser or pressing Ctrl-C stops its servers and deletes the disposable database and ignored private files under `artifacts/browser-runs/`. Copy any downloaded report you want to keep before ending the session. A forced process kill cannot run cleanup. Restarting the command creates a fresh app state, account, campaign, and run.

## How it connects

The trusted local controller sets up test accounts, qualification, the project/build, terms, a claim, and a run grant. **Setup remains administrative fixture orchestration**, not a hosted operator-registration or autonomous campaign-dispatch feature. It issues no wallet or spending authority and starts no settlement worker.

New run manifests contain the campaign, assignment, terms hash/version, build identity, target URL, and environment pinned by the server. The worker reads these through `GET /api/agent/v1/runs/:id`, uploads each real artifact through `POST /runs/:id/artifacts` with its SHA-256, and submits the evidence document through `POST /runs/:id/evidence`. Authorization, schema checks, redaction, review state, findings, and exports use the existing application routes. Old grants without the new manifest binding are not supported by this driver; issue a new run.

The driver interface takes only its run grant, not the operator credential, database connection, builder session, or a payout key. The trusted controller and fixed driver currently share a Node process; they are not isolated services. Chromium receives a filtered environment without the controller's `.env` credentials and the test uses a separate browser context from the builder. The grant stays in the Node HTTP client and is never injected into page traffic or the browser trace. The driver performs no automatic write retries; an uncertain upload/submission needs reconciliation, not another assignment or a claim of success.

## Boundaries

- **Owned local fixture only.** The controller creates its exact loopback project/build in a randomly named disposable test database and records the distinct `local-owned-fixture-v1` admission policy. It reads the actual fixture metadata to confirm the build. It does not fake public DNS or remap a public target to localhost. There is no production allow-local switch or bypass endpoint; normal target creation still refuses loopback addresses. This driver does not accept arbitrary website URLs.
- **Fresh browser state, attested isolation.** Each execution gets a new context with empty cookies/storage. Requests are restricted to the fixture origin, four known paths, and their permitted methods. Service workers, WebSockets, popups, and downloads are blocked. The driver caps its execution at 30 seconds or the earlier grant budget, checks navigation/artifact limits, polls the grant, and checks it again before actions and uploads. This is not gVisor, an OS resource sandbox, or proof that a production host enforces all egress. Customer targets remain gated on an operated, verified host.
- **Failures are distinct.** Observed assertion failures become `product_failed`; an unavailable target or an incomplete timed-out journey becomes `blocked`. Expiry, revoked grants, and local cancellation stop the browser without submitting a new result. A run stopped before any target contact cannot produce a valid evidence submission and returns an error. After local cancellation the controller still owns abandonment/release; in this demo the entire database is disposable. Campaign cancellation retains the existing drain-active-work semantics.
- **Raw traces remain private.** The ZIP is captured, hashed, and uploaded, but the existing text-only policy cannot sanitize archives. The workspace/export exposes verified redacted text and names the withheld trace. A reviewed trace-sanitization and replay path remains future work.
- **No independent or paid work claimed.** The accounts and prices are test fixtures, one controller operates this run, and no model selects actions or repairs code. The fixed journey produces real evidence; it does not establish independent reproduction, hosted execution, a paid campaign, or hackathon eligibility.

## Verification

```sh
npm run browser:demo -- --smoke
node --env-file-if-exists=.env --test tests/runner.test.ts
```

Verified on 2026-11-01:

1. Actual Chromium 201/400 responses exist in the trace; its hash matches the artifact uploaded through HTTP. The run grant does not occur in the browser trace.
2. Fresh evidence appears pending review, survives page reload, exports redacted text, and creates no payable. Reusing the closed grant is refused without a second submission. The normal project endpoint still rejects the private target.
3. An expired grant refuses execution and creates no submission.
4. Cancellation after the page opens closes its context and submits nothing; revoking a grant during execution also prevents submission.
5. An unavailable fixture submits a blockage and creates no defect finding.
6. A stalled journey is stopped by the driver time cap and submitted as an agent-limitation blockage.
7. The same driver, run against a temporary repaired copy of the fixture, observes 201/201 and reports `executed`. The original fixture source is unchanged. This is an integration check, not independent repair verification.

All 25 existing runner/evidence checks passed, including the added pinned-manifest assertions. Lint, strict types, and production build passed. The build retains three pre-existing dynamic-filesystem tracing warnings in `src/server/storage.ts`.
