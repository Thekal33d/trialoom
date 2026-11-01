# Public ladder journey

Approved by the user on 2026-11-01. The latest submitted live attempt is **blocked**: homepage rendering passed, but a required first-party script failed upstream before the ladder could be verified. The exact API was inspected separately under this approval; that diagnostic read is not a successful browser journey. [Live checkpoint](evidence/RUN-03-ladder-live.json).

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
- The latest submitted attempt forwarded eight responses (six first-party, two font stylesheets), recorded one upstream failure, and exhausted no budget. The private trace identifies a first-party script with no response after about 5.05 seconds, consistent with the unchanged 5-second upstream idle limit. Replay has six actions and nine request records. Homepage passed; ladder verification remains blocked. A subsequent fresh attempt ended during broker startup and produced no submission. No product defect, acceptance or payable was established.
- Next: add bounded broker-startup and upstream-failure diagnostics, distinguish infrastructure failures from scope-review messages, then repeat this already approved journey without expanding permissions.

## Validation

- The preceding scope checkpoint passed 49 focused project/runner/isolation database tests; those unchanged server paths were not rerun for these runner-only fixes.
- 19 isolated proxy groups, two Chromium journeys and proxy-loss checks passed after the CORS change. Exact query/method/path/redirect restrictions, excluded-versus-unknown denials, credential stripping and constrained Origin forwarding remain verified. Two focused response-contract tests passed, including total-versus-page-size and invalid-shape cases.
- The network-disabled owned ladder journey passed through real HTTP evidence ingestion and sanitized replay; terms editor fields were preserved. Wrong displayed count and an unexpected origin both remained blocked. No acceptance or payable was created.
- Lint and strict types passed after the fixes. The preceding application build passed with three existing storage tracing warnings; no application/server build changes were made in this follow-up. The current live replay screenshot was visually inspected and all runner containers/channel volumes were removed.

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
