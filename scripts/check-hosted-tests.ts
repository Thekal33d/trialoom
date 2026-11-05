import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dispatchHostedTest } from '../src/server/hosted-test-dispatch.ts';
import { hostedTestStatus, requestHostedTest } from '../src/server/hosted-tests.ts';
import { migrate } from '../src/server/migrations.ts';
import { prepareRun } from '../src/server/runner.ts';
import { disposableDatabase } from '../tests/helpers/database.ts';
import { seedPublicMarketplace } from '../tests/helpers/public-marketplace.ts';
import { startLocalServer } from './local-server.ts';
import { executePreviewRun } from './preview-controller.ts';
import { buildPreviewImage } from './preview-host.ts';

const directory = resolve('artifacts/hosted-test-checks', randomBytes(8).toString('hex'));
await mkdir(directory, { recursive: true, mode: 0o700 });
process.env.TRIALOOM_RUNNER_DISPATCH_KEY = randomBytes(32).toString('hex');
process.env.TRIALOOM_REMESSO_AGENT_KEY = '';
process.env.TRIALOOM_SPONSOR_AGENT_KEY = '';
const db = await disposableDatabase();
let app: Awaited<ReturnType<typeof startLocalServer>> | undefined;
try {
  await migrate(db.pool);
  const image = await buildPreviewImage();
  const fixture = await seedPublicMarketplace(db.pool, image);
  app = await startLocalServer(db.url, directory);
  const assignment = await fixture.assignment();
  const queued = await requestHostedTest(db.pool, fixture.session, assignment.assignmentId, {
    attemptToken: assignment.attemptToken,
  });
  let deliveries = 0;
  await dispatchHostedTest(
    db.pool,
    fixture.host.hostId,
    async (job, runToken, signal) => {
      deliveries++;
      const receipt = await executePreviewRun({
        journal: { pool: db.pool, directory: resolve(directory, 'captures') },
        apiOrigin: app?.origin ?? '',
        runId: job.run_id,
        runToken,
        hostCredential: fixture.host.credential,
        image: job.image,
        mode: 'owned',
        signal,
      });
      assert.equal(receipt.receipt.egress.witnessed, true);
      assert.equal(receipt.receipt.decision, 'pending_review');
      // Simulate losing the acknowledgement after the application committed delivery.
      throw new Error('simulated post-delivery connection loss');
    },
    undefined,
    fixture.deps,
    async (...args) => {
      const prepared = await prepareRun(...args);
      // Only this disposable harness substitutes the broker's owned loopback fixture.
      // Production dispatch always calls prepareRun with public DNS validation.
      prepared.targetCheck = {
        ...prepared.targetCheck,
        policy: 'offline-owned-proxy-fixture-v1',
        addresses: ['127.0.0.1'],
        admittedAddresses: ['127.0.0.1'],
      };
      return prepared;
    },
  );
  const status = await hostedTestStatus(db.pool, fixture.session, assignment.assignmentId);
  assert.equal(status.state, 'submitted');
  assert.equal(
    await dispatchHostedTest(
      db.pool,
      fixture.host.hostId,
      async () => {
        deliveries++;
      },
      undefined,
      fixture.deps,
    ),
    false,
  );
  const retry = await requestHostedTest(db.pool, fixture.session, assignment.assignmentId, {
    attemptToken: assignment.attemptToken,
  });
  assert.equal(retry.id, queued.id);
  assert.equal(deliveries, 1);
  assert.equal(
    (await db.pool.query('SELECT count(*)::int AS n FROM evidence_submissions')).rows[0].n,
    1,
  );
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM payables')).rows[0].n, 0);
  assert.equal(
    (
      await db.pool.query('SELECT committed_units FROM campaign_accounts WHERE campaign_id=$1', [
        assignment.campaignId,
      ])
    ).rows[0].committed_units,
    '1000000',
  );
  assert(
    (
      await db.pool.query('SELECT cleanup_at FROM preview_executions WHERE run_id=$1', [
        status.run_id,
      ])
    ).rows[0].cleanup_at,
  );
  console.log(
    JSON.stringify({
      event: 'hosted_test.verified',
      publicClaim: true,
      realIsolatedBrowser: true,
      evidenceSubmissions: 1,
      repeatedExecution: false,
      review: 'pending',
      payables: 0,
      funding: 'fixture-only',
      publicTargetsContacted: false,
      directory,
    }),
  );
} finally {
  await app?.close();
  await db.close();
}
