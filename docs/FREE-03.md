# Hosted staging and launch operations

FREE-03. Started 2026-11-03. **In progress.** Railway's web, worker and Postgres services are live as of 2026-11-04. **https://trialoom.xyz** serves the landing page and example workspace, with verified DNS/ownership, valid HTTPS, HTTP redirect and the authentication origin switched successfully. The generated Railway address remains attached. Public signup, hosted browser execution and sponsored purchases remain unavailable on this deployment. The custom-domain handoff is complete; FREE-03 remains open for the full-beta launch gates.

## Public marketplace rollout — 2026-11-05

D064 replaces the free-only/invited target with public self-service paid testing. The existing Railway services are still on their previous version; current local verification is recorded in STATUS/BUILD_LOG. Do not create duplicate web/worker/database services.

1. Deploy the reviewed web and worker code to the existing services, with worker pre-deploy `node scripts/migrate.ts`. Apply through 0030 before routing traffic: `/api/ready` now refuses older schemas. Public wallet entry uses `TRIALOOM_WALLET_LOGIN=true` and `TRIALOOM_PUBLIC_WALLET_SIGNUP=true`; email signup is separate and does not need to be enabled for this path. Preserve the existing production authentication secret and origin.
2. Configure one private S3-compatible bucket on the web and browser worker using the `TRIALOOM_S3_*` variables in `.env.example`. Never use public object ACLs. Validate upload/retrieval from both processes before accepting customer evidence. The local authenticated S3 fixture is not a hosted-bucket check.
3. Supply an authorized dedicated Ubuntu 24.04 host. Follow `runners/setup-linux-gvisor.sh --dedicated-runner`, install Node 24/project dependencies, and run `scripts/check-native-runner.ts` there. Use an encrypted database connection or approved private tunnel; do not expose credentials over an unprotected public database connection. The full cloud bootstrap is still unexecuted.
4. Enroll that checked host with the administrative `scripts/register-managed-runner.ts` CLI. Its mode-0600 output goes only to the browser host. Configure one private random 32-byte hexadecimal `TRIALOOM_RUNNER_DISPATCH_KEY` shared between web and browser worker, plus `TRIALOOM_RUNNER_API_ORIGIN=https://trialoom.xyz`, shared storage and database settings. Start the supplied systemd service. The browser host must never receive the settlement or sponsor signing key.
5. Configure the settlement worker's authorized agent and gas funding separately. Web policy verification is read-only. Builders link their own payer wallet, create their chosen Celo USDC policy in Remesso, and import its number. A fresh matching worker heartbeat, policy observation, proven owner and adequate limits are required before public publication/claims. Public admission conservatively checks daily capacity against campaign commitments. An allowance is not escrow.
6. Verify a real controlled website, public signup/operator qualification, one hosted evidence delivery and review, then one specifically authorized live payment and finalized receipt. Local fork settlement does not satisfy this live gate. Check crash recovery and shared evidence access on the actual host.

No new infrastructure purchase, extra spending budget or sponsor disclosure is authorized by this runbook. Linux host details, shared bucket connection, final dependency remediation and live settlement proof remain open. The first hosted paid executor is the read-only homepage test; arbitrary agent programs and broader journeys are not implied.

## What exists and was verified

Wallet onboarding was added locally on 2026-11-04 in [WALLET-01](WALLET-01.md). Deployment must apply migration 0025 before enabling `TRIALOOM_WALLET_LOGIN`; new wallet accounts additionally require `TRIALOOM_PUBLIC_WALLET_SIGNUP`. These switches are independent of email delivery and do not enable browser execution. Railway remains unchanged at this checkpoint.

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

Then set the pre-deploy command, which is the release gate. **Set it through the API and read it back, rather than typing it into the dashboard.** On 2026-11-04 the dashboard field was filled in and the service instance still reported `preDeployCommand: null` on both services — Railway stages dashboard configuration and applies it on a separate action — so the next deploy migrated nothing and crash-looped exactly like the one before it. Service and environment ids come from `railway status --json`.

```sh
railway api 'mutation($s:String!,$e:String!){ serviceInstanceUpdate(serviceId:$s, environmentId:$e, input:{ preDeployCommand:["node scripts/migrate.ts"] }) }' --raw-var s=WORKER_SERVICE_ID --raw-var e=ENVIRONMENT_ID
```

```sh
railway api 'mutation($s:String!,$e:String!){ serviceInstanceUpdate(serviceId:$s, environmentId:$e, input:{ preDeployTimeoutSeconds:300 }) }' --raw-var s=WORKER_SERVICE_ID --raw-var e=ENVIRONMENT_ID
```

**One element holding the whole command line, and the schema's type is misleading about that.** `ServiceInstanceUpdateInput.preDeployCommand` is `[String!]`, which reads like an argv, but `["sh","-c","node scripts/migrate.ts"]` is refused outright with `BAD_USER_INPUT` and `Error in preDeployCommand - Invalid input`. `["node scripts/migrate.ts"]` is accepted. The two fields are written in separate calls above because that is how each was confirmed; a single call setting both is untested.

Read it back before uploading, because a null here costs a whole deploy and reports nothing about itself:

```sh
railway api 'query($e:String!,$s:String!){ serviceInstance(environmentId:$e, serviceId:$s){ preDeployCommand preDeployTimeoutSeconds } }' --raw-var e=ENVIRONMENT_ID --raw-var s=WORKER_SERVICE_ID
```

Railway runs the command in a separate container with the service's variables, and a failure fails the deploy while the previous version keeps serving. The pre-deploy container has no volume access, which does not matter because migrations touch only Postgres.

**Set it before the first upload, not after.** A pre-deploy command runs only on the deploys that follow it, so a worker uploaded first starts against an empty schema and crash-loops until something redeploys it. This runbook had the two steps the other way round and that is exactly what happened on the first real deploy, 2026-11-04: eight restarts reporting `worker.failed` with no reason, because the catch logged the event and discarded the error. The worker now reports the SQLSTATE and a redacted message, so the same mistake reads as `{"event":"worker.failed","code":"42P01","detail":"relation \"assignments\" does not exist"}` and names itself — which is how the second crash was diagnosed in one read instead of guessed at.

```sh
railway up --service worker
```

### 4. The web service

Set everything knowable before the first upload, so only the authentication origin — which cannot exist until the domain does — forces a second deploy.

```sh
railway variable set DATABASE_URL='${{Postgres.DATABASE_URL}}' TRIALOOM_PUBLIC_SIGNUP=false RAILWAY_DOCKERFILE_PATH=Dockerfile --service web --skip-deploys
```

```sh
openssl rand -hex 32 | railway variable set BETTER_AUTH_SECRET --stdin --service web --skip-deploys
```

`--stdin` keeps the secret out of the command line and out of shell history, and `--stdin` takes one key only. Railway also supports **sealed** variables, whose values are never shown in the UI or returned by the API; sealing is a dashboard action and cannot be undone.

```sh
railway up --service web
```

**Read the port out of the container's own log before creating the domain.** Railway injects `PORT`, which overrides the `ENV PORT=3000` in the image: the container reports `http://0.0.0.0:8080`, and a domain created against 3000 routes to nothing.

```sh
railway logs --service web --deployment --lines 20
```

```sh
railway domain --service web --port 8080
```

That prints the generated address. `/api/health` answers on it straight away, before any authentication origin exists, because liveness reads no database and calls no auth — and it is the earliest point from which the privilege drop is visible.

```sh
railway variable set BETTER_AUTH_URL=https://GENERATED.up.railway.app --service web
```

No `--skip-deploys` on that one: the redeploy is how the new origin takes effect. `getAuth()` initializes and caches the auth instance lazily within each process. The new process reads the updated origin; health, readiness and the demo do not require an authenticated session.

`/` now serves the landing page with availability read from the deployment's configuration; `/demo` remains the seeded sample walkthrough. With `TRIALOOM_PUBLIC_SIGNUP=false`, `/sign-up` explains that signup is unavailable. Turning signup on requires `RESEND_API_KEY` and `TRIALOOM_EMAIL_FROM` on a verified domain first; signup refuses rather than falling back to a fake sender.

`TRIALOOM_EVIDENCE_DIR` is deliberately left unset. No volume is attached, nothing executes, and the entrypoint logs `container.evidence_ephemeral` so the state is visible rather than assumed. Attaching a volume later also requires `RAILWAY_RUN_UID=0`, which the entrypoint then turns back into an unprivileged process.

### 5. Verify, rather than assume

```sh
curl -s https://web-production-0928b.up.railway.app/api/health
```

Expect `mode: "invited-alpha"`, `testing: "unavailable"` and — the one that matters — **`privileged: false`**. If it reports `privileged: true`, Railway replaced the image's `ENTRYPOINT` and the privilege drop was bypassed; that is exactly why the field exists.

```sh
curl -s https://web-production-0928b.up.railway.app/api/ready
```

Expect `{"status":"ready"}`. A 503 `DATABASE_NOT_READY` means the pre-deploy migration has not run.

```sh
railway logs --service web --deployment --lines 20
```

Expect `container.dropping_privileges` when started as root, or `container.evidence_ephemeral` otherwise. `container.evidence_unwritable` means a configured evidence directory could not be written and the process refused to start.

### 6. Connect trialoom.xyz

**Complete on 2026-11-04.** The existing `web` service has custom domain `52814d09-8e4f-4153-bda4-0ae6d147a857`, targeting port **8080**. Public DNS resolves, Railway's ownership verification is true, and the certificate is `VALID` / `COMPLETE`. Ordinary HTTPS requests succeed with certificate validation enabled.

These records are saved under **Namecheap → Domain List → Manage → Advanced DNS → Host Records**, with the default TTL. Keep them in place:

| Type | Host | Value |
| --- | --- | --- |
| ALIAS | `@` | `wm8pongc.up.railway.app` |
| TXT | `_railway-verify` | `railway-verify=34da93e994c2e9a7a9a8a5d033e18c02a53c10d7e56691d047adfca8fa2f1089` |

These are the values returned by Railway for this custom domain, not the generated site's address. Namecheap uses ALIAS for an apex hostname. The user made the DNS changes; this session verified the result with public reads only.

**The initial propagation delay is resolved.** Both authoritative Namecheap servers returned the correct routing address and ownership TXT was correct while the new domain's delegation was still absent from registry DNS. A later public DNS check now returns those nameservers, A address `69.46.46.97` and the exact TXT; Railway verifies ownership and HTTPS succeeds. The dated diagnostic history is preserved in [BUILD_LOG.md](../memory/BUILD_LOG.md).

**Railway diagnostic caveat:** its raw CNAME record detail still reports `REQUIRES_UPDATE` and an empty current value, while Namecheap serves a flattened ALIAS. Actual public DNS, verified ownership, valid TLS and successful HTTP requests demonstrate working routing. Keep the apex ALIAS; do not replace it just to satisfy the raw CNAME diagnostic.

After DNS and HTTPS passed, the web authentication origin was changed with:

```sh
railway variable set BETTER_AUTH_URL=https://trialoom.xyz --service web
```

Railway web deployment `f4b2b6f0-58b6-496d-99b4-500b440f4e80` succeeded. A filtered variable readback confirms `BETTER_AUTH_URL=https://trialoom.xyz` without printing any secrets. Final live checks: `/`, `/demo` and `/sign-in` return 200; an anonymous `/api/auth/get-session` returns 200 with `null`; `/workspace` returns 307 to `/sign-in`; `/api/health` returns 200 with `privileged: false`, `testing: unavailable`; `/api/ready` returns 200 with `status: ready`. HTTP redirects to the same HTTPS origin with 301. `/sign-up` still shows the unavailable notice. No real account sign-in was performed. The generated Railway address remains attached and serves the landing page. [Machine-readable checkpoint](evidence/FREE-03.json).

Domain connection does not configure signup email or open hosted testing. No feature flag, signing key, account data or DNS record was changed during the authentication-origin redeploy.

Sources checked 2026-11-04: [Railway domain routing and ownership verification](https://docs.railway.com/networking/domains/working-with-domains), [Namecheap apex ALIAS records](https://www.namecheap.com/support/knowledgebase/article.aspx/10128/2237/how-to-create-an-alias-record/).

## Remaining gates

Hosting, custom-domain HTTPS and the authentication-origin switch are verified. Remaining full-beta gates stay open; several need an account or a payment and are the user's to decide.

| Gate | Owner | State |
| --- | --- | --- |
| A host | User | **Railway, chosen 2026-11-03; deployed 2026-11-04.** Web, worker and Postgres online |
| A domain | User / us | `trialoom.xyz` live; public DNS, ownership and authentication origin verified |
| TLS termination and HTTPS redirect | Us | Valid certificate on `trialoom.xyz`; HTTP returns 301 to HTTPS; generated Railway HTTPS remains available |
| Verified sending domain for signup mail | User | Not started. Signup is unusable without it |
| Secret storage and separate process credentials | Us | Railway runtime variables configured for the live services; production credential separation, rotation and access review remain open |
| Linux runner host adapter and a server gVisor bootstrap | Us | Not started, and not reachable on Railway: its containers are non-privileged. Gates hosted execution, and with it the free-beta promise |
| S3-compatible private evidence store | Us | Not started. Required once execution is hosted, because a Railway volume attaches to one service only |
| Backup and a verified restore | Us | Not started |
| Monitoring and alerting | Us | Not started |
| Retention and deletion of private evidence | Us | Not started |
| Trusted edge rate limits and abuse response | Us | Not started. Forwarded-IP headers are deliberately not trusted today |

A hosted deployment that serves signup without the execution path is honest only while it says so. Do not advertise testing availability before hosted execution is verified — that promise is recorded in [FREE-BETA.md](FREE-BETA.md).
