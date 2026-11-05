import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { FreeTestResult, FreeTestSummary } from '../domain/free-tests.ts';
import { canonicalJson } from '../domain/values.ts';
import { targetVerified } from './target-verification.ts';

export type FreeExecution = {
  id: string;
  project_id: string | null;
  kind: 'sample' | 'homepage';
  phase: FreeTestSummary['phase'];
  target: { url: string; origin: string; addresses: string[] };
  image: string;
  container_prefix: string;
  deadline_at: Date;
  cancel_requested: boolean;
  result: FreeTestResult | null;
  result_hash: string | null;
};
export type FreeRunner = {
  image: string;
  allowedOrigins: string[];
  acceptsVerifiedTargets?: boolean;
  run: (execution: FreeExecution, signal: AbortSignal) => Promise<FreeTestResult>;
  cleanup: (execution: FreeExecution) => Promise<void>;
};
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export async function freeRunnerHeartbeat(
  pool: Pool,
  allowedOrigins: string[],
  acceptsVerifiedTargets = false,
) {
  await pool.query(
    `INSERT INTO free_test_runtime (id,heartbeat_at,allowed_origins,accepts_verified_targets) VALUES (true,clock_timestamp(),$1,$2)
    ON CONFLICT(id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,allowed_origins=excluded.allowed_origins,accepts_verified_targets=excluded.accepts_verified_targets`,
    [JSON.stringify(allowedOrigins), acceptsVerifiedTargets],
  );
}

/** One deployment-wide session lock. A running record is NEVER automatically executed again. */
export async function dispatchFreeTest(
  pool: Pool,
  runner: FreeRunner,
  signal?: AbortSignal,
  checkpoint?: (phase: 'running' | 'captured') => Promise<void>,
) {
  assert.match(runner.image, /^sha256:[a-f0-9]{64}$/);
  const client = await pool.connect();
  const abort = new AbortController();
  let broken = false;
  let locked = false;
  const lost = () => {
    broken = true;
    abort.abort();
  };
  const stop = () => abort.abort();
  client.on('error', lost);
  client.on('end', lost);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  let poll: Promise<void> | undefined;
  const polling = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(42120702) AS held')).rows[0].held;
    if (!locked || abort.signal.aborted) return false;
    if (
      (await client.query("SELECT 1 FROM hosted_test_jobs WHERE state='running' LIMIT 1")).rowCount
    )
      return false;
    let row = (
      await client.query<FreeExecution>(
        "SELECT * FROM free_tests WHERE phase IN ('running','captured','queued') ORDER BY CASE WHEN phase='queued' THEN 1 ELSE 0 END,created_at LIMIT 1",
      )
    ).rows[0];
    if (!row) return false;
    if (row.phase === 'queued') {
      if (
        row.kind === 'homepage' &&
        !runner.allowedOrigins.includes(row.target.origin) &&
        !(
          runner.acceptsVerifiedTargets &&
          row.project_id &&
          (await targetVerified(client, row.project_id, row.target.origin))
        )
      ) {
        await client.query(
          "UPDATE free_tests SET phase='cancelled',cancel_requested=true,cleanup_at=clock_timestamp() WHERE id=$1 AND phase='queued'",
          [row.id],
        );
        return true;
      }
      const claimed = await client.query<FreeExecution>(
        "UPDATE free_tests SET phase='running',image=$2,deadline_at=clock_timestamp()+interval '60 seconds' WHERE id=$1 AND phase='queued' AND NOT cancel_requested RETURNING *",
        [row.id, runner.image],
      );
      if (!claimed.rowCount) return true;
      row = claimed.rows[0];
      const execution = row;
      deadline = setTimeout(stop, Math.max(1, row.deadline_at.getTime() - Date.now()));
      poll = (async () => {
        while (!polling.signal.aborted) {
          await delay(500, undefined, { signal: polling.signal });
          const current = (
            await client.query(
              'SELECT cancel_requested, deadline_at>clock_timestamp() AS timely FROM free_tests WHERE id=$1',
              [execution.id],
            )
          ).rows[0];
          if (!current || current.cancel_requested || !current.timely) abort.abort();
          if (abort.signal.aborted) return;
        }
      })().catch(() => {
        if (!polling.signal.aborted) abort.abort();
      });
      try {
        await checkpoint?.('running');
        abort.signal.throwIfAborted();
        const result = await runner.run(execution, abort.signal);
        abort.signal.throwIfAborted();
        const encoded = canonicalJson(result);
        assert(Buffer.byteLength(encoded) <= 1024 ** 2);
        assert(['completed', 'blocked'].includes(result.outcome));
        // The capture and its hash become durable together. Cleanup may be retried.
        const saved = await client.query(
          "UPDATE free_tests SET phase='captured',result=$2,result_hash=$3 WHERE id=$1 AND phase='running' AND NOT cancel_requested AND deadline_at>clock_timestamp() RETURNING *",
          [row.id, encoded, digest(result)],
        );
        if (saved.rowCount) {
          row = saved.rows[0];
          await checkpoint?.('captured');
        }
      } catch {
        // Raw target/process exceptions never enter product records or logs.
      } finally {
        polling.abort();
        await poll;
        clearTimeout(deadline);
      }
    }
    // On restart clean the recorded identities first; never reuse them for new work.
    // If cleanup cannot be proved, leave the active record occupying the global slot.
    await runner.cleanup(row);
    assert(!broken, 'DISPATCH_CONNECTION_LOST');
    if (row.result) assert.equal(digest(row.result), row.result_hash, 'FREE_RESULT_CORRUPT');
    await client.query(
      `UPDATE free_tests SET cleanup_at=COALESCE(cleanup_at,clock_timestamp()),
      phase=CASE WHEN cancel_requested THEN 'cancelled' WHEN phase='captured' THEN result->>'outcome' ELSE 'interrupted' END
      WHERE id=$1 AND phase IN ('running','captured')`,
      [row.id],
    );
    return true;
  } finally {
    polling.abort();
    await poll;
    clearTimeout(deadline);
    signal?.removeEventListener('abort', stop);
    try {
      if (locked && !broken) await client.query('SELECT pg_advisory_unlock(42120702)');
    } catch {
      broken = true;
    }
    client.removeListener('error', lost);
    client.removeListener('end', lost);
    client.release(broken);
  }
}
