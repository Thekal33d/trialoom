import { setTimeout as delay } from 'node:timers/promises';
import { configuredFreeOrigins, freePreviewRunner } from '../scripts/free-preview-runner.ts';
import { buildPreviewImage } from '../scripts/preview-host.ts';
import { createPool, databaseUrl } from '../src/server/database.ts';
import { dispatchFreeTest, freeRunnerHeartbeat } from '../src/server/free-test-dispatch.ts';
import { prepareNextFreeTestReport } from '../src/server/free-test-reports.ts';
import { freeTestsEnabled } from '../src/server/free-tests.ts';

if (!freeTestsEnabled())
  throw new Error('Set TRIALOOM_FREE_TESTS=true to enable the bounded local runner.');
const pool = createPool(databaseUrl());
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
let heart: Promise<void> | undefined;
const service = await pool.connect();
let owned = false;
const lost = () => abort.abort();
service.on('error', lost);
service.on('end', lost);
try {
  owned = (await service.query('SELECT pg_try_advisory_lock(42120703) AS held')).rows[0].held;
  if (!owned) throw new Error('FREE_WORKER_ALREADY_RUNNING');
  const origins = configuredFreeOrigins();
  const runner = freePreviewRunner(await buildPreviewImage(), origins);
  await freeRunnerHeartbeat(pool, origins);
  console.log(
    JSON.stringify({ event: 'free_runner.ready', concurrency: 1, externalOrigins: origins.length }),
  );
  heart = (async () => {
    while (!abort.signal.aborted) {
      await delay(3000, undefined, { signal: abort.signal });
      await freeRunnerHeartbeat(pool, origins);
    }
  })().catch(() => abort.abort());
  do {
    const worked = await dispatchFreeTest(pool, runner, abort.signal);
    // Local preparation is recoverable and cannot pay. A report failure must not hide a test.
    await prepareNextFreeTestReport(pool).catch(() => {
      console.error(JSON.stringify({ event: 'free_report.preparation_unavailable' }));
    });
    if (process.argv.includes('--once')) break;
    if (!worked) await delay(1000, undefined, { signal: abort.signal });
  } while (!abort.signal.aborted);
} catch {
  if (!abort.signal.aborted) {
    console.error(
      JSON.stringify({
        event: 'free_runner.unavailable',
        note: 'Active executions retain their slot until cleanup is confirmed.',
      }),
    );
    process.exitCode = 1;
  }
} finally {
  abort.abort();
  await heart;
  if (owned) {
    await service
      .query(
        "UPDATE free_test_runtime SET heartbeat_at=clock_timestamp()-interval '61 seconds' WHERE id=true",
      )
      .catch(() => {});
    await service.query('SELECT pg_advisory_unlock(42120703)').catch(() => {});
  }
  service.removeListener('error', lost);
  service.removeListener('end', lost);
  service.release(true);
  await pool.end();
}
