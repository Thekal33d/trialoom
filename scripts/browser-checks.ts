import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Browser, expect, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import type { Pool } from 'pg';
import { fixtureFiles, fixtureRoot, startFixture } from '../spikes/browser-evidence/fixture.mjs';
import { abandonRun } from '../src/server/runner.ts';
import { seedBrowserFixture } from './browser-fixture.ts';
import { BrowserRunError, executeInvitationRun } from './browser-worker.ts';

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
  assert.equal(stored.reviewable, false);
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
  const downloaded = page.waitForEvent('download');
  await brief.getByRole('link', { name: 'Export this brief' }).click();
  const download = await downloaded;
  assert.equal(await download.failure(), null);
  const path = await download.path();
  assert(path);
  const exported = unzipSync(await readFile(path));
  assert.equal(JSON.parse(strFromU8(exported['manifest.json'])).redaction.rawBytesIncluded, false);
  assert(!Object.keys(exported).some((key) => key.endsWith('.zip')));
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
    'PASS: actual 201/400 trace, hashed HTTP upload, pending review after reload, redacted export, no payable, duplicate refusal, production target restrictions.',
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
