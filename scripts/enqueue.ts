import { randomUUID } from 'node:crypto';
import { createPool, databaseUrl } from '../src/server/database.ts';
import { enqueuePing } from '../src/server/jobs.ts';

const pool = createPool(databaseUrl());
try {
  console.log(
    JSON.stringify({
      event: 'job.enqueued',
      jobId: await enqueuePing(pool, process.argv[2] ?? `smoke:${randomUUID()}`),
    }),
  );
} catch {
  console.error('Could not enqueue the local smoke job.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
