# Public ladder journey

Prepared on 2026-11-01. The exact backend read is awaiting user approval; no public ladder execution or backend contact has occurred at this checkpoint.

## Proposed scope

1. Open the authorized Blokaz homepage in a fresh isolated Chromium context.
2. Select **LEADERBOARD**, then **THE LADDER**.
3. Read `GET https://ghpftgmgszleutscfgqe.supabase.co/functions/v1/api/levels/leaderboard?limit=25` without credentials.
4. Require HTTP 200, a bounded JSON `players` array with at most 25 entries, a visible ladder view and a displayed player count matching the response. Retain only the count and response hash in the assertion; raw response/player values remain private.

The main Blokaz origin and the already approved Google Fonts origins retain their GET/HEAD scope. The new API permission matches this exact path, query and GET method. Alternate limits, extra parameters, paths, HEAD/POST, cookies/authorization and redirects are refused. DNS pins, verified upstream TLS, resource caps and live run checks still apply.

Explicitly excluded and kept blocked: `https://api.web3auth.io`, `https://forno.celo.org` and `https://1rpc.io`. Login, wallets, chain data, weekly score validation, gameplay, score submission and identity changes are outside this journey. An excluded connection is evidence that the restriction held, not a product failure or verification of the excluded feature. Any undeclared destination or other policy violation still blocks the result. Submitted work remains pending review and cannot authorize payment.

The prior trace's POST bodies were recovered by following Playwright's `_file` resource references through the bounded in-memory archive reader. All 16 recorded RPC requests were `eth_call`. The earlier method-unknown note reflected a missed resource field, not absence of the data. The bodies and parameters stay private, and no RPC access is enabled here.

## Implementation

- `readOnlyRequestUrls` and `blockedDependencyOrigins` are optional immutable terms fields, displayed and preserved in the brief editor. Whole-origin grants, exact API origins and blocked origins must be disjoint. At most seven supporting origins and twelve exact reads are allowed; witnessed isolation is required.
- Each issued manifest carries the exact GET rules and excluded origins. The broker records excluded attempts with a fixed anonymous `EXCLUDED_ORIGIN` reason; no connection or DNS resolution reaches them. Unexpected denials remain separate. The controller reports exclusions as untested features and never turns a failed journey or exhausted budget into a pass.
- The fixed driver compares an actual bounded API response with visible UI. It makes no claim that ranking order, every player row or score accuracy has been validated.
- This is a local controlled journey, not independent verification, a full Blokaz audit or production runner readiness. The deployed revision remains unconfirmed.

## Validation

- 49 focused project/runner/isolation database tests passed.
- 18 isolated proxy groups, two Chromium journeys and proxy-loss checks passed, including exact query/method/path/redirect restrictions and anonymous excluded-versus-unknown denial classification.
- The network-disabled owned ladder journey passed through real HTTP evidence ingestion and sanitized replay; terms editor fields were preserved. Wrong displayed count and an unexpected origin both remained blocked. No acceptance or payable was created.
- Build, lint and strict types passed; three existing storage tracing warnings remain.

## Commands

Owned, network-disabled validation:

```sh
npm run browser:preview -- --smoke --ladder
```

After approval of the exact public read:

```sh
npm run browser:preview -- --blokaz --ladder
```

The public source inspection found the leaderboard asset and API call on the already authorized Blokaz origin. It was read as bounded text, never executed on the host; the private source copies remain ignored. The new backend must not be contacted merely to prepare this plan.
