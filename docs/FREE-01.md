# FREE-01 — Verified public signup

Implemented locally on 2026-11-01. [Release scope](FREE-BETA.md). This is a signup/project-setup checkpoint; no hosted beta, real email delivery or automatic free test is claimed.

## Flow and boundaries

`/sign-up` requests an email link. A 32-byte random token is stored only as a SHA-256 digest for 30 minutes. The public response contains no token and is identical for new and existing email addresses. Both receive the same email; no account or password is created before possession of the link is demonstrated.

The link carries its token in a URL fragment. `/sign-up/complete` removes the fragment immediately, inspects the token through same-origin POST, and asks for name, workspace and password. Completion serializes by email using the same advisory lock as invitation acceptance; account, password hash, owner membership, free entitlement and audit event commit together. All pending signup tokens for that email are consumed. Existing accounts cannot be overwritten and pending invitations are not silently accepted.

Better Auth still supplies password hashing, credential sign-in and HttpOnly sessions. Its unrestricted signup endpoint remains disabled. The existing invitation flow is retained for established workspaces.

A free account owns one free workspace and can create three authorized preview/staging projects. A locked entitlement row enforces that cap under concurrent creation. The free UI shows setup availability honestly. Paid campaign creation/publication, payment authority registration, operator registration and invitations that could bypass the operator boundary are refused server-side. This checkpoint creates no campaign, payable or payment permission.

## Configuration

- `TRIALOOM_PUBLIC_SIGNUP=true` enables the signup route and routes the home page to it. Default is false.
- `RESEND_API_KEY` and `TRIALOOM_EMAIL_FROM` configure a verified sender. Keep secrets in the deployment secret store/ignored environment.
- `BETTER_AUTH_URL` supplies the exact trusted origin; never infer verification-link origins from request headers.

Missing mail configuration returns a visible unavailable response. The Resend adapter uses the fixed HTTPS endpoint, a ten-second timeout, no redirects, plain-text mail and a per-message idempotency key. Provider error bodies and capability links never enter API errors/logs. A failed delivery can be retried by requesting another email; that never resets an existing password. No user email was sent during validation. Reference checked 2026-11-01: [Resend send API](https://resend.com/docs/api-reference/emails/send-email).

Requests require the configured origin, accept at most 4 KiB, and use atomic database limits: 30 signup operations/minute globally, 10 completions/minute, three email requests/address per 15-minute window and 200 mail requests per 24-hour window globally. Forwarded-IP headers are not trusted. A production edge control, account recovery, expired-token/limiter cleanup and abuse response remain FREE-03 release gates. Multiple verified emails are not considered proof of different humans.

## Verification

- 60 focused database checks passed: seven signup cases plus existing account/project/operator/authority checks. Signup tests cover expiry, digest-only storage, real SDK sign-in, competing links, existing credentials and pending invitations, injected-role rejection, concurrent project cap, foreign access and actual paid-publication/authority/operator refusals.
- 20 desktop/mobile browser checks passed across existing accounts and signup. New cases exercise missing-mail error, rate/origin/body limits, captured verification link, atomic signup, session, project persistence, private-target refusal, operator refusal and consumed link. Captured mail is a disposable test fixture, not a live email or production bypass.
- Accessibility and overflow checks pass on signup and free workspace. Desktop signup and mobile workspace screenshots visually inspected.
- Lint, strict types and production build pass. The build retains the same three existing private-storage tracing warnings.

Run the focused browser checks with `TRIALOOM_PUBLIC_SIGNUP=true node --env-file-if-exists=.env scripts/test-browser.ts tests/browser/signup.spec.ts tests/browser/accounts.spec.ts`. The harness strips mail credentials and uses disposable data.
