import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import type { Pool } from 'pg';
import { fixtureFiles, fixtureRoot, startFixture } from '../spikes/browser-evidence/fixture.mjs';
import { abandonRun } from '../src/server/runner.ts';
import { readTraceArchive } from '../src/server/trace-archive.ts';
import { seedBrowserFixture } from './browser-fixture.ts';
import { BrowserRunError, executeInvitationRun } from './browser-worker.ts';
import { checkTraceViewer } from './trace-viewer-check.ts';

type Setup = Awaited<ReturnType<typeof seedBrowserFixture>>;
type Run = Awaited<ReturnType<Setup['assignment']>>;
const code = (value: string) => (error: unknown) =>
  error instanceof BrowserRunError && error.code === value;

export async function checkBrowserIntegration({
  pool,
  browser,
  page,
  setup,
  fixture,
  app,
  run,
  result,
  directory,
}: {
  pool: Pool;
  browser: Browser;
  page: Page;
  setup: Setup;
  fixture: Awaited<ReturnType<typeof startFixture>>;
  app: { origin: string };
  run: Run;
  result: Awaited<ReturnType<typeof executeInvitationRun>>;
  directory: string;
}) {
  const options = {
    browser,
    apiOrigin: app.origin,
    runId: run.runId,
    runToken: run.runToken,
    fixture,
    directory,
  };
  assert.deepEqual(
    result.responses.map((item) => item.status),
    [201, 400],
  );
  assert.equal(result.document.outcome, 'product_failed');
  assert.equal(result.document.build.revision, fixture.build.id);
  assert.equal(result.receipt.decision, 'pending_review');
  const trace = await readFile(result.tracePath);
  const entries = unzipSync(trace);
  assert(Object.keys(entries).some((key) => key.endsWith('.trace')));
  const traceText = Object.values(entries)
    .map((bytes) => strFromU8(bytes))
    .join('\n');
  assert(traceText.includes('"status":201') && traceText.includes('"status":400'));
  assert(
    !traceText.includes(run.runToken),
    'The run grant must never enter browser traffic or traces.',
  );
  const stored = (
    await pool.query(
      'SELECT sha256,reviewable FROM evidence_artifacts WHERE run_id=$1 AND kind=$2',
      [run.runId, 'trace'],
    )
  ).rows[0];
  assert.equal(stored.sha256, createHash('sha256').update(trace).digest('hex'));
  assert.equal(stored.reviewable, true);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM payables WHERE campaign_id=$1', [
        run.campaignId,
      ])
    ).rows[0].n,
    0,
  );
  const accounting = (
    await pool.query(
      'SELECT accepted_units,finalized_units FROM campaign_accounts WHERE campaign_id=$1',
      [run.campaignId],
    )
  ).rows[0];
  assert.equal(accounting.accepted_units, '0');
  assert.equal(accounting.finalized_units, '0');

  const base = `/api/v1/workspaces/${setup.workspaceId}/projects/${setup.projectId}/campaigns/${run.campaignId}`;
  const listed = await (await page.request.get(`${base}/submissions`)).json();
  assert.equal(listed.submissions.length, 1);
  const brief = page.locator('.brief-record', {
    hasText: 'Test teammate invitations — fresh browser evidence',
  });
  await expect(brief).toContainText('Pending review');
  await expect(brief.getByRole('link', { name: 'Open redacted copy' })).toHaveCount(2);
  const reportHref = await brief
    .getByRole('link', { name: 'Open redacted copy' })
    .last()
    .getAttribute('href');
  assert(reportHref);
  const report = await (await page.request.get(reportHref)).text();
  assert(report.includes('Chromium'));
  assert(!report.includes(run.runToken) && !report.includes('teammate+qa@example.test'));
  await brief.getByRole('button', { name: 'View replay', exact: true }).first().click();
  const replay = brief.getByRole('region', { name: 'Recorded replay' });
  await expect(replay.locator('.replay-result')).toContainText('Step 3 of 3');
  await expect(replay.locator('.replay-result')).toContainText('using a plus alias');
  await expect(replay.locator('.replay-result')).toContainText('HTTP 400');
  await replay.getByRole('button', { name: 'Previous step' }).click();
  await expect(replay.locator('.replay-result')).toContainText('HTTP 201');
  await replay.getByRole('button', { name: 'Next step' }).click();
  await expect(replay.getByRole('button', { name: 'Next step' })).toBeDisabled();
  await replay.getByText(/^HTTP responses ·/).click();
  await expect(replay).toContainText('POST');
  const traceLink = await replay
    .getByRole('link', { name: 'Download sanitized trace' })
    .getAttribute('href');
  assert(traceLink);
  const servedTrace = await page.request.get(traceLink);
  assert.equal(servedTrace.headers()['x-trialoom-redaction'], 'playwright-metadata-v1');
  assert.equal(servedTrace.headers()['cache-control'], 'no-store');
  const sanitized = await servedTrace.body();
  assert.equal(
    createHash('sha256').update(sanitized).digest('hex'),
    servedTrace.headers()['x-trialoom-artifact-hash'],
  );
  const safeFiles = readTraceArchive(sanitized);
  const safeText = [...safeFiles.values()].map((bytes) => strFromU8(bytes)).join('\n');
  for (const secret of [
    run.runToken,
    fixture.origin,
    'teammate+qa@example.test',
    'frame-snapshot',
    'x-fixture-token',
  ])
    assert(!safeText.includes(secret));
  const safeReplay = JSON.parse(strFromU8(safeFiles.get('replay.json') as Uint8Array));
  assert(safeReplay.actions.some((action: { method: string }) => action.method === 'fill'));
  assert.deepEqual(
    safeReplay.requests
      .filter((item: { method: string }) => item.method === 'POST')
      .map((item: { status: number }) => item.status),
    [201, 400],
  );
  const replayUrl = `${base}/submissions/${listed.submissions[0].id}/replay`;
  const unauthenticated = await fetch(`${app.origin}${replayUrl}`);
  assert.equal(unauthenticated.status, 401);
  const foreign = await page.request.get(`${base}/submissions/${crypto.randomUUID()}/replay`);
  assert.equal(foreign.status(), 404);
  // Exercise the download control as well as the API response.
  const traceDownloadEvent = page.waitForEvent('download');
  await replay.getByRole('link', { name: 'Download sanitized trace' }).click();
  const traceDownload = await traceDownloadEvent;
  assert.equal(await traceDownload.failure(), null);
  const tracePath = resolve(directory, 'sanitized.trace.zip');
  await traceDownload.saveAs(tracePath);
  assert.deepEqual(await readFile(tracePath), sanitized);
  await checkTraceViewer(browser, tracePath, safeReplay.actions.length);
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const accessibility = await new AxeBuilder({ page })
      .include('.replay-panel')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    assert.deepEqual(
      accessibility.violations.map(({ id }) => id),
      [],
    );
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await replay.screenshot({ path: resolve(directory, `replay-${viewport.width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await brief.getByRole('button', { name: 'Close replay', exact: true }).click();
  await brief
    .locator('.review-block')
    .getByRole('button', { name: 'View replay', exact: true })
    .click();
  await expect(replay.locator('.replay-result')).toContainText('HTTP 400');
  // An already-open replay must still be reachable from the finding below it.
  const findingReplay = brief
    .locator('.review-block')
    .getByRole('button', { name: 'View replay', exact: true });
  await findingReplay.scrollIntoViewIfNeeded();
  await findingReplay.click();
  await expect(replay.getByRole('heading', { name: 'Recorded replay' })).toBeInViewport();
  await brief.getByRole('button', { name: 'Close replay', exact: true }).click();
  await page.route(`${app.origin}${replayUrl}`, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Replay temporarily unavailable.' } }),
    }),
  );
  await brief.getByRole('button', { name: 'View replay', exact: true }).first().click();
  await expect(replay.getByRole('alert')).toContainText('Replay temporarily unavailable.');
  await page.unroute(`${app.origin}${replayUrl}`);
  await replay.getByRole('button', { name: 'Try loading replay again' }).click();
  await expect(replay.locator('.replay-result')).toContainText('HTTP 400');
  const downloaded = page.waitForEvent('download');
  await brief.getByRole('link', { name: 'Export this brief' }).click();
  const download = await downloaded;
  assert.equal(await download.failure(), null);
  const path = await download.path();
  assert(path);
  const exported = unzipSync(await readFile(path));
  assert.equal(JSON.parse(strFromU8(exported['manifest.json'])).redaction.rawBytesIncluded, false);
  assert.deepEqual(Buffer.from(exported['artifacts/browser.trace.zip']), sanitized);
  const exportedReplay = JSON.parse(strFromU8(exported['replay.json'])).replays[0];
  assert.equal(
    exportedReplay.artifacts.find((item: { kind: string }) => item.kind === 'trace').redactedSha256,
    servedTrace.headers()['x-trialoom-artifact-hash'],
  );
  const privateTarget = await page.request.post(
    `/api/v1/workspaces/${setup.workspaceId}/projects`,
    {
      headers: { origin: app.origin },
      data: {
        name: 'Must be refused',
        targetUrl: fixture.origin,
        environment: 'preview',
        authorizationConfirmed: true,
      },
    },
  );
  assert.equal(
    privateTarget.status(),
    400,
    'Normal target admission must still refuse loopback fixtures.',
  );
  await page.reload();
  await page.getByRole('button', { name: /Canopy — real Chromium run/ }).click();
  await expect(brief).toContainText('Pending review');
  await assert.rejects(executeInvitationRun(options), code('RUN_CLOSED'));
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM evidence_submissions WHERE run_id=$1', [
        run.runId,
      ])
    ).rows[0].n,
    1,
  );
  console.log(
    'PASS: actual 201/400 trace, recorded replay controls, sanitized download/export hashes, desktop/mobile accessibility, access checks, pending review after reload, no payable, duplicate refusal, target restrictions.',
  );

  async function scenario(
    name: string,
    work: (fresh: Setup, target: Awaited<ReturnType<typeof startFixture>>) => Promise<void>,
    root?: string,
  ) {
    const target = await startFixture(root);
    try {
      await work(await seedBrowserFixture(pool, target), target);
      console.log(`PASS: ${name}`);
    } finally {
      await target.close();
    }
  }
  async function empty(runId: string) {
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM evidence_submissions WHERE run_id=$1', [
          runId,
        ])
      ).rows[0].n,
      0,
    );
  }
  await scenario(
    'expired grant refuses execution and creates no submission',
    async (fresh, target) => {
      const expired = await fresh.assignment();
      await pool.query(
        "UPDATE runs SET issued_at=clock_timestamp()-interval '2 seconds', grant_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [expired.runId],
      );
      await assert.rejects(
        executeInvitationRun({ ...options, ...expired, fixture: target }),
        code('RUN_EXPIRED'),
      );
      await empty(expired.runId);
    },
  );
  await scenario(
    'cancelling a running browser closes its context and submits nothing',
    async (fresh, target) => {
      const cancelled = await fresh.assignment();
      const controller = new AbortController();
      const contexts = browser.contexts().length;
      await assert.rejects(
        executeInvitationRun({
          ...options,
          ...cancelled,
          fixture: target,
          signal: controller.signal,
          onProgress: (phase) => {
            if (phase === 'opened') controller.abort();
          },
        }),
        code('CANCELLED'),
      );
      await empty(cancelled.runId);
      assert.equal(browser.contexts().length, contexts);
    },
  );
  await scenario('unavailable fixture is reported blocked, not a defect', async (fresh, target) => {
    const blocked = await fresh.assignment();
    await target.close();
    // Mark already closed so the scenario cleanup is harmless.
    target.close = async () => undefined;
    const outcome = await executeInvitationRun({ ...options, ...blocked, fixture: target });
    assert.equal(outcome.document.outcome, 'blocked');
    assert.equal(outcome.document.blockedReason, 'infrastructure_unavailable');
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM findings WHERE assignment_id=$1', [
          blocked.assignmentId,
        ])
      ).rows[0].n,
      0,
    );
  });
  await scenario(
    'a revoked run grant interrupts the browser before submission',
    async (fresh, target) => {
      const revoked = await fresh.assignment();
      let revoke: Promise<unknown> | undefined;
      let revokeError: unknown;
      await assert.rejects(
        executeInvitationRun({
          ...options,
          ...revoked,
          fixture: target,
          onProgress: (phase) => {
            if (phase === 'opened')
              revoke = abandonRun(pool, fresh.session, revoked.runId, {
                attemptToken: revoked.attemptToken,
              }).catch((error) => {
                revokeError = error;
              });
          },
        }),
        code('RUN_CLOSED'),
      );
      await revoke;
      assert.equal(revokeError, undefined);
      await empty(revoked.runId);
    },
  );
  const slowRoot = resolve(directory, 'slow-fixture');
  await mkdir(slowRoot, { recursive: true, mode: 0o700 });
  for (const name of fixtureFiles) {
    const source = await readFile(resolve(fixtureRoot, name), 'utf8');
    await writeFile(
      resolve(slowRoot, name),
      name === 'app.js'
        ? source.replace(
            "const response = await fetch('/api/invitations'",
            "await new Promise(resolve => setTimeout(resolve, 2000));\n    const response = await fetch('/api/invitations'",
          )
        : source,
      { mode: 0o600 },
    );
  }
  await scenario(
    'runner time cap stops a stalled journey and reports a blockage',
    async (fresh, target) => {
      const capped = await fresh.assignment();
      const outcome = await executeInvitationRun({
        ...options,
        ...capped,
        fixture: target,
        timeoutMs: 1000,
      });
      assert.equal(outcome.document.outcome, 'blocked');
      assert.equal(outcome.document.blockedReason, 'agent_limitation');
    },
    slowRoot,
  );
  const patchedRoot = resolve(directory, 'patched-fixture');
  await mkdir(patchedRoot, { recursive: true, mode: 0o700 });
  for (const name of fixtureFiles) {
    const source = await readFile(resolve(fixtureRoot, name), 'utf8');
    await writeFile(
      resolve(patchedRoot, name),
      name === 'validation.mjs' ? source.replace('[a-zA-Z0-9._-]+@', '[a-zA-Z0-9._+-]+@') : source,
      { mode: 0o600 },
    );
  }
  await scenario(
    'same driver observes a repaired fixture passing both invitations',
    async (fresh, target) => {
      const passed = await fresh.assignment();
      const outcome = await executeInvitationRun({ ...options, ...passed, fixture: target });
      assert.deepEqual(
        outcome.responses.map((item) => item.status),
        [201, 201],
      );
      assert.equal(outcome.document.outcome, 'executed');
      assert(outcome.document.assertions.every((item) => item.passed));
      assert.notEqual(outcome.document.build.revision, result.document.build.revision);
    },
    patchedRoot,
  );
  console.log('Real browser integration checks passed.');
}
