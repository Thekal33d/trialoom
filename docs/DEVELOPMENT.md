# Local development

The application includes invitation-only accounts, workspace roles, authorized projects, pinned builds, and versioned draft briefs ([ALPHA-02](ALPHA-02.md)), operator connection and qualification ([ALPHA-03](ALPHA-03.md)), and the campaign ledger with atomic claims and leases ([ALPHA-04](ALPHA-04.md)), plus a durable smoke worker. `/workspace` holds real local account/project data. `/demo` remains explicitly synthetic: Canopy is an example name, and its before/after results summarize the existing invitation fixture. A builder can publish a brief and operators can claim it, but no surface can accept work or make a payment yet.

## First run

Requirements: Node 24, npm, and a running Docker-compatible engine with Compose. The default database port is **55432**, bound only to `127.0.0.1`. Commands run from the repository root.

```sh
npm ci --ignore-scripts
npm run setup:local
npm run db:up
npm run db:migrate
npm run dev
```

Open [the real workspace](http://127.0.0.1:3000/workspace) or [the example](http://127.0.0.1:3000/demo). `setup:local` creates an ignored `.env` with a random database password/authentication secret and owner-only file permissions; it preserves existing values. [.env.example](../.env.example) documents the variables without credentials, including `TRIALOOM_EVIDENCE_DIR`, the private directory evidence artifacts are written to; its default sits under the git-ignored `artifacts/`, and raw artifacts never enter the database or a log. Fonts are bundled locally; no font CDN is required.

For an existing ALPHA-01 installation, run `npm run setup:auth` and `npm run db:migrate`. Create the first owner invitation with `npm run workspace:invite -- owner@example.com My workspace`. Open the private URL from the ignored file path printed by the command; no email is sent. The user chooses their own password. Subsequent invitations and revocation are available under Workspace access. See [account behavior and recovery limits](ALPHA-02.md).

Operators open **Operator** from the workspace sidebar, or `/operator` directly. There they register a handle, request a wallet challenge, sign that exact message in their own wallet, paste the signature, and create scoped agent credentials. Never paste a private key or seed phrase into the application; it asks for none. A credential secret is shown once and is stored only as a digest. Agents then call `/api/agent/v1/*` with `Authorization: Bearer`, using an `Idempotency-Key` header on mutations. See [the operator design and limits](ALPHA-03.md).

A workspace owner publishes a brief from the project view: choose the terms version, set slots and concurrency, authorize a ceiling in USDC, and record the spending authorization reference. The campaign's accounting appears under the brief. Run `npm run worker` alongside the app so lapsed claim leases are swept; operator actions also fence a lapsed attempt on their own. See [the ledger and claim rules](ALPHA-04.md).

If port 55432 is occupied, change both `DB_PORT` and the port in `DATABASE_URL` in your local `.env` before starting Compose. Do not print or commit that file. If the web port is occupied, use `npm run dev -- --port 3002` and set `BETTER_AUTH_URL=http://127.0.0.1:3002` in `.env` before starting. Authentication mutations must match this configured origin.

Compose owns the `trialoom-dev` project and `trialoom-dev_postgres-data` volume. `npm run db:down` stops its container while preserving data. A changed environment password does not reset the password in an initialized PostgreSQL volume; preserve the original `.env` or change the database password deliberately. Never delete the volume as a routine fix.

## Production build and smoke job

```sh
npm run build
npm run start
```

This serves the local production build on port 3000. Stop a running development server first, or pass `-- --port 3002` to `start`. Hosting/deployment is not configured yet.

## The whole loop in one command

```sh
npm run loop
```

This drives one seeded campaign from publication to an owed payable against a
disposable database and the real server modules: publication, two independent
reports confirming a defect, decisions, payables, a blocked payout, settlement
through inclusion to finality, crash recovery, a fenced lapsed claim, a quoted
and independently verified repair, a capped resource purchase, the queue, and
an export. It asserts as it goes and exits non-zero on the first failure.

It prints a transcript and writes `transcript.json`, the export zip and its
private evidence store to `artifacts/loop/<timestamp>/`, which Git ignores
because execution evidence can hold private customer data. The run needs the
local database running (`npm run db:up`); it creates and drops its own
database and never touches `trialoom_dev`. The payment authority and the
resource provider are recording fixtures: no value moves and nothing is bought.
See [the loop and its boundaries](ALPHA-11.md).

The worker supports the harmless database-local `system.ping` job, payout
dispatch, and resource reconciliation:

```sh
npm run jobs:enqueue -- my-first-smoke-job
npm run worker -- --once
```

Enqueuing the same identity again returns the original job. Completion inserts one `worker_effects` row and acknowledges the job in one transaction. `npm run worker` continuously polls; stop it with Ctrl-C. A process supervisor must restart a worker after an unhandled job/database failure.

Claims use short transactions, `SKIP LOCKED`, a 30-second lease, and a fresh fencing token. An expired lease can be reclaimed; an old token cannot complete it. After five failed attempts, the expired job is retained as `dead`. This validates queue mechanics, **not exactly-once external payments**. Payment reconciliation and the financial ledger remain ALPHA-04/08 work.

## Checks

```sh
npm run check
npm run test:db
npm run browser:install
npm run build
npm run test:e2e
```

- `check`: Biome formatting/lint, strict TypeScript, and the existing 28 capability/control checks. Browser fixture unit tests bind loopback sockets.
- `test:db`: 24 account, project, migration, transaction, concurrency, and restart checks. It requires the local `trialoom_dev` database and permission to create databases. Each run creates and drops only its randomly named `trialoom_test_*` databases; application data is not reset. The guard refuses non-loopback hosts and other administrative database names.
- `test:e2e`: 30 production-browser checks across desktop Chromium (1440 × 1000) and emulated mobile Chromium (390 × 664). They cover invitation/session lifecycle, access management, roles, authorized targets, pinned builds, preserved term revisions, HTTP defenses, demo flows, accessibility scans, viewport overflow, and readiness failure. Mobile emulation is not real-device or Safari coverage.
- Browser tests create/migrate a disposable database and generate private fixture credentials, then own ports 3100 and 3101 and refuse to reuse existing servers. The second process intentionally has no database configuration. Run through `npm run test:e2e` so setup/cleanup occurs; arguments such as `-- --project=desktop` are forwarded to Playwright. The complete project flow resolves the public `example.com` hostname and requires DNS access; it does not fetch or execute that site.
- `format`: format application/tooling files. Biome uses the recommended rules with the CSS descending-specificity heuristic disabled because independently scoped components use shared element selectors. Legacy spikes and the unrelated nested repository are outside its scope.

Generated screenshots and failure traces live under ignored `test-results/`. Treat future customer evidence as private. Automated accessibility checks supplement visual/keyboard review; they do not prove complete accessibility compliance.

[CI](../.github/workflows/ci.yml) installs the lockfile, runs the same checks against a disposable PostgreSQL service, installs Chromium with its Linux dependencies, and checks the production build. Official actions and the PostgreSQL image are pinned to immutable IDs. CI performs no paid provider requests or deployments. The workflow has not run on GitHub because no remote repository is configured.

## Health and migrations

| Route | Meaning |
| --- | --- |
| `/api/health` | Process is alive; reports invited-alpha mode |
| `/api/ready` | Database is reachable and migration 0003 is registered; otherwise HTTP 503 with a generic code |
| `/api/demo/report` | Download of reviewed fixture summary; never private evidence or payment authorization |

Web requests never auto-migrate. Add migrations under `db/migrations/` using ascending four-digit prefixes. The migration runner serializes sessions with an advisory lock, verifies existing checksums, and commits each migration with its registry entry. Do not edit an applied migration; add a new one. Database pooling must retain one session for the migration lock.

The initial database user has local development privileges. Accounts and roles are verified locally; production identity hardening/recovery, isolated database/process identities, backup/restore, artifact storage, runners, money handlers, deployment, and monitoring still require their own gates. Readiness currently checks the database schema, not complete deployment readiness. See [architecture](ARCHITECTURE.md) and [backlog](BACKLOG.md).
