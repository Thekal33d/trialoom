# Browser evidence capability experiment

This is VAL-01, a disposable local experiment, not the Trialoom application. It proves that a seeded invitation defect can be reproduced twice with clean state, recorded assertions, pinned source bytes, and inspectable traces.

## Run

Use Node 24 (`.nvmrc` records the version used for the initial experiment):

```sh
npm ci --ignore-scripts
npm run browser:install
npm test
npm run spike:reproduce
```

The runner prints its export directory under `artifacts/browser-evidence/<run-id>/export/`. Each invocation has a unique directory and never overwrites earlier evidence. Chromium is stored in the project's ignored `.cache/` directory.

Open an exported trace locally, replacing the path with a real output path:

```sh
PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright npx playwright show-trace artifacts/browser-evidence/<run-id>/export/replay-1.trace.zip
```

The trace viewer inspects recorded actions; it does not re-execute the journey. Rerun `npm run spike:reproduce` to perform two fresh browser journeys. See [Playwright's trace viewer documentation](https://playwright.dev/docs/trace-viewer).

## What gets demonstrated

- A fresh fixture server on loopback, new browser context, empty invitation list, and clean cookies/local storage per replay.
- A normal address succeeds. The seeded validator rejects `teammate+qa@example.test`, a deliberate product defect. The harness succeeding means reproduction succeeded; the product outcome remains **failed**.
- Source hashes identify the fixture build; run metadata records runtime, browser/version, viewport, fixture, terms, actor, timestamps, expected/actual outcomes, and first observed failure.
- Playwright Test records actions and assertions, rather than relying on a screenshot or narrative. See [tracing guidance](https://playwright.dev/docs/api/class-tracing).
- SHA-256 hashes cover each exported trace and evidence JSON. Resource references inside a sanitized trace are updated when its resource bytes change.

## Redaction boundaries

The fixture intentionally sends a synthetic credential header and synthetic private owner name. The export must observe and remove both canaries, including DOM snapshots and network bodies. Export also removes local project/home paths. Screenshots, video, and embedded source capture are disabled. The exporter refuses unsupported archive entries, binary/non-UTF-8 resources, oversized archives, and malformed trace JSON.

This is a narrow policy for known synthetic fixture data. It is **not** a general customer-data sanitizer, OCR system, or production ingestion service. Raw traces/reporting remain in the ignored `private/` directory; the `export/` folder is also ignored pending explicit review. Do not point this experiment at customer data. The runner starts only its own fixture and does not accept a target URL.

## Limits

Browser contexts isolate session state; they are not an operating-system security boundary. The test uses loopback by design, blocks other browser origins, and sends no invitations. It does not prove production SSRF protection, tenant isolation, claim leases, budget controls, operator independence, marketplace acceptance, or payment behavior. Both replays are honestly attributed to the local harness. The eventual product framework and hosting stack remain undecided.
