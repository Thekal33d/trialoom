# Public ladder journey

Approved by the user on 2026-11-01. The latest live journey **passed**: isolated Chromium loaded the homepage, opened Leaderboard → The Ladder, read HTTP 200 and verified that the visible `3480 CLIMBING` count matched the API's numeric total. Excluded auth/RPC services stayed blocked. The submission is pending review with no accepted work or payable; the deployed revision remains unconfirmed. [Verified checkpoint](evidence/RUN-03-ladder-verified.json). The [earlier blocked checkpoint](evidence/RUN-03-ladder-live.json) is preserved.

## Approved scope

1. Open the authorized Blokaz homepage in a fresh isolated Chromium context.
2. Select **LEADERBOARD**, then **THE LADDER**.
3. Read `GET https://ghpftgmgszleutscfgqe.supabase.co/functions/v1/api/levels/leaderboard?limit=25` without credentials.
4. Require HTTP 200, a bounded JSON `standings` array with at most 25 entries, a safe integer `players` total no smaller than the returned row count, a visible ladder view and a displayed player count matching that total. Retain only the count and response hash in the assertion; raw response/player values remain private.

The main Blokaz origin and the already approved Google Fonts origins retain their GET/HEAD scope. The new API permission matches this exact path, query and GET method. Alternate limits, extra parameters, paths, HEAD/POST, cookies/authorization and redirects are refused. DNS pins, verified upstream TLS, resource caps and live run checks still apply.

Explicitly excluded and kept blocked: `https://api.web3auth.io`, `https://forno.celo.org` and `https://1rpc.io`. Login, wallets, chain data, weekly score validation, gameplay, score submission and identity changes are outside this journey. An excluded connection is evidence that the restriction held, not a product failure or verification of the excluded feature. Any undeclared destination or other policy violation still blocks the result. Submitted work remains pending review and cannot authorize payment.

The prior trace's POST bodies were recovered by following Playwright's `_file` resource references through the bounded in-memory archive reader. All 16 recorded RPC requests were `eth_call`. The earlier method-unknown note reflected a missed resource field, not absence of the data. The bodies and parameters stay private, and no RPC access is enabled here.

## Implementation

- `readOnlyRequestUrls` and `blockedDependencyOrigins` are optional immutable terms fields, displayed and preserved in the brief editor. Whole-origin grants, exact API origins and blocked origins must be disjoint. At most seven supporting origins and twelve exact reads are allowed; witnessed isolation is required.
- Each issued manifest carries the exact GET rules and excluded origins. The broker records excluded attempts with a fixed anonymous `EXCLUDED_ORIGIN` reason; no connection or DNS resolution reaches them. Unexpected denials remain separate. The controller reports exclusions as untested features and never turns a failed journey or exhausted budget into a pass.
- The fixed driver compares an actual bounded API response with visible UI. It makes no claim that ranking order, every player row or score accuracy has been validated.
- This is a local controlled journey, not independent verification, a full Blokaz audit or production runner readiness. The deployed revision remains unconfirmed.

## Live findings and fixes

- The initial public attempt stopped during broker startup. An owned 800 ms delayed-launch reproduction exposed a readiness race: a Docker container in `created` state was treated as failed before asynchronous attachment completed. The controller now waits within its existing bound; the same delayed launch completed actual Chromium navigation and witness freeze after the fix. A later public startup still failed, so the race fix does not establish that every startup problem is solved.
- The next attempt was refused with `EGRESS_CONCEALED`; that ingestion check was preserved. Bounded diagnostic GETs found HTTP 200 with no CORS permission when `Origin` was omitted, and permission for the page when its origin was present. The proxy now forwards an incoming Origin only if it exactly matches the manifest’s primary page origin; it never synthesizes CORS response headers or forwards credentials.
- The actual API returns `standings` plus a numeric total in `players`, correcting the prepared fixture’s assumed players-array shape. The observed diagnostic response contained 25 rows and total 3480. The driver and owned fixture now use the real shape; the total is not the page length. Raw response values remain private.
- An earlier submitted attempt forwarded eight responses (six first-party, two font stylesheets), recorded one upstream failure, and exhausted no budget. Its trace recorded a first-party script with no response after about 5.05 seconds. A subsequent attempt stopped at broker startup. Closed startup/upstream diagnostics and separate infrastructure classification now expose these failures without private data. A streaming fixture reproduced a client-idle timer expiring while the buffered upstream response was making progress; timer ownership is corrected without increasing the upstream idle or absolute connection limits.
- The next trace reached the ladder and HTTP 200 but exposed two further problems: rotating unused Google Fonts addresses caused DNS refusal, and the driver waited for a count next to the separate CLASSIC PLAYERS heading. The broker now validates the full current answer as public and connects only to an original manifest pin still present in that answer. New-only/private/mixed answers remain refused. The exact count assertion now uses the actual CLIMBING label. See [reliability notes](RUN-03-RELIABILITY.md).
- The first passing journey's sanitized trace was withheld for Playwright's `-1` unavailable-duration marker. Exact marker support, privacy/invalid-value tests and a real owned pending-request fixture now cover that case. The final public run passed all three steps and retained a reviewable sanitized trace: 10 actions, 54 requests, 29 without an HTTP response. It forwarded 25 responses, refused 35 excluded connections, and exhausted no budget. No upstream failures, product defect, acceptance or payable were recorded.

## Validation

- 21 isolated proxy groups, two Chromium journeys and proxy-loss checks passed, including DNS rotation, streamed progress, true stalls and absolute cutoff. Exact path/query/method/redirect restrictions, credential stripping, scoped CORS and exclusion handling remain checked.
- 12 focused trace/archive, ladder-response and startup-diagnostic tests and 32 evidence-ingestion/export database tests passed. The new trace check rejects malformed durations and removes private canaries while preserving only numeric `-1`.
- Network-disabled owned startup refusal/cleanup, success with a pending request, and wrong-count/unexpected-origin/upstream-failure controls passed through real HTTP evidence/replay. Negative controls remained blocked with zero payables; the pending-request notice was visually inspected.
- The final public replay's stored sanitized hash and regenerated safe archive entries agree. Actual HTTP replay/hash, scope-editor preservation and no-response UI checks passed. The public screenshot was visually inspected. All runner containers/channel volumes were removed; the disposable public review session remains open.
- Lint, strict types and a fresh production build passed. Three pre-existing storage tracing warnings remain. Durable recovery, adversarial resource testing and independent operator verification are still open.

## Commands

Owned, network-disabled validation:

```sh
npm run browser:preview -- --smoke --ladder
```

The exact public read is already approved:

```sh
npm run browser:preview -- --blokaz --ladder
```

The public source inspection found the leaderboard asset and API call on the already authorized Blokaz origin. It was read as bounded text, never executed on the host; the private source copies remain ignored. No RPC/auth permission follows from the backend-read approval.
