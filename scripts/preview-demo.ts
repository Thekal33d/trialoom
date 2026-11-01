import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type Browser, chromium, expect } from '@playwright/test';
import type { Pool } from 'pg';
import { releaseAssignment } from '../src/server/assignments.ts';
import { revokeHost } from '../src/server/isolation.ts';
import { migrate } from '../src/server/migrations.ts';
import { abandonRun } from '../src/server/runner.ts';
import { disposableDatabase } from '../tests/helpers/database.ts';
import { startLocalServer } from './local-server.ts';
import { executePreviewRun } from './preview-controller.ts';
import { seedPreviewFixture } from './preview-fixture.ts';
import { buildPreviewImage, previewHost, previewIdentity } from './preview-host.ts';

const smoke = process.argv.includes('--smoke');
const mode = process.argv.includes('--blokaz') ? 'public' : 'owned';
const journey = process.argv.includes('--ladder') ? 'ladder' : undefined;
assert(process.argv.slice(2).every((arg) => ['--smoke', '--blokaz', '--ladder'].includes(arg)));
const directory = resolve('artifacts/preview-runs', randomBytes(8).toString('hex'));
const abort = new AbortController();
const stop = () => abort.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let db: Awaited<ReturnType<typeof disposableDatabase>> | undefined;
let app: Awaited<ReturnType<typeof startLocalServer>> | undefined;
let browser: Browser | undefined;
try {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const image = await buildPreviewImage();
  console.log(JSON.stringify({ event: 'preview.image', image }));
  if (smoke && mode === 'owned' && !journey) {
    const host = previewHost(image, false, abort.signal);
    try {
      await host.prepare(
        {
          mode: 'owned',
          target: { origin: 'https://preview.example.com', addresses: ['127.0.0.1'] },
          identity: await previewIdentity('preview.example.com'),
          durationMs: 60000,
        },
        20,
      );
      await assert.rejects(
        host.run({
          url: 'https://preview.example.com/',
          journey: 'owned',
          durationMs: 45000,
          maxNavigations: 50,
          hold: true,
        }),
        /PREVIEW_PROCESS_STOPPED/,
      );
      for (let n = 0; n < 30 && host.present(); n++) await delay(100);
      assert.equal(host.present(), '');
      console.log('PASS independent host timer removed the active owned browser and proxy.');
    } finally {
      await host.close();
    }
  }
  db = await disposableDatabase();
  await migrate(db.pool);
  const setup = await seedPreviewFixture(db.pool, mode, journey);
  app = await startLocalServer(db.url, directory);
  const run = await setup.assignment();
  console.log(
    `Running the ${mode === 'owned' ? 'owned HTTPS sample' : 'authorized Blokaz homepage'} through the isolated proxy.`,
  );
  const result = await executePreviewRun({
    apiOrigin: app.origin,
    runId: run.runId,
    runToken: run.runToken,
    hostCredential: setup.host.credential,
    image,
    mode,
    journey,
    signal: abort.signal,
  });
  assert.equal(result.receipt.decision, 'pending_review');
  assert.equal(result.receipt.egress.witnessed, true);
  if (mode === 'owned') {
    assert.equal(result.document.outcome, 'executed');
    assert.equal(result.document.steps.length, journey ? 3 : 2);
    assert(
      result.witness.observations.some(
        (item: { reason: string; count: number }) => item.reason === 'ALLOWED' && item.count >= 2,
      ),
    );
  }
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM payables')).rows[0].n, 0);
  assert.equal(
    (
      await db.pool.query('SELECT accepted_units FROM campaign_accounts WHERE campaign_id=$1', [
        run.campaignId,
      ])
    ).rows[0].accepted_units,
    '0',
  );
  const trace = (
    await db.pool.query(
      "SELECT reviewable,redacted_sha256 FROM evidence_artifacts WHERE run_id=$1 AND kind='trace'",
      [run.runId],
    )
  ).rows[0];
  if (mode === 'owned') assert.equal(trace.reviewable, true);
  await writeFile(
    resolve(directory, 'result.json'),
    JSON.stringify({ runId: run.runId, ...result }, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      event: 'preview.submitted',
      outcome: result.document.outcome,
      decision: result.receipt.decision,
      revisionConfirmed: run.manifest.target.revisionConfirmed,
      traceReviewable: trace.reviewable,
      witness: result.witness,
    }),
  );
  browser = await chromium.launch({
    channel: 'chromium',
    headless: smoke,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      PLAYWRIGHT_BROWSERS_PATH: resolve('.cache/ms-playwright'),
    },
  });
  const context = await browser.newContext({
    baseURL: app.origin,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(setup.email);
  await page.getByLabel('Password', { exact: true }).fill(setup.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/workspace`);
  await page.getByRole('button', { name: new RegExp(setup.projectName) }).click();
  const brief = page.locator('.brief-record', {
    hasText: 'Read-only homepage — isolated browser evidence',
  });
  await expect(brief).toContainText('Pending review');
  for (const item of run.manifest.readOnlyDependencies)
    await expect(brief).toContainText(item.origin);
  await brief.getByRole('button', { name: 'Revise terms', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Read-only dependency origins/ })).toHaveValue(
    run.manifest.readOnlyDependencies
      .filter((item) => !item.requests)
      .map((item) => item.origin)
      .join('\n'),
  );
  await expect(page.getByRole('textbox', { name: /^Exact API reads/ })).toHaveValue(
    run.manifest.readOnlyDependencies
      .flatMap((item) => (item.requests ?? []).map((request) => item.origin + request.path))
      .join('\n'),
  );
  await expect(page.getByRole('textbox', { name: /^Services excluded/ })).toHaveValue(
    run.manifest.blockedDependencyOrigins.join('\n'),
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await brief.getByRole('button', { name: 'View replay', exact: true }).first().click();
  const replay = brief.getByRole('region', { name: 'Recorded replay' });
  await expect(replay.locator('.replay-result')).toBeVisible();
  const replayUrl = `/api/v1/workspaces/${setup.workspaceId}/projects/${setup.projectId}/campaigns/${run.campaignId}/submissions/${result.receipt.submissionId}/replay`;
  const recorded = await (await page.request.get(replayUrl)).json();
  if (recorded.trace) {
    assert(recorded.trace.actions.length > 0 && recorded.trace.requests.length > 0);
    assert.equal(recorded.trace.sha256, trace.redacted_sha256);
    if (recorded.trace.requests.some((request: { status: number }) => request.status <= 0)) {
      await replay.getByText(/^HTTP responses ·/).click();
      await expect(replay.getByText('No HTTP response', { exact: true }).first()).toBeVisible();
    }
  } else {
    assert.equal(mode, 'public');
    assert(recorded.traceReason);
  }
  const screenshot = resolve(directory, 'replay.png');
  await replay.scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshot });
  console.log(
    `PASS scoped HTTP evidence, independent witness, recorded replay and no payable. Private screenshot: ${screenshot}`,
  );
  if (smoke && mode === 'owned' && journey === 'ladder') {
    for (const fixtureOutcome of ['mismatch', 'unexpected'] as const) {
      const next = await setup.assignment(`Ladder check — ${fixtureOutcome}`);
      const checked = await executePreviewRun({
        apiOrigin: app.origin,
        runId: next.runId,
        runToken: next.runToken,
        hostCredential: setup.host.credential,
        image,
        mode,
        journey,
        fixtureOutcome,
        signal: abort.signal,
      });
      assert.equal(checked.document.outcome, 'blocked');
      if (fixtureOutcome === 'mismatch')
        assert(
          !checked.document.assertions.some(
            (item) => item.name === 'ladder.player-count' && item.passed,
          ),
        );
      else
        assert(
          checked.document.assertions.some(
            (item) => item.name === 'scope.completed' && !item.passed,
          ),
        );
      assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM payables')).rows[0].n, 0);
      console.log(`PASS owned ladder ${fixtureOutcome} stayed blocked; no payable.`);
    }
  }
  if (smoke && mode === 'owned' && !journey) {
    for (const reason of ['abandon', 'release', 'expire', 'revoke'] as const) {
      const next = await setup.assignment(`Stop check — ${reason}`);
      const pool: Pool = db.pool;
      await assert.rejects(
        executePreviewRun({
          apiOrigin: app.origin,
          runId: next.runId,
          runToken: next.runToken,
          hostCredential: setup.host.credential,
          image,
          mode,
          hold: true,
          onStarted: async () => {
            await delay(1000);
            if (reason === 'abandon')
              await abandonRun(pool, setup.session, next.runId, {
                attemptToken: next.attemptToken,
              });
            if (reason === 'release')
              await releaseAssignment(pool, setup.session, next.assignmentId, {
                attemptToken: next.attemptToken,
              });
            if (reason === 'expire')
              await pool.query(
                "UPDATE runs SET issued_at=clock_timestamp()-interval '2 seconds',grant_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
                [next.runId],
              );
            if (reason === 'revoke')
              await revokeHost(pool, setup.owner, setup.workspaceId, setup.host.hostId);
          },
        }),
        /RUN_CLOSED|ATTEMPT_CLOSED|RUN_EXPIRED|HOST_UNUSABLE|HOST_CREDENTIAL_INVALID/,
      );
      assert.equal(
        (
          await pool.query('SELECT count(*)::int AS n FROM evidence_submissions WHERE run_id=$1', [
            next.runId,
          ])
        ).rows[0].n,
        0,
      );
      console.log(`PASS active isolated execution stopped on ${reason}; no submission.`);
    }
  }
  if (!smoke) {
    console.log(
      `Replay is open at ${app.origin}/workspace. No acceptance or payment occurred. Close the signed-in browser or press Ctrl-C to end this disposable session.`,
    );
    browser.once('disconnected', stop);
    page.once('close', stop);
    if (!abort.signal.aborted)
      await new Promise<void>((done) =>
        abort.signal.addEventListener('abort', () => done(), { once: true }),
      );
  }
} finally {
  await browser?.close();
  await app?.close();
  await db?.close();
  // Keep private result/screenshot only; raw evidence belonged to the disposable DB.
  await rm(resolve(directory, 'evidence'), { recursive: true, force: true });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
