# Hosted staging and launch operations

FREE-03. Started 2026-11-03. **In progress.** This records what is verified, what the remaining gates are, and who owns each one. Nothing here is deployed; no host, domain, mail sender or secret store is provisioned.

## What exists and was verified

Two deployable images from one source tree, built from [`Dockerfile`](../Dockerfile). The web process and the worker are separate images so they can hold separate credentials: the worker is the only process that needs a signing key, and the web process is the only one reachable from the internet. The base image is pinned by digest, because a floating tag lets a rebuilt release differ from the one that was checked.

Verified on 2026-11-03 against a **fresh disposable database** on the local Postgres, which touched no existing records:

| Check | Result |
| --- | --- |
| Web image builds with no warning or error | 435 MB image, 63 MB of application content |
| Worker image builds | 1.11 GB, of which 578 MB is `node_modules` |
| `node scripts/migrate.ts` from the worker image, empty database | 23 migrations applied, `0001` through `0023_sponsored_purchases.sql` |
| `/api/ready` with that database | `{"status":"ready"}`, HTTP 200 |
| `/api/health` with **no** `DATABASE_URL` at all | HTTP 200 — liveness genuinely does not touch the database |
| `/api/ready` with no `DATABASE_URL` | HTTP 503 `DATABASE_NOT_READY`, no detail leaked |
| `/` with public signup enabled | 307 to `/sign-up` |
| `/sign-up` | HTTP 200 |
| Process identity inside the container | `uid=1000(node)`, not root |

`/api/health` now reports this deployment's **configured** mode rather than a label written into the source. A hardcoded `invited-alpha` was a claim about the release that a container started with other settings would quietly make false.

## Two findings worth keeping

**The bundler traced the whole project into the server output.** `src/server/storage.ts` resolves the private evidence directory from `TRIALOOM_EVIDENCE_DIR` at run time, and static analysis concluded from that dynamic path that it had to trace everything — which copies every source file *and all of `public/`* into the deployed server directory. The three calls are now explicitly opted out, because that directory is a mounted volume holding private evidence and is never content to bundle. With the opt-out, the web image contains `.next`, `node_modules`, `public`, `package.json` and `server.js` and no `src/`, `docs/`, `tests/`, `db/` or `scripts/`. The fix was found only by building the image; it is invisible from `npm run build` in the repository.

**The build context must mirror the type-check scope, not the deployed file set.** `next build` type-checks the whole project per `tsconfig.json`, which includes `scripts/`, `tests/` and `playwright.config.ts`, and those import from `spikes/`. Each attempt to narrow the context failed with `TS2307: Cannot find module`, not with a useful message. [`.dockerignore`](../.dockerignore) therefore excludes only credentials, private evidence and regenerated output. Keeping the project out of the *image* is the bundler's job, as above.

## The runner cannot be hosted on a managed container platform

[D013](../memory/DECISIONS.md) selected a Render Docker web service and background worker. That still fits the web and worker processes. It does not fit **execution**, for two independent reasons:

- `scripts/preview-host.ts` sends every host command through `remote()`, which shells out to `orb` — the OrbStack CLI, which exists only on macOS. A Linux container has no `orb`.
- The sandbox requires `runsc-preview` registered as a runtime on the Docker daemon that starts the browser, and [`runners/setup-local-gvisor.sh`](../runners/setup-local-gvisor.sh) installs gVisor into that daemon. A managed container platform does not expose its daemon, and nesting a second one inside a container does not give the syscall boundary the isolation evidence depends on.

`remote()` is a single chokepoint — one `spawnSync('orb', [...machine, ...args])` — so a Linux host adapter is a configurable command prefix rather than a rewrite. The bootstrap script needs a server variant either way: it refuses any host but the OrbStack machine (`hostname = trialoom-runner`, no `/mnt/mac`, no forwarded SSH agent), and its VFS storage driver is recorded in [RUN-03-HOST.md](RUN-03-HOST.md) as a local compatibility choice, not a production default.

Until that exists, a hosted deployment can serve signup, the workspace and the recorded sample, and must report testing as unavailable rather than queue tests that cannot run. `/api/health` reports exactly that, and `freeTestsEnabled()` already refuses to start the free worker without it.

## Environment contract

The web process needs `DATABASE_URL`, `BETTER_AUTH_URL` (must be `https:` for any non-loopback host — [`src/server/auth/config.ts`](../src/server/auth/config.ts) refuses otherwise, and secure cookies key off it), `BETTER_AUTH_SECRET`, `TRIALOOM_EVIDENCE_DIR` on a persistent volume, and `TRIALOOM_PUBLIC_SIGNUP`. Mail delivery needs `RESEND_API_KEY` and `TRIALOOM_EMAIL_FROM` on a verified sending domain; signup refuses rather than falling back to a fake sender. The worker needs `DATABASE_URL`, and nothing else unless payment or sponsored purchasing is deliberately enabled. Full annotations are in [`.env.example`](../.env.example).

Build the two images:

```sh
docker build --target app -t trialoom-app .
docker build --target worker -t trialoom-worker .
```

Migrations are an explicit release step, never a side effect of a request or of worker start:

```sh
docker run --rm -e DATABASE_URL=... trialoom-worker node scripts/migrate.ts
```

## Remaining gates

Nothing below is done. Several need an account or a payment and are the user's to decide.

| Gate | Owner | State |
| --- | --- | --- |
| A host and a domain | User | Not chosen. Decides the orchestration shape and whether execution can be hosted at all |
| TLS termination and HTTPS redirect | Us, once a host exists | Not started |
| Verified sending domain for signup mail | User | Not started. Signup is unusable without it |
| Secret storage and separate process credentials | Us, once a host exists | Images are separate; no secret store chosen |
| Linux runner host adapter and a server gVisor bootstrap | Us | Not started. Gates hosted execution, and with it the free-beta promise |
| Backup and a verified restore | Us | Not started |
| Monitoring and alerting | Us | Not started |
| Retention and deletion of private evidence | Us | Not started |
| Trusted edge rate limits and abuse response | Us | Not started. Forwarded-IP headers are deliberately not trusted today |

A hosted deployment that serves signup without the execution path is honest only while it says so. Do not advertise testing availability before hosted execution is verified — that promise is recorded in [FREE-BETA.md](FREE-BETA.md).
