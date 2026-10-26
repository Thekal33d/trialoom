import { setTimeout } from 'node:timers/promises';
import { createPool, databaseUrl } from '../src/server/database.ts';
import { processOne } from '../src/server/jobs.ts';

const pool = createPool(databaseUrl());
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const once = process.argv.includes('--once');
try {
  do {
    const worked = await processOne(pool);
    if (once) break;
    if (!worked) await setTimeout(1000, undefined, { signal: controller.signal });
  } while (!controller.signal.aborted);
} catch {
  if (!controller.signal.aborted) {
    console.error(JSON.stringify({ event: 'worker.failed' }));
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
