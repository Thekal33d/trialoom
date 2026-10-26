# Accounts, projects, and versioned terms

Verified locally on 2026-10-27. This is the ALPHA-02 foundation for FR01–FR03. The real application lives at `/workspace`; `/demo` retains its labelled synthetic data. [Evidence](evidence/ALPHA-02.json) records checks and exact source hashes.

## Invitation-only access

Better Auth 1.7.14 supplies password verification and PostgreSQL-backed sessions. Public signup is disabled both in the SDK and in the HTTP route allowlist. A local administrative command creates the first workspace and owner invitation:

```sh
npm run setup:auth
npm run db:migrate
npm run workspace:invite -- owner@example.com My workspace
```

The command prints the path of an ignored, owner-readable invitation file. It sends no email. Open the URL in that file, choose a name and password, and join. The link expires after 72 hours and can be consumed once. Only a SHA-256 digest of its random 256-bit token is stored in PostgreSQL; the URL fragment is removed from browser history after loading. Lost links cannot be retrieved from the database. Workspace owners create/revoke subsequent invitations in Workspace access.

Invitation possession is the access credential for a new account; it does **not** verify email ownership. Existing accounts must authenticate as the invited email before joining. An invitation never replaces an existing password or silently upgrades an existing membership. There is no public password-reset, email-delivery, or email-change workflow in this step. Passwords use the SDK's scrypt implementation; sessions last seven days, refresh hourly, and use HttpOnly/SameSite=Lax cookies, with Secure required on HTTPS. Cookie caching is disabled so expiry and revocation use database state.

`BETTER_AUTH_URL` is a single trusted origin. HTTP is accepted only on loopback; other environments require HTTPS. Secrets must have at least 32 characters and cannot use the example placeholder. Local setup generates a random secret without printing it. Changing ports requires updating this origin as well as the server port. Production secrets must be generated and provisioned privately.

## Role boundaries

Every service checks workspace membership inside the database transaction. Client controls are convenience only. Membership revocation takes effect on the next request even if the account's session remains valid for another workspace. Owner changes are serialized and the last owner cannot be removed.

| Action | Owner | Member | Reviewer | Operator |
| --- | --- | --- | --- | --- |
| See own workspace membership | Yes | Yes | Yes | Yes |
| Read projects, builds, and terms | Yes | Yes | Yes, audited | No |
| Create projects, builds, draft briefs, term versions | Yes | Yes | No | No |
| Invite/revoke, remove members, view access history | Yes | No | No | No |
| Manage payment authority | Reserved for owner; no endpoint yet | No | No | No |
| Access assigned execution materials | Future assignment-scoped endpoint | — | — | Not implemented yet |

Reviewer reads and access changes create append-only audit events. Workspace access displays the latest 50 events; it is not a complete audit export. No customer traces, credentials, or code are accepted here.

## Target approval and pinned builds

Project creation requires an explicit permission attestation and a preview/staging environment. Admission accepts public HTTPS origins without credentials, query parameters, fragments, or custom ports. All DNS answers must be public unicast addresses; unresolved, private, reserved, mapped-private, mixed public/private, and internal targets fail closed. DNS checks have a three-second timeout. The application performs no target-page fetch or test execution during admission.

The immutable project records the approving user, authorization version/time, environment, origin, and admitted addresses. This records a builder's declaration, not independently proven domain ownership. Each build pins a supplied revision/deployment identifier, fixture version, and same-origin URL after another admission check. These database records cannot be changed or deleted through normal SQL operations; a new target requires a new approval/project, and a new revision requires a new build record. The application does not yet prove that a mutable deployment URL serves the supplied revision.

Admission is **not runner isolation**. ALPHA-05 must revalidate DNS, redirects, actual build identity, network egress, credentials, and resource limits at execution time. The optional repository URL is metadata and grants no repository access.

## Terms and concurrency

The UI calls a draft campaign a **work brief**. Creating a brief atomically creates version 1 with a pinned build, service, scope, allowed/excluded actions, acceptance criteria, reward rubric/cap, delivery deadline, review window, artifact rights, resource allowance, platform fee, and payment terms. Scope approval is explicit and its actor/time are retained. Money uses decimal strings of integer USDC base units; the UI converts decimal input using BigInt without floating-point arithmetic. Currency is fixed to the verified Celo USDC deployment, chain 42220, six decimals; no contract transaction is performed.

Every edit inserts a new immutable row and SHA-256 hash of canonical JSON. A locked campaign counter and `expectedVersion` ensure concurrent edits produce one next version and an HTTP 409 for stale editors. Composite foreign keys prevent cross-project build/brief references. Old versions remain inspectable in the UI and unchanged in storage.

Campaigns can only be `draft`. Publishing, claims, acceptance, and payment authority are absent. **ALPHA-04 must bind every claim to one exact `terms_versions.id` and `build_id` in the claim/reservation transaction; downstream work must never resolve an existing claim through `latest_version`.** The ALPHA-02 checks prove preservation and conflict handling; they do not claim that future assignment integration or full FR03/R05 has passed.

## HTTP surface

All mutations require the configured Origin and JSON bodies limited to 32 KiB. Private responses use `Cache-Control: no-store`, cookie variation, generic unexpected-error responses, and request IDs. No external-origin CORS permission is granted.

| Route | Methods / purpose |
| --- | --- |
| `/api/auth/sign-in/email`, `/api/auth/sign-out` | POST; SDK session lifecycle |
| `/api/auth/get-session` | GET; current session |
| `/api/v1/invitations/inspect`, `/api/v1/invitations/accept` | POST; private token inspection/consumption |
| `/api/v1/me`, `/api/v1/workspaces` | GET; authenticated identity and memberships |
| `/api/v1/workspaces/:workspace/access` | GET; owner access management view |
| `/api/v1/workspaces/:workspace/invitations` | POST; owner creates invitation |
| `/api/v1/workspaces/:workspace/invitations/:invitation` | DELETE; owner revokes |
| `/api/v1/workspaces/:workspace/members/:user` | DELETE; owner removes membership |
| `/api/v1/workspaces/:workspace/projects` | GET/POST; permitted project listing/creation |
| `/api/v1/workspaces/:workspace/projects/:project` | GET; permitted project detail |
| `/api/v1/workspaces/:workspace/projects/:project/builds` | POST; pin a build |
| `/api/v1/workspaces/:workspace/projects/:project/campaigns` | POST; draft brief and initial terms |
| `/api/v1/workspaces/:workspace/projects/:project/campaigns/:campaign/terms` | POST; append terms with expected version |

Atomic database limits apply per minute: 200 authentication mutations globally, 10 sign-in attempts per normalized email, 60 invitation operations globally, and 100 authenticated mutations per user. Limiter identities are hashed and forwarded-IP headers are not trusted. These are initial local-alpha limits; production still needs a trusted perimeter, abuse handling, cleanup of expired limiter/session records, and operational tuning. Operator credentials and idempotent assignment mutations belong to ALPHA-03/04.

## Verification and remaining gates

The database suite checks real SDK authentication, expiry/revocation, invitation races, existing-account takeover refusal, role/tenant isolation, reviewer auditing, public-target admission, immutable records, exact monetary units, and concurrent term edits. Browser checks use a disposable database, random private credentials, production servers, and both desktop/mobile Chromium. They exercise onboarding, sign-in/out, access management, target rejection, a complete project/build/term revision flow, persistence after reload, role restrictions, origin/body/rate limits, accessibility, and viewport overflow.

Production deployment, secure operational identities, recovery/email verification, audit retention/export, independent operators, claims/ledger, payment authority, actual execution, and private artifact storage remain separate gates. The local app does not complete the marketplace release scenarios or establish hackathon eligibility.

## Official references checked 2026-10-27

- [Better Auth installation and PostgreSQL](https://better-auth.com/docs/installation), [database](https://better-auth.com/docs/concepts/database), [email/password](https://better-auth.com/docs/authentication/email-password), [Next.js](https://better-auth.com/docs/integrations/next), [configuration](https://better-auth.com/docs/reference/options), [rate limits](https://better-auth.com/docs/concepts/rate-limit).
- [Zod API](https://zod.dev/api), [ipaddr.js maintainer repository](https://github.com/whitequark/ipaddr.js).
- [Circle's USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses), cross-checked against the prior [Celo fork evidence](evidence/VAL-03.json).
