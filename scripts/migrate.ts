import { createPool, databaseUrl } from '../src/server/database.ts';
import { migrate } from '../src/server/migrations.ts';

const pool = createPool(databaseUrl());
try {
  console.log(JSON.stringify({ event: 'migrations.complete', applied: await migrate(pool) }));
} catch {
  console.error('Migration failed. Check database availability and immutable migration checksums.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
