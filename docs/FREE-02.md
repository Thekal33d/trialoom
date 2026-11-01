# Bounded free browser tests

Local implementation, 2026-11-01. FREE-02 remains in progress until the remaining RUN-03 resource and whole-host recovery gates pass. Public hosting is FREE-03; useful sponsored explanations are BUY-01.

## Available flow

A verified free account can request the prepared sample or an operator-enabled project page from `/workspace`. The sample loads an owned page and follows its next-page link in real Chromium. A project test loads its authorized page and checks successful rendering. Only GET/HEAD on the primary origin is allowed; other origins, authenticated sessions and form submissions remain blocked. Project authorization must be explicitly confirmed again when requesting a test. No customer funding, campaign, assignment or operator is manufactured.

Each request stores the authorized URL, original DNS admission pins, environment, owner, idempotency key and container identity. The public broker rechecks that DNS answers are public and retains only original pins. There are no caller-selected commands, headers, credentials, destinations, image, quotas or payment fields. The sample is explicitly `offline-owned-proxy-fixture-v1`, with real loopback pins in a network-disabled broker; it cannot be selected as an arbitrary private target.

Results describe observed rendering, sample navigation, scope and infrastructure checks. A blocked run is not a confirmed defect. The current page is not certified against a build revision. The replay contains sanitized browser actions, HTTP methods/statuses and timing; page contents, snapshots, URLs, credentials and free-form errors are discarded. Unlike the paid evidence path, this free path does not persist raw trace bytes; supported metadata is stored with the result and its SHA-256 hash. Unsupported traces yield an explicit unavailable replay.

## Limits and recovery

- One active request per free account; three admitted requests per UTC day. Cancelled/interrupted requests still consume the allowance.
- Ten active/queued requests and thirty admitted requests per UTC day across the deployment. Five per public target origin per UTC day across accounts. The network-disabled sample does not consume an external origin's quota.
- One free browser at a time, enforced by a PostgreSQL session lock; a second CLI service cannot publish conflicting readiness. These limits apply to this deployment database, not to unrelated databases or manually operated paid-run controllers.
- The runner must be enabled and have a heartbeat younger than sixty seconds before a new request is admitted. Graceful shutdown expires readiness. A stopped worker's existing queue survives; restart resumes queued work.
- A committed `running` record is never automatically dispatched again. On recovery, exact named containers/volume are cleaned and the uncaptured run becomes interrupted. A captured result is checked against its hash and delivered after cleanup. Cleanup failure keeps the active slot occupied, stops the service and requires recovery; it never invites a duplicate execution.
- Cancellation fences capture, signals the browser and keeps account/global capacity occupied until cleanup is verified. Database connection loss and the sixty-second supervisor deadline abort execution. The existing host-owned watchdog removes the containers independently after fifty-five seconds.
- Existing RUN-03 resource limits remain: 1 GiB memory, 256 processes, 1 CPU, bounded scratch/output, 45-second journey and network budgets. No paid resource call exists in this flow; monetary liability is zero.

The privileged local worker talks directly to PostgreSQL and the existing OrbStack machine `trialoom-runner`. It is trusted control-plane code. The browser and proxy have neither database nor application credentials. This is not a hosted runner installation or a substitute for least-privilege production roles, admission abuse controls, retention tooling, adversarial resource tests or host/reboot recovery.

## Local operation

Apply migrations with `npm run db:migrate`. Prepare the existing RUN-03 host as documented in [RUN-03-INTEGRATION.md](RUN-03-INTEGRATION.md). Set `TRIALOOM_FREE_TESTS=true` for both app and worker, then run `npm run worker:free` separately from the app. `--once` processes one queue/recovery item. Leave `TRIALOOM_FREE_TARGET_ORIGINS` empty for the offline sample; enabling exact comma-separated HTTPS origins is an operator decision after target authorization. Signup remains independently gated by `TRIALOOM_PUBLIC_SIGNUP` and mail configuration.

`npm run runner:free-check` uses a disposable database, captured signup mail, a real application session, the actual automatic worker and isolated owned fixture. It checks signup-to-replay, desktop/mobile accessibility and layout, result persistence, SIGKILL during execution and after capture, cleanup, and zero marketplace/payment records. It sends no email, contacts no public test target, buys nothing and deletes its test database. Private screenshots/checkpoint details stay under ignored `artifacts/free-test-checks/`.

API: authenticated owner-only `GET/POST /api/v1/workspaces/:workspace/free-tests` and `DELETE /api/v1/workspaces/:workspace/free-tests/:id`. Mutation routes retain same-origin checks, bounded JSON and existing user rate limits. The status response reveals only the caller's enabled project origins, never other customers' allowlist entries.

## Release gates still open

Automatic free dispatch and process recovery are local capabilities. Arbitrary public signup-to-target execution stays disabled until resource-exhaustion/host recovery checks, real HTTPS hosting and mail/recovery, production roles, monitoring/backup/retention, edge abuse controls and external-user validation pass. The first smoke test covers rendering, not a general user journey, repaired defect or independently verified build. BUY-01 must attach useful advisory output through a separate sponsored budget and recoverable purchase journal, with no customer reimbursement.
