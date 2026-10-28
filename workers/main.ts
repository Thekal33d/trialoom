import { setTimeout } from 'node:timers/promises';
import { sweepExpiredAssignments } from '../src/server/assignments.ts';
import { createPool, databaseUrl } from '../src/server/database.ts';
import { releaseSettledAssignments } from '../src/server/decisions.ts';
import { processOne } from '../src/server/jobs.ts';
import { reconcilePurchase } from '../src/server/resources.ts';
import { dispatchPayout } from '../src/server/settlement.ts';

const pool = createPool(databaseUrl());
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const once = process.argv.includes('--once');
// Claim leases are fenced on every operator action as well; this sweep returns
// a lapsed assignment's reservation to its campaign without waiting for one.
let nextSweep = 0;
try {
  do {
    if (Date.now() >= nextSweep) {
      nextSweep = Date.now() + 30_000;
      const expired = await sweepExpiredAssignments(pool);
      if (expired) console.log(JSON.stringify({ event: 'assignments.expired', count: expired }));
      // A refused amount stays reserved until its appeal window closes.
      const settled = await releaseSettledAssignments(pool);
      if (settled.assignments)
        console.log(JSON.stringify({ event: 'assignments.settled', count: settled.assignments }));
    }
    // No funded payment authority is configured, so the default adapter blocks
    // every payout with a visible reason instead of pretending to pay it.
    const worked = await processOne(pool, {
      'payout.dispatch': (client, lease) => dispatchPayout(client, lease),
      // A purchase holds its reservation until this answers. No resource wallet
      // is configured either, so nothing has been bought to reconcile.
      'resource.reconcile': (client, lease) => reconcilePurchase(client, lease),
    });
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
