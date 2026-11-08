# HOST-01 — Single-host consolidation and session handoff

Written 2026-11-08 (Africa/Lagos) for a new agent taking over this work. It records where the
build actually stands, the hosting decision the user made, and the ordered steps to run
Trialoom on one Hetzner server instead of Railway plus a separate runner host.

Read [AGENTS.md](../AGENTS.md) first, then [memory/PROJECT.md](../memory/PROJECT.md),
[memory/STATUS.md](../memory/STATUS.md) and the latest [memory/BUILD_LOG.md](../memory/BUILD_LOG.md)
entries. This file is the hosting plan only; it does not replace those.

## 1. Where we are

**Application code.** The D064 public self-service paid-testing remodel is implemented and
verified **locally**: public registration without invitations, self-service website permission,
native Linux/gVisor execution, private S3 evidence transport, a durable paid queue, and the
builder/operator product flow. Local checks pass: 348 backend, 28 capability, 86 desktop/mobile,
a 44-step acceptance/repair/recovery loop and 19 Celo-fork settlement checks. Both production
images build and the container smoke applies all 30 migrations, starts non-root, serves the
public entry, runs the worker with signing disabled and refuses outdated schemas. Backlog:
MARKET-01 to MARKET-04 done locally, MARKET-05 (public release verification) in progress.

**Live deployment.** Railway runs `trialoom` with web, worker and PostgreSQL services at the
**pre-remodel** version. `https://trialoom.xyz` serves the landing page and an example workspace
with valid HTTPS; DNS uses Namecheap nameservers pointing at Railway. Public signup, hosted
browser execution and sponsored purchases are **not** available on that deployment. No remodel
feature is live anywhere.

**Git.** Branch `main` is 42 commits ahead of `origin/main`. Nothing has been pushed. Pushing,
publishing and deploying still need the user's explicit authorization.

**Hosting budget.** D068 (2026-11-07): at most **US$10/month total**, including any retained
Railway subscription, actual usage and applicable taxes. That is a ceiling, not authorization to
buy, migrate or cancel anything.

**The decision this file serves.** On 2026-11-08 the user asked whether Railway could be dropped
entirely in favour of a single Hetzner server, and asked for these steps in writing because they
are continuing with another agent. Railway is not a technical requirement; consolidating onto one
host is feasible but **has not been implemented or verified**. See D069 in
[memory/DECISIONS.md](../memory/DECISIONS.md).

## 2. Verified, unverified, and not permitted

**Verified (local only).**
- Two images build from one tree: [`Dockerfile`](../Dockerfile) (web) and
  [`Dockerfile.worker`](../Dockerfile.worker). The web image carries no project source.
- Migrations 0001–0030 apply from the worker image to an empty database; `/api/ready` returns 503
  on an older schema, `/api/health` does not touch the database.
- gVisor browser isolation passed on a dedicated **Ubuntu 24.04/arm64** OrbStack machine
  (`runsc release-20261026.0`, systrap platform): no external network, read-only root and `/tmp`,
  uid 65534, no capabilities, bounded CPU/memory/processes, verified container removal.
  See [RUN-03-HOST.md](RUN-03-HOST.md).
- One real isolated paid test delivered evidence end to end after a lost-acknowledgement recovery.

**Unverified — treat as open work.**
- Any Hetzner server: availability, price actually charged, x86 vs Arm behaviour, gVisor operation
  on that kernel, and bounded single-job performance.
- Running web, PostgreSQL, the payment worker and the browser controller on **one** 2 vCPU / 4 GB
  machine with isolation intact.
- A hosted private object store. Only a local authenticated S3 fixture has been exercised.
- TLS termination and a reverse proxy. The repository contains **no** Caddy, nginx or certbot
  configuration; Railway supplied HTTPS. This is new work.
- Backups of any kind. There is no backup tooling in the repository.
- A live authorized payment with a finalized receipt.

**Not permitted without a fresh user instruction.**
- Buying a server or any paid service, cancelling Railway, changing DNS, deploying, or pushing.
- Raising the $10/month ceiling or the existing 50,000/20,000-unit payment authorizations.
- The pending usebuy disclosure: approval for report `c8bd29d8-e9d9-41da-b27b-87ebaf50a1c0` /
  test `02dc8b1b-abd7-4653-a892-6d96e6d87535` is still outstanding. Do not bypass it or create a
  second purchase on ambiguous settlement; per-report cap stays 10,000 units.
- Automatically merging or deploying a repair. Repairs go to builder review.
- Writing credentials, signing keys, invitation tokens, private traces or the user's email into
  the repository or logs.

## 3. Hosting cost, checked 2026-11-08

Hetzner Cloud lists prices in **euro, excluding VAT**, and the USD figures come from a client-side
currency switch. Read in the page text today:

| Plan | Price | Resources | Architecture |
| --- | --- | --- | --- |
| CX23 | €5.99/mo excl. VAT | 2 vCPU, 4 GB RAM, 40 GB NVMe, 20 TB traffic | Intel/AMD (x86) |
| CAX11 | €6.49/mo excl. VAT | 2 vCPU, 4 GB RAM, 40 GB NVMe, 20 TB traffic | Ampere (Arm) |
| CPX02 | €6.49/mo excl. VAT | 1 vCPU, 1 GB RAM, 20 GB NVMe | AMD (x86) — too small |
| CX33 | €8.99/mo excl. VAT | 4 vCPU, 8 GB RAM, 80 GB NVMe | Intel/AMD (x86) |
| Backups add-on | from €1.1980/mo excl. VAT | instance-related | — |

**Every shared plan was marked "Currently not available" / "not available" on 2026-11-08**, on both
the cost-optimized and regular-performance pages. Availability must be confirmed in the user's own
Hetzner console before anything else; an advertised price for an unavailable plan is not a plan.
Listed locations for the cost-optimized line are Falkenstein, Nuremberg and Helsinki.

Budget arithmetic: one CX23 at €5.99 excl. VAT replaces Railway's $5 minimum **and** the separate
runner host, so a single-server layout is the only one of the options considered that clearly fits
$10/month. Adding Hetzner's backup option pushes the base to about €7.19 excl. VAT, so prefer
nightly `pg_dump` to an existing free object-storage allowance over the paid snapshot add-on, and
confirm the real invoice currency and tax at checkout. An earlier USD reading recorded $7.09 for
CX23 including IPv4; that number came from the USD toggle and was not reproducible from the page
text today. Railway says plan downgrades take effect at the next billing cycle and usage can still
be charged, so keep Railway paid until cutover is verified.

Sources read 2026-11-08: `https://www.hetzner.com/cloud/`,
`https://www.hetzner.com/cloud/cost-optimized/`, `https://www.hetzner.com/cloud/regular-performance/`.
Railway pricing: `https://docs.railway.com/pricing/plans`. The D068 InterServer $3 candidate
remains on record in [memory/DECISIONS.md](../memory/DECISIONS.md) if Hetzner stays unavailable.

## 4. Target layout on one host

One Ubuntu 24.04 server, four trust zones on the same machine. The boundaries that matter are not
"separate servers" but separate users, separate credentials and enforced resource limits.

| Zone | Runs as | Holds | Must never reach |
| --- | --- | --- | --- |
| Reverse proxy / TLS | its own service user | the certificate | the database, any key |
| Web (Next.js, `npm start`) | non-root app user | `DATABASE_URL`, auth secret, S3 credentials, dispatch key | any signing key |
| Payment/settlement worker | separate non-root user | `DATABASE_URL`, agent signing key | the browser sandbox |
| Browser controller (`workers/free-tests.ts`) | root per [`trialoom-browser.service`](../runners/trialoom-browser.service), owns Docker and the watchdog | dispatch key, S3 credentials, host credential | the settlement or sponsor key |
| gVisor test containers | uid 65534 inside `runsc` | nothing | host loopback, PostgreSQL, Docker socket, every credential file |

Requirements carried over from the existing bootstrap, which must not be relaxed to make things
start: Ubuntu exactly 24.04 (the script asserts `VERSION_ID`), Node 24 or newer, run from a real
host and not a container, no `/mnt/mac`, no forwarded SSH agent, its own Docker daemon with
`runsc` registered from the signed apt repository, the Unix-socket egress proxy, and an
independent systemd watchdog. On a bare Hetzner VM keep the host's own `overlay2` storage driver —
the local VFS workaround was specific to nested OrbStack overlayfs. PostgreSQL binds to loopback
or a Unix socket only, with its own role per process. `TRIALOOM_EVIDENCE_DIR` and the Docker data
root both sit on the 40 GB disk; the worker image alone is about 1.11 GB, so watch disk headroom.

Capacity reality: the verified sandbox profile takes 1 CPU and 1 GiB for the duration of a test.
On 2 vCPU / 4 GB that means **one test at a time**, queued, with swap configured and systemd
memory limits so a test cannot starve the website. Queuing is a capacity property; it does not
change D064's public, self-service access.

## 5. Migration steps

Each step has a gate. Do not start the next one until the gate holds, and record the outcome in
`memory/BUILD_LOG.md` as usual.

**0 — Confirm the purchase decision.** Check plan availability and the exact checkout total in the
user's Hetzner console, in the invoice currency, including IPv4 and tax. Present it against the
$10 ceiling and get an explicit instruction before buying. Gate: the user authorizes a specific
plan and location, or picks a different provider.

**1 — Provision and harden the host.** Ubuntu 24.04, SSH keys only, no password login, firewall
open on 22/80/443 only, unattended security updates, swap, a separate non-root user per zone.
Gate: `ssh` in as a non-root user, `. /etc/os-release` reports 24.04, firewall rules read back as
intended.

**2 — Install the runner boundary first, before any data moves.** From a checkout on the host:

```bash
sudo bash runners/setup-linux-gvisor.sh --dedicated-runner
```

It installs Docker and `runsc` from signed sources, builds the preview runtime, pulls
`node:24-bookworm-slim` and runs the gVisor browser check. Then:

```bash
node scripts/check-native-runner.ts
npm run runner:gvisor-check
npm run runner:proxy-check
npm run runner:recovery-check
```

Gate: the gVisor check passes **on this machine's architecture** with real EROFS refusals and a
failed external connection, and the proxy and recovery checks pass. If the host is Arm (CAX) note
that the only prior passing run was also arm64; if it is x86 (CX) this is the first x86 evidence,
so treat a pass as new information and record it.

**3 — PostgreSQL on the host.** Install PostgreSQL, create the database and one role per process
with least privilege, loopback only. Apply the schema from the worker image or the checkout:

```bash
node scripts/migrate.ts
```

Gate: 30 migrations applied on an empty database, `/api/ready` returns 200 against it.

**4 — Private object storage.** Either an external S3-compatible bucket within a free allowance or
a self-hosted store on this box, configured through `TRIALOOM_S3_ENDPOINT`, `TRIALOOM_S3_REGION`,
`TRIALOOM_S3_BUCKET`, `TRIALOOM_S3_ACCESS_KEY_ID` and `TRIALOOM_S3_SECRET_ACCESS_KEY`. Never use
public object ACLs. Self-hosting costs disk and loses the off-box copy; an external bucket adds a
dependency but survives the server. Ask the user which they want. Gate: upload and retrieval
verified from **both** the web process and the browser controller, and the bucket is unreadable
without credentials.

**5 — Web, worker and TLS.** Install the application under `/opt/trialoom`, run the web process
and the payment worker as their own systemd units with mode-0600 environment files, and put a
reverse proxy in front with a Let's Encrypt certificate for `trialoom.xyz`. Keep
`BETTER_AUTH_URL`/`TRIALOOM_URL` as `https://trialoom.xyz` so sessions and the authentication
origin do not change. Set `TRIALOOM_RUNNER_DISPATCH_KEY` to one private random 32-byte hex value
shared by the web process and the browser controller, and set `TRIALOOM_RUNNER_API_ORIGIN` to the
origin the controller should call back on. Public wallet entry needs `TRIALOOM_WALLET_LOGIN=true`
and `TRIALOOM_PUBLIC_WALLET_SIGNUP=true`. Gate: over a private hostname or local port, not yet on
public DNS — `/api/health`, `/api/ready`, the landing page, sign-in and a public signup all
respond correctly, and the certificate chain validates.

**6 — Enrol the runner and start the controller.**

```bash
node scripts/register-managed-runner.ts
sudo systemctl enable --now trialoom-browser
```

The mode-0600 credential goes only to the controller's own environment file. The controller's unit
must not carry, and must not mount into any container, the settlement or sponsor signing key.
Gate: a fresh heartbeat is visible, one real test on a target the user owns dispatches, executes
under `runsc`, delivers evidence to the bucket and is reviewable; kill the controller mid-run and
confirm recovery with no duplicate execution and no slot freed before removal is verified.

**7 — Move the data.** `pg_dump` the Railway database, restore it on the host, then apply
0026–0030 and compare row counts and the existing owner/workspace records. Railway stays untouched
and running throughout. Gate: counts match, the application reads the restored data, `/api/ready`
passes on the migrated schema.

**8 — Cut over DNS.** At Namecheap, replace the Railway target with the Hetzner server's A/AAAA
records; lower the TTL beforehand. Verify HTTPS, the authentication origin, sign-in, a public
signup and one hosted test on the public domain. Gate: all of that passes from outside the host.

**9 — Retire Railway.** Only after the cutover has been verified and the user says so. Take a
final dump first and keep it off-box. Railway downgrades apply at the next billing cycle, so
record the date the $5 actually stops.

**10 — Backups and operations.** Nightly `pg_dump` plus the evidence directory to off-box
storage, a restore rehearsal, log rotation, disk and memory alerts, and a documented restore
procedure. Gate: a restore from the backup into a disposable database succeeds.

## 6. Risks to keep in front of the user

- **Availability.** Every Hetzner shared plan read as unavailable today. Step 0 may simply fail.
- **One machine, no redundancy.** A host failure takes the website, the database and the runner at
  once. Backups are the only mitigation inside this budget.
- **Isolation on shared hardware.** The browser sandbox now sits on the same kernel as the
  database and the payment worker. The egress proxy, loopback firewall rules, the Docker socket
  and credential file ownership are the whole boundary; verify them explicitly rather than assuming
  the previous two-host reasoning still holds.
- **Capacity.** 2 vCPU / 4 GB with a 1 CPU / 1 GiB sandbox means serial tests. If the user expects
  concurrency, that is CX33 at €8.99 excl. VAT and a tighter budget.
- **Architecture change.** Isolation evidence exists only for arm64. x86 needs its own passing run.
- **Scope creep.** TLS, backups and a reverse proxy are genuinely new code and configuration; they
  were Railway's job and nobody has written them here.

## 7. Open questions for the user

1. Which plan and location, once availability is known — and x86 (CX23) or Arm (CAX11)?
2. External object storage within a free allowance, or self-hosted on the same disk?
3. Hetzner's paid backup add-on, or nightly dumps to off-box storage inside the budget?
4. When should Railway be cancelled, and should the final dump be kept locally?
5. Does the hackathon submission or the pending usebuy approval need to land before a migration
   that changes the live demo URL's hosting?

## 8. What a resuming agent should do first

1. Read `memory/STATUS.md` → "Next action", and D064, D068 and D069 in `memory/DECISIONS.md`.
2. Run `git status --short --branch` and `git log --oneline -5`. Expect `main` ahead of
   `origin/main` with nothing pushed.
3. Do not provision, deploy, push or change DNS. Confirm step 0 with the user first.
4. Everything local still works: `npm run db:up`, `npm run db:migrate`, `npm run dev`,
   `npm run check`, `npm run test:db`, `npm run test:e2e`.
5. Record each step in `memory/STATUS.md` and `memory/BUILD_LOG.md` and commit it, per
   [AGENTS.md](../AGENTS.md).
