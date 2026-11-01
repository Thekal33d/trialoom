import { readFileSync } from 'node:fs';
import { createPool, databaseUrl } from '../src/server/database.ts';
import { dispatchFreeTest } from '../src/server/free-test-dispatch.ts';
import { freePreviewRunner } from './free-preview-runner.ts';

const input = JSON.parse(readFileSync(0, 'utf8')) as {
  image: string;
  checkpoint: 'running' | 'captured';
};
const pool = createPool(databaseUrl());
async function pause(stage: string) {
  if (stage !== input.checkpoint) return;
  process.send?.({ checkpoint: stage });
  await new Promise<void>(() => {});
}
try {
  const runner = freePreviewRunner(input.image, [], () => pause('running'));
  await dispatchFreeTest(pool, runner, undefined, async (stage) => {
    if (stage === 'captured') await pause(stage);
  });
} catch {
  process.send?.({ error: 'FREE_CHECK_FAILED' });
  process.exitCode = 1;
} finally {
  await pool.end();
}
