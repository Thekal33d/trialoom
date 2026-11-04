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

Build the two images. They are two files rather than two targets of one file because Railway builds a Dockerfile's last stage and offers no way to select a target:

```sh
docker build -t trialoom-app .
```

```sh
docker build -f Dockerfile.worker -t trialoom-worker .
```

Migrations are an explicit release step, never a side effect of a request or of worker start:

```sh
docker run --rm -e DATABASE_URL=... trialoom-worker node scripts/migrate.ts
```

## Railway, chosen 2026-11-03

The user chose Railway for the web process, the worker and Postgres. It cannot host the runner, so hosted execution stays out of scope until a Linux host exists. Checked against Railway's live documentation on 2026-11-03.

**What fits with no code change.** Automatic SSL certificates and custom domains cover HTTPS, and `authSettings()` already refuses a non-HTTPS `BETTER_AUTH_URL` on a non-loopback host. Private networking is dual-stack for environments created after 2025-10-16 and encrypted with Wireguard, so `DATABASE_URL` over `<service>.railway.internal` needs neither TLS nor a change to `createPool`. Migrations belong in the **pre-deploy command**, which Railway runs in a separate container with the service's variables and whose failure fails the deploy while the previous version keeps serving — exactly the release gate `scripts/migrate.ts` wants. The pre-deploy container has no volume access, which does not matter because migrations touch only Postgres.

**What had to change.**

- **Two Dockerfiles.** Railway's build configuration exposes `builder`, `dockerfilePath`, `buildCommand`, `watchPatterns` and `railpackVersion`, and no build target. The web service builds the default [`Dockerfile`](../Dockerfile); the worker service sets `RAILWAY_DOCKERFILE_PATH=Dockerfile.worker`.
- **An entrypoint that refuses to serve as root.** Railway mounts volumes as root and documents `RAILWAY_RUN_UID=0` for images running as a non-root user — which would make the internet-facing process root for the sake of one directory. [`scripts/container-entrypoint.sh`](../scripts/container-entrypoint.sh) accepts the privilege, fixes the mount point to `1000:1000` mode `700`, then re-executes itself unprivileged, so the application never runs privileged on any host. It also refuses to start when a configured evidence directory cannot be written, because discovering that on the first stored artifact loses private evidence that cannot be regenerated, and says out loud when no directory is configured and artifacts would therefore be lost on redeploy.
- **`/api/health` reports `privileged`,** so the result is checkable from outside instead of trusted. Verified: started with `--user 0:0` against a root-owned volume, `/proc/1/status` reports `Uid: 1000 1000 1000 1000` and health reports `privileged: false`.

**Configuration is not written as `railway.json`.** Config as Code is deprecated in favour of Infrastructure as Code, with legacy files working only until 2026-12-01.

**Cost.** The free tier is 1 vCPU and 0.5 GB RAM with $1 of monthly credit, which will not run this. Hobby is $5/month including $5 of usage, with per-service ceilings far above what is needed.

**A gate this makes load-bearing.** Railway attaches a volume to one service only, so the web process and the worker cannot share the private evidence store on a volume. It does not bite yet, because a deployment without hosted execution produces no evidence and the demo routes serve static fixture data. The moment execution is hosted, the S3-compatible private object storage that [ARCHITECTURE.md](ARCHITECTURE.md) already records as the intended store stops being deferrable.

**Two things to verify after the first deploy, not assumed.** Whether a custom Start Command preserves the image's `ENTRYPOINT` — if Railway replaces it, the privilege drop is bypassed and `/api/health` will report `privileged: true`, which is why it reports it. And whether the no-target, non-privileged and one-volume-per-service limits still hold: those rest partly on staff replies and community threads rather than formal documentation, and Railway has hinted at a future VM-based runtime that would change the runner answer.

## Provisioning runbook

Written 2026-11-03 against Railway CLI 5.68.0 and Railway's live documentation. Nothing here has been run: every step creates billable resources or publishes something on the user's account, so these are the user's commands.

**Deploy by CLI upload, not by connecting a repository.** Railway's git integration is GitHub-centric — `railway add --repo` and `railway service source connect --repo` both describe GitHub — and this project's GitHub account is suspended. `railway up` uploads the working directory instead, which sidesteps the question entirely and also means unpushed commits deploy without pushing anything.

**Two safety rules before the first command.**

- **Never pass `--no-gitignore` to `railway up`.** The upload respects `.gitignore` by default and always skips `.git` and `node_modules`; `git check-ignore` confirms `.env` is ignored, so the database password, the authentication secret and any signing key stay on the machine. `--no-gitignore` would upload all of it.
- **Do not create a `.railwayignore`.** It is unnecessary here — the tracked tree is 345 files and 4.3 MB — and copying `.dockerignore` into one has been reported to exclude the Dockerfile itself.

### 1. Project and database

```sh
railway init --name trialoom
```

```sh
railway add --database postgres
```

Railway deploys databases private by default. Leave it that way: `DATABASE_URL` is then the internal connection string, reachable over the project's Wireguard-encrypted private network, and no public TCP proxy exists to find. Enabling public access would populate `DATABASE_PUBLIC_URL` and bill egress.

### 2. Two services

```sh
railway add --service worker && railway add --service web
```

### 3. The worker carries the schema authority

The web image is Next's traced bundle and contains no project source, so **it cannot run migrations at all.** That is worth keeping: the internet-facing process has no way to alter the schema. Migrations run from the worker image.

```sh
railway variable set DATABASE_URL='${{Postgres.DATABASE_URL}}' RAILWAY_DOCKERFILE_PATH=Dockerfile.worker --service worker --skip-deploys
```

Then, in the dashboard — this is the one step with no CLI equivalent — set **worker → Settings → Deploy → Pre-deploy Command** to `node scripts/migrate.ts`. Railway runs it in a separate container with the service's variables, and a failure fails the deploy while the previous version keeps serving. The pre-deploy container has no volume access, which does not matter because migrations touch only Postgres.

**Set it before the first upload, not after.** A pre-deploy command runs only on the deploys that follow it, so a worker uploaded first starts against an empty schema and crash-loops until something redeploys it. This runbook had the two steps the other way round and that is exactly what happened on the first real deploy, 2026-11-04: eight restarts reporting `worker.failed` with no reason, because the catch logged the event and discarded the error. The worker now reports the SQLSTATE and a redacted message, so the same mistake reads as `{"event":"worker.failed","code":"42P01","detail":"relation \"assignments\" does not exist"}` and names itself.

```sh
railway up --service worker
```

### 4. The web service

```sh
railway up --service web
```

```sh
railway domain --service web --port 3000
```

`/api/health` answers before the authentication origin is configured, because liveness reads no database and calls no auth. Curl it now: it is the earliest point at which the privilege drop is visible.

```sh
railway variable set BETTER_AUTH_URL=https://REPLACE.up.railway.app DATABASE_URL='${{Postgres.DATABASE_URL}}' TRIALOOM_PUBLIC_SIGNUP=false --service web --skip-deploys
```

```sh
openssl rand -hex 32 | railway variable set BETTER_AUTH_SECRET --stdin --service web
```

`--stdin` keeps the secret out of the command line and out of shell history. Railway also supports **sealed** variables, whose values are never shown in the UI or returned by the API; sealing is a dashboard action and cannot be undone.

`TRIALOOM_PUBLIC_SIGNUP=false` makes `/` redirect to `/demo`, the seeded sample walkthrough. That needs no sending domain and no runner, so it is the honest first deployment. Turning signup on requires `RESEND_API_KEY` and `TRIALOOM_EMAIL_FROM` on a verified domain first; signup refuses rather than falling back to a fake sender.

`TRIALOOM_EVIDENCE_DIR` is deliberately left unset. No volume is attached, nothing executes, and the entrypoint logs `container.evidence_ephemeral` so the state is visible rather than assumed. Attaching a volume later also requires `RAILWAY_RUN_UID=0`, which the entrypoint then turns back into an unprivileged process.

### 5. Verify, rather than assume

```sh
curl -s https://REPLACE.up.railway.app/api/health
```

Expect `mode: "invited-alpha"`, `testing: "unavailable"` and — the one that matters — **`privileged: false`**. If it reports `privileged: true`, Railway replaced the image's `ENTRYPOINT` and the privilege drop was bypassed; that is exactly why the field exists.

```sh
curl -s https://REPLACE.up.railway.app/api/ready
```

Expect `{"status":"ready"}`. A 503 `DATABASE_NOT_READY` means the pre-deploy migration has not run.

```sh
railway service logs --service web
```

Expect `container.dropping_privileges` when started as root, or `container.evidence_ephemeral` otherwise. `container.evidence_unwritable` means a configured evidence directory could not be written and the process refused to start.

## Remaining gates

Nothing below is done. Several need an account or a payment and are the user's to decide.

| Gate | Owner | State |
| --- | --- | --- |
| A host | User | **Railway, chosen 2026-11-03.** Nothing provisioned yet |
| A domain | User | Not held. A Railway-provided domain would serve as `demoUrl` |
| TLS termination and HTTPS redirect | Us, once a host exists | Not started |
| Verified sending domain for signup mail | User | Not started. Signup is unusable without it |
| Secret storage and separate process credentials | Us, once a host exists | Images are separate; no secret store chosen |
| Linux runner host adapter and a server gVisor bootstrap | Us | Not started, and not reachable on Railway: its containers are non-privileged. Gates hosted execution, and with it the free-beta promise |
| S3-compatible private evidence store | Us | Not started. Required once execution is hosted, because a Railway volume attaches to one service only |
| Backup and a verified restore | Us | Not started |
| Monitoring and alerting | Us | Not started |
| Retention and deletion of private evidence | Us | Not started |
| Trusted edge rate limits and abuse response | Us | Not started. Forwarded-IP headers are deliberately not trusted today |

A hosted deployment that serves signup without the execution path is honest only while it says so. Do not advertise testing availability before hosted execution is verified — that promise is recorded in [FREE-BETA.md](FREE-BETA.md).
