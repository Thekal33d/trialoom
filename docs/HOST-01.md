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
