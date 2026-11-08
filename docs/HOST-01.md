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
- The chosen server in practice: gVisor operation on Hetzner's kernel, x86 behaviour, and bounded
  single-job performance. Availability and the quoted price are now settled (section 3); what the
  first invoice actually charges, including VAT treatment, is not.
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

## 3. Hosting cost, read in the account's own console on 2026-11-08

The user's Hetzner account is verified and holds one empty project, `Default` (id 16705156). The
server wizard quotes this account in **US dollars, excluding VAT**. Read from the wizard, with
Cost-Optimized selected:

| Plan | Monthly | Hourly | Resources | Architecture |
| --- | --- | --- | --- | --- |
| **CX23** | **$6.49** | $0.010 | 2 vCPU, 4 GB RAM, 40 GB SSD, 20 TB traffic | Intel/AMD (x86) |
| CX33 | $9.99 | $0.016 | 4 vCPU, 8 GB, 80 GB, 20 TB | Intel/AMD (x86) |
| CX43 | $18.49 | $0.030 | 8 vCPU, 16 GB, 160 GB | Intel/AMD (x86) |
| CPX02 | $7.49 | $0.012 | 1 vCPU, 1 GB, 20 GB | AMD (x86) — too small |
| CPX12 | $13.49 | $0.022 | 1 vCPU, 2 GB, 40 GB | AMD (x86) |
| Primary IPv4 | $0.60 | $0.001 | charged whether attached or not | — |
| Backups | +20% of the server price | — | daily disk copies, volumes excluded | — |

**Availability resolved.** Cost-Optimized carries a "Limited availability" label as a category, but
CX23 is selectable today in both **Falkenstein** and **Helsinki**, and the wizard produces a
complete quote for it. The earlier reading of "currently not available" came from the public
marketing pages, which do not reflect this account. Singapore adds $8.00/mo on Regular
Performance; the other locations offered are Nuremberg, Hillsboro and Ashburn.

**The budget line.** CX23 plus one IPv4 totals **$7.09/mo excluding VAT**, which is what the
wizard's own summary shows and which matches the figure recorded earlier. Adding Hetzner's backups
at 20% of $6.49 brings it to about **$8.39/mo**, still inside D068's $10 ceiling — so the earlier
advice to avoid the paid backup option, based on a €1.1980 list figure, was wrong for this
account and paid backups are affordable here. CX33 at $9.99 plus IPv4 is $10.59 and does not fit.
Retiring Railway removes its $5 minimum; Railway downgrades take effect at the next billing cycle.
VAT treatment is not shown in the wizard and the first invoice will settle it.

**Ubuntu 24.04 is available.** The image selector offers 26.04, 24.04 and 22.04, so
`runners/setup-linux-gvisor.sh`, which asserts `VERSION_ID=24.04`, needs no change. Pick 24.04
explicitly; the wizard defaults to 26.04.

**Still to decide before buying:** an SSH key must be registered first, or Hetzner emails the root
password instead. The project has no SSH key and no firewall yet.

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

**0 — Confirm the purchase decision. Done, 2026-11-08.** The user authorized and the server was
bought in their console: **`trialoom`, CX23 (2 vCPU x86, 4 GB RAM, 40 GB NVMe, 20 TB traffic),
Falkenstein (fsn1), Ubuntu 24.04, IPv4 + IPv6**, in project `Default` (16705156). Public IPv4
**2.31.104.223**. Recurring cost **$7.09/mo excluding VAT** ($6.49 server + $0.60 primary IPv4),
which is the quote shown at checkout. Backups were **not** enabled; they would add 20% ($1.30),
and the choice is still open. The project has one SSH key, `trialoom-hetzner` (ed25519), whose
private half lives outside this repository on the user's Mac and must never be committed. No
firewall, volume or placement group exists yet.

Verified over SSH with that key on 2026-11-08: `Ubuntu 24.04.4 LTS`, `x86_64`, kernel
`6.8.0-138-generic`, 2 CPUs, 3819 MB RAM, 38 GB root filesystem with 35 GB free. The distribution
matches `runners/setup-linux-gvisor.sh`'s exact `VERSION_ID=24.04` assertion, and this is the
project's **first x86 host** — the gVisor evidence on record is arm64 only. Node is not installed
yet, and the bootstrap requires Node 24 or newer before it will run.

**1 — Provision and harden the host. Done, 2026-11-08**, by
[`runners/harden-host.sh`](../runners/harden-host.sh), which is idempotent and installs no
application, database, Node, Docker or gVisor:

```bash
ssh -i ~/.ssh/trialoom_hetzner root@2.31.104.223 'bash -s' < runners/harden-host.sh
```

Applied: full `apt-get upgrade`; hostname `trialoom`; an administrative user `ops` in `sudo`,
carrying the same key and NOPASSWD because the account has no password and password
authentication is off; SSH restricted to `PermitRootLogin prohibit-password`,
`PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `AllowAgentForwarding no`,
`AllowTcpForwarding local`, `MaxAuthTries 3`, `LoginGraceTime 30`; ufw default-deny inbound with
only 22, 80 and 443 open; fail2ban; a 4 GB swapfile with `vm.swappiness=10`; and unattended
security upgrades. Root keeps key access deliberately, as a recovery path that does not depend on
`ops` or sudo. Local forwarding stays allowed so PostgreSQL can be reached over SSH during the
data move instead of being exposed.

Gate met: `ops` logs in and `sudo -n id` returns root; a password-only attempt is refused with
`Permission denied (publickey)`; after a reboot the host returned in about fifteen seconds with
the swapfile mounted, ufw active, fail2ban and unattended-upgrades active and no reboot pending.

Two notes for later steps. The first run aborted at `sshd -t` because Ubuntu 24.04 activates sshd
through `ssh.socket` and `/run/sshd` did not exist, so the firewall, swap and auto-update work
never ran; the script now creates that directory first, and the recorded run is the complete one.
And Docker writes its own iptables rules, so a published container port would bypass ufw entirely
— runner containers must publish none.

**2 — Install the runner boundary. Done, 2026-11-08, except the recovery check.** The checkout was
synced to `/opt/trialoom` with rsync, excluding `.git`, `node_modules`, `.env*`, `artifacts/` and
build output — the host holds no credentials and is not a git remote. Node 24 came from
NodeSource's signed apt repository via [`runners/install-node24.sh`](../runners/install-node24.sh)
rather than a piped installer; Ubuntu 24.04 ships Node 18, which the bootstrap refuses. Then:

```bash
ssh -i ~/.ssh/trialoom_hetzner root@2.31.104.223
cd /opt/trialoom && bash runners/setup-linux-gvisor.sh --dedicated-runner
```

Installed and verified on the host: Docker, gVisor `runsc 20261102.0` from its signed repository,
registered with `--host-uds=open --network=none` on the systrap platform, and the base image
`node:24-bookworm-slim` at digest `sha256:01d566e8…`. The bootstrap's own browser check passed
**two fresh Chromium journeys under `runsc`** (Chromium 156.0.8078.4, fixture responses 201 and
400, fresh storage, network denied, traces of about 2.9 KB, containers removed).

| Check | Result |
| --- | --- |
| `runners/setup-linux-gvisor.sh --dedicated-runner` | pass — two isolated Chromium journeys |
| `scripts/check-native-runner.ts` | pass — `runner.smoke_passed`, witnessed, no public target contacted |
| `scripts/check-preview-proxy.ts` | pass — 21 unit checks, two isolated browser runs, witness and cleanup verified |
| `scripts/check-preview-recovery.ts` | **deferred** — needs `DATABASE_URL`; run it after step 3 |

The proxy run exercised the egress witness end to end: unapproved CONNECT, forged Host, absolute
URLs and write methods denied; WebSocket upgrades and nested CONNECT tunnels never reaching
upstream; approved-origin redirects followed while private and off-origin ones were withheld;
certificate hostname mismatch rejected; response and connection budgets closing the run; and DNS
rotation accepting only still-present original pins. The witness recorded `ALLOWED`,
`REDIRECT_DENIED`, `METHOD_DENIED` and `ORIGIN_DENIED`, and a browser deprived of its proxy still
had no direct network.

**This is the project's first x86 isolation evidence.** Every prior passing run was arm64 under
OrbStack. `scripts/check-preview-proxy.ts` had to be changed to get here: it called the macOS
`orb` CLI directly instead of the existing `scripts/runner-command.ts` dispatcher, so it could not
run on a real Linux host at all. It now routes through that dispatcher, which produces identical
arguments on macOS and is covered by `tests/runner-command.test.ts`; the macOS OrbStack path was
not re-exercised in this session. Disk after the bootstrap: 9.8 GB used of 38 GB.

**3 — PostgreSQL on the host. Done, 2026-11-08**, by
[`runners/setup-postgres.sh`](../runners/setup-postgres.sh), which is idempotent and prints no
password:

```bash
ssh -i ~/.ssh/trialoom_hetzner root@2.31.104.223 'bash /opt/trialoom/runners/setup-postgres.sh'
```

PostgreSQL **18.6** from the PGDG signed repository, matching the `postgres:18.6` that
[`compose.yaml`](../compose.yaml) pins for development; Ubuntu's own package is 16. It listens on
`127.0.0.1` and `[::1]` only, with `scram-sha-256`, `max_connections = 50`,
`shared_buffers = 256MB`, `work_mem = 8MB` and `effective_cache_size = 1GB`, sized for a 4 GB box
that must also hold a 1 GiB sandbox.

Three roles, none of them superuser: `trialoom` owns the schema and holds `CREATEDB`, because the
project's checks build disposable databases; `trialoom_web` and `trialoom_worker` are login roles
with `SELECT, INSERT, UPDATE, DELETE` on tables and `USAGE, SELECT` on sequences, granted both on
what exists and by default on what the owner creates later. `PUBLIC` is revoked from the schema
and from both databases. Two databases exist: `trialoom` for the application and `trialoom_dev`,
which the harness requires by name before it will build a disposable database.

Gate met: **all 30 migrations applied**, `0001_runtime.sql` through `0030_settlement_runtime.sql`,
leaving 73 tables; `trialoom_web` and `trialoom_worker` hold DML on all of them; and
`CREATE TABLE` as `trialoom_web` is refused with `permission denied for schema public`.
`/api/ready` against this database belongs to step 5, when the web process runs.

The deferred recovery check then passed here: `scripts/check-preview-recovery.ts` with
`DATABASE_URL` on `trialoom_dev` came through **all ten real SIGKILL checkpoints** — dispatching,
running, captured, egress, artifact, submitted, corrupt, conflict, expired and revoked — each with
fresh-process recovery, cleanup, an unchanged commitment and no duplicate delivery. It needs
`npm run build` first, which now succeeds on the host. After all of it the box sits at 652 MB of
3819 MB used and 11 GB of 38 GB on disk.

Generated credentials live in `/etc/trialoom/db.env`, mode 0600, outside the repository, and
`/opt/trialoom/.env` currently carries the **owner** URL so migrations and checks can run. Step 5
must replace it with a per-service environment file so the web process and the worker use their
own restricted roles.

**4 — Private object storage. Done, 2026-11-08.** The user chose Cloudflare R2 over a self-hosted
store, so evidence survives the server and stays off its 38 GB disk, and the free allowance keeps
the bill at $7.09/mo. Bucket **`trialoom-evidence`**, Automatic location (Western Europe, near
Falkenstein), Standard class, public access off, in the account whose S3 endpoint is
`https://<account>.r2.cloudflarestorage.com`. The token is an Account API token scoped to
**Object Read & Write on that bucket alone**, created by the user; this session never handled its
issuance. Credentials live in `/etc/trialoom/s3.env`, mode 0600 root, outside the repository.
`TRIALOOM_S3_REGION` is `auto`, which is what R2 expects and what
[`src/server/storage.ts`](../src/server/storage.ts) defaults to; it also forces path-style
addressing and rejects any endpoint carrying a path, query or credentials.

Gate met by [`scripts/check-evidence-storage.ts`](../scripts/check-evidence-storage.ts), which
writes one 2 KiB object, reads it back, compares digests, and then confirms an unauthenticated
reader gets neither the object nor a bucket listing. It passed **twice**: as root, the way the
browser controller will run, and as an unprivileged user through a systemd `EnvironmentFile`,
which is exactly how the web process will receive its configuration. Anonymous requests to both
the object and the bucket were refused with HTTP 400 — R2 rejects unauthenticated S3 requests
rather than returning 403, and the dashboard separately shows public access disabled.

The first attempt failed with `SignatureDoesNotMatch`, because Cloudflare's token page shows the
Token value next to the Secret Access Key and the shorter one was copied. The secret is 64 hex
characters; a 32-character value is the wrong field. The check deliberately refuses to pass
against the local evidence directory, so a missing configuration cannot look like success.

**5 — Web, worker and the reverse proxy. Done 2026-11-08, except TLS**, by
[`runners/setup-services.sh`](../runners/setup-services.sh):

```bash
ssh -i ~/.ssh/trialoom_hetzner root@2.31.104.223 'bash /opt/trialoom/runners/setup-services.sh'
```

Two system users, `trialoom-web` and `trialoom-worker`, each with its own systemd unit and its own
mode-0600 environment file that systemd reads before dropping privileges, so neither user can read
the other's credentials. Units run with `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`,
`ProtectHome` and a narrow `ReadWritePaths`. The web process holds no signing key and no Docker
socket; the controller remains a separate unit. `/opt/trialoom/.env`, which carried the **owner**
database URL for the migrations, is deleted — later migration runs source `/etc/trialoom/db.env`
explicitly.

Verified on the host rather than assumed:

| Check | Result |
| --- | --- |
| `/api/health` through the proxy | 200, `mode: public-beta`, `walletLogin: enabled` |
| `/api/ready` | 200 — the restricted role reads the current schema |
| `/` | 200 |
| Database roles actually connected | `trialoom_web` and `trialoom_worker`, never the owner |
| Unit users | `User=trialoom-web`, `User=trialoom-worker` |
| Listening sockets | `127.0.0.1:3000` (Next.js) and `127.0.0.1:8080` (Caddy) only |
| From outside the host | every port refused, including 80, 443, 3000, 8080 and 5432 |

Caddy binds **loopback only** on purpose: this deployment must not be reachable while
`trialoom.xyz` still serves from Railway. A site address alone would not have done it — Caddy
matches the address by Host header but still listens on every interface, so the config carries an
explicit `bind 127.0.0.1`. The firewall is not the only thing keeping an unfinished deployment off
the internet. Note that `admin off` closes the API behind `caddy reload`, so editing the Caddyfile
needs `systemctl restart caddy`.

**TLS is not done and moves to step 8.** A Let's Encrypt HTTP-01 challenge needs port 80 on this
machine to answer for `trialoom.xyz`, which cannot be true until DNS moves. Attempting it now
would only burn ACME failures. At cutover, replace the loopback block with `trialoom.xyz` and
Caddy provisions the certificate itself. Until then `BETTER_AUTH_URL` is already
`https://trialoom.xyz`, so sign-in over loopback will refuse the origin — that is expected and
gets verified in step 8, not here.

**6 — Enrol the runner and start the controller. Done 2026-11-08, except a real owned-target
test.** After the user created the owner account through the private invitation, workspace
`Trialoom` (`893adffd-…`) had an owner (`20a5201b-…`), and enrollment could proceed:

```bash
cd /opt/trialoom && set -a && . /etc/trialoom/db.env && . /etc/trialoom/shared.env && set +a
node scripts/register-managed-runner.ts --workspace <id> --owner <id> \
  --name trialoom-fsn1 --output /etc/trialoom/runner-credential.env --host-check-passed
```

The host row reads `trialoom-fsn1`, contract `runner-host-v1`, sandbox `gvisor`,
`egress_enforced` true, isolation `witnessed`, `platform_managed` true. `/etc/trialoom/runner.env`
(0600) carries the host credential, the shared dispatch key, `TRIALOOM_RUNNER_API_ORIGIN`, the R2
credentials and the database URL; it was **grepped to confirm no sponsor, client or Remesso
signing key is present**. `runners/trialoom-browser.service` is installed and active, logging
`free_runner.sponsor: unconfigured`.

`scripts/check-hosted-tests.ts` then passed on this host:

```json
{"publicClaim":true,"realIsolatedBrowser":true,"evidenceSubmissions":1,
 "repeatedExecution":false,"review":"pending","payables":0,
 "funding":"fixture-only","publicTargetsContacted":false}
```

A listing of the bucket afterwards shows **6 objects under `evidence/`**, so evidence genuinely
reaches R2 from this host rather than falling back to local disk.

**What this does not yet prove.** The target was a fixture, not a website the user owns, and no
funded payment was involved. The remaining gate needs the user to add a real website in the
product, pass its DNS verification, and request a test — then a controller kill mid-run to
confirm recovery without duplicate execution. The ten SIGKILL checkpoints in step 3 cover the
recovery machinery, but not with a live customer target.

**One deviation worth narrowing.** The controller shares `trialoom_worker`'s database role rather
than holding one of its own. Both roles carry identical DML, so a separate role would currently
be cosmetic, but a runner-specific role would make revocation and auditing independent of the
payment worker. Open work, not a claim of separation.

**7 — Move the data. Done 2026-11-08, and there was nothing to move.** The user took the dump
through the authenticated Railway CLI, so no endpoint was opened and no connection string was
pasted:

```bash
railway ssh -p bc70fce3-5930-4895-ac9f-65fa48ee8195 -e production -s Postgres \
  sh -c 'pg_dump --no-owner --no-privileges --format=plain "$DATABASE_URL"' > ~/trialoom-railway.sql
```

The result is 190 KB, 66 tables, **23 migrations** — `0001` through `0023`, the pre-remodel
schema, as expected. Exactly four tables carry rows:

| Table | Rows in Railway | Rows already on the host |
| --- | --- | --- |
| `schema_migrations` | 23 | 30 |
| `qualification_tasks` | 4 | 4 |
| `sponsored_budgets` | 1 | 1 |
| `resource_accounts` | 1 | 1 |

Those three non-migration tables are **seed data written by the migrations themselves**, and the
host already holds identical counts. Every other table is empty, accounts included: the live
deployment has no users, no workspaces, no memberships, no projects. So there is no data to
carry over, no database to drop and recreate, and no restore to perform. The dump is kept at
`~/trialoom-railway.sql` on the user's Mac as a safety copy; it contains no personal data.

**This also breaks the fix made earlier today.** Step 6 was moved after step 7 on the assumption
that the owner workspace lived in Railway. It does not live anywhere — the example workspace on
the public site is rendered from fixtures, and the owner invitation from 2026-10-27 was local and
never used. Runner enrollment needs an owner account that has to be **created on the new
deployment**, and wallet signup needs the real origin, which means the DNS cutover comes first.

**The order is now 8 → sign up → 6 → 10.** Cut over and get the certificate, sign up as the
owner, enrol the runner against that workspace, then backups.

**8 — Cut over DNS. Done 2026-11-08.** The user chose to cut over with public signup **off**, so
the live site keeps reporting `invited-alpha` and `walletSignup: unavailable` exactly as Railway
did; opening registration stays a separate, deliberate act once the runner is proven.

`TRIALOOM_PUBLIC_WALLET_SIGNUP` was set to `false` and the web service restarted before any DNS
change. The user then replaced the records at Namecheap, and the Caddyfile's loopback block became
`trialoom.xyz { reverse_proxy 127.0.0.1:3000 }` (the previous one is kept at
`/etc/caddy/Caddyfile.loopback.bak`). Caddy solved the HTTP-01 challenge and the certificate was
issued within seconds.

Recorded before the change, so rollback is exact: `trialoom.xyz` A was `153.52.255.72` and AAAA
`2c0f:f5c0:150:103::9934:ff48`, both Railway, on Namecheap's `dns1/dns2.registrar-servers.com`.
Now A is `2.31.104.223`.

Verified from outside the host:

| Check | Result |
| --- | --- |
| `https://trialoom.xyz/api/health` | 200 from `2.31.104.223`, `mode: invited-alpha` |
| `https://trialoom.xyz/api/ready` | 200 |
| `/` and `/sign-in` | 200 |
| Certificate | `CN=trialoom.xyz`, Let's Encrypt, valid to 2027-02-06 |
| `http://trialoom.xyz/` | 308 to HTTPS |

**One record is missing: there is no AAAA.** The old Railway AAAA is gone and nothing replaced it,
on the authoritative nameserver or at `1.1.1.1` and `8.8.8.8`. The server has
`2a01:4f8:c016:13b::1`. IPv4-only service works, and a split where IPv6 still pointed at Railway
would have been worse, but IPv6-only clients cannot reach the site until that record exists.

**Owner bootstrap done.** `node scripts/invite.ts` created the workspace and a private owner
invitation — one workspace, one invitation, no memberships yet, no email sent. The join link was
copied to `~/trialoom-owner-invite.txt` on the user's Mac at mode 0600 and **expires
2026-11-11T10:19:59Z**. Signing up through it is the user's own step and unblocks step 6.

**9 — Retire Railway.** Only after the cutover has been verified and the user says so. Take a
final dump first and keep it off-box. Railway downgrades apply at the next billing cycle, so
record the date the $5 actually stops.

**10 — Backups. Done 2026-11-08, with a rehearsed restore.**
[`runners/backup.sh`](../runners/backup.sh) dumps the database, compresses it, verifies the
archive, keeps a mode-0600 local copy and sends it off the machine through
[`scripts/backup-upload.ts`](../scripts/backup-upload.ts), which writes under the bucket's
`backups/` prefix and prunes anything older than fourteen days. `trialoom-backup.timer` runs it
nightly at 03:15 UTC with a randomized delay and `Persistent=true`, so a missed night still runs.

First run: `backups/trialoom-20261108T102925Z.sql.gz`, 27,688 bytes, recorded with its SHA-256.

**The restore was rehearsed, not assumed.** The archive was pulled **back out of the bucket**
rather than read from local disk, verified with `gzip -t`, and restored into a throwaway
database. It matched the live one exactly:

| | Restored | Live |
| --- | --- | --- |
| migrations | 30 | 30 |
| workspaces | 1 | 1 |
| memberships | 1 | 1 |
| runner_hosts | 1 | 1 |
| tables | 73 | 73 |

The rehearsal database was dropped and the temporary copy removed.

**What this backup does not cover, deliberately.** `/etc/trialoom/*.env` is not backed up: the
setup scripts regenerate those values, and the one exception, `BETTER_AUTH_SECRET`, costs only
existing sessions. Evidence objects live in R2 already and are not copied a second time. And the
backups share the evidence bucket and its credentials, so a host compromise could delete them —
a second bucket with a write-only token, or R2 object lock, would fix that and needs a new token
from the user. Hetzner's own snapshots (+20%, about $1.30) remain unused and would add a layer
outside Cloudflare entirely.

**Rebuilding from nothing** means: a new server, then `harden-host.sh`, `install-node24.sh`, the
gVisor bootstrap, `setup-postgres.sh`, the restore above, `setup-services.sh`, and re-enrolling
the runner. Every one of those is committed, which is the other half of the backup.

## 6. Risks to keep in front of the user

- **Availability.** CX23 is selectable today in Falkenstein and Helsinki, but Cost-Optimized is
  labelled "Limited availability" as a category, so stock can disappear between now and checkout.
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

1. CX23 in Falkenstein or Helsinki at $7.09/mo including IPv4 — go ahead, or hold? Arm (CAX11) was
   not priced, since x86 is available and the budget fits.
2. External object storage within a free allowance, or self-hosted on the same disk?
3. Hetzner's backups at +20% ($1.30/mo, total about $8.39) or nightly dumps off-box? Both fit.
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
