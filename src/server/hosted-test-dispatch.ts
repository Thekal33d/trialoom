import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { AppError } from '../domain/errors.ts';
import type { AgentSession } from './agents.ts';
import { requireScope } from './agents.ts';
import { transaction } from './database.ts';
import { dispatchKeyHash, hostedRunToken } from './hosted-tests.ts';
import { issueRun, prepareRun } from './runner.ts';

export type HostedJob = {
  id: string;
  assignment_id: string;
  operator_id: string;
  credential_id: string;
  attempt_token: string;
  host_id: string;
  image: string;
  dispatch_key_hash: string;
  state: 'queued' | 'running' | 'submitted' | 'blocked' | 'interrupted';
  run_id: string | null;
};
export type HostedExecutor = (
  job: HostedJob & { run_id: string },
  runToken: string,
  signal: AbortSignal,
) => Promise<unknown>;
async function credentialFor(pool: Pool, job: HostedJob): Promise<AgentSession> {
  const row = (
    await pool.query(
      `SELECT c.id,c.name,c.scopes,c.expires_at,o.id AS operator_id,o.handle,o.status,o.user_id
    FROM agent_credentials c JOIN operators o ON o.id=c.operator_id WHERE c.id=$1 AND o.id=$2
    AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND o.status='registered'`,
      [job.credential_id, job.operator_id],
    )
  ).rows[0];
  if (!row)
    throw new AppError(
      'CREDENTIAL_INVALID',
      'The queued agent credential is no longer usable.',
      401,
    );
  const session = {
    operator: { id: row.operator_id, handle: row.handle, status: row.status },
    credential: { id: row.id, name: row.name, scopes: row.scopes, expiresAt: row.expires_at },
    userId: row.user_id,
  };
  requireScope(session, 'runs:execute');
  return session;
}
/** Shares the browser slot with free tests. Recovery always uses the same run and journal. */
export async function dispatchHostedTest(
  pool: Pool,
  hostId: string,
  execute: HostedExecutor,
  signal?: AbortSignal,
  deps: Parameters<typeof prepareRun>[4] = {},
  prepare: typeof prepareRun = prepareRun,
) {
  const db = await pool.connect();
  const abort = new AbortController();
  let locked = false;
  let broken = false;
  const stop = () => abort.abort();
  const lost = () => {
    broken = true;
    stop();
  };
  db.on('error', lost);
  db.on('end', lost);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try {
    locked = (await db.query('SELECT pg_try_advisory_lock(42120702) AS held')).rows[0].held;
    if (!locked || abort.signal.aborted) return false;
    if (
      (await db.query("SELECT 1 FROM free_tests WHERE phase IN ('running','captured') LIMIT 1"))
        .rowCount
    )
      return false;
    if (
      (
        await db.query(
          "SELECT 1 FROM hosted_test_jobs WHERE state='running' AND host_id<>$1 LIMIT 1",
          [hostId],
        )
      ).rowCount
    )
      return false;
    let job = (
      await db.query<HostedJob>(
        `SELECT * FROM hosted_test_jobs WHERE host_id=$1 AND state IN ('queued','running')
      AND retry_at<=clock_timestamp() ORDER BY CASE WHEN state='running' THEN 0 ELSE 1 END,created_at LIMIT 1`,
        [hostId],
      )
    ).rows[0];
    if (!job) return false;
    if (job.dispatch_key_hash !== dispatchKeyHash()) throw new Error('DISPATCH_KEY_CHANGED');
    const token = hostedRunToken(job.id, job.assignment_id, job.attempt_token);
    try {
      if (job.state === 'queued') {
        const session = await credentialFor(pool, job);
        const prepared = await prepare(
          pool,
          session,
          job.assignment_id,
          { attemptToken: job.attempt_token, hostId },
          deps,
        );
        prepared.secret = token;
        const prior = job;
        job = await transaction(pool, async (client) => {
          const current = (
            await client.query<HostedJob>('SELECT * FROM hosted_test_jobs WHERE id=$1 FOR UPDATE', [
              prior.id,
            ])
          ).rows[0];
          assert.equal(current.state, 'queued');
          abort.signal.throwIfAborted();
          const run = await issueRun(client, session, prepared);
          return (
            await client.query<HostedJob>(
              "UPDATE hosted_test_jobs SET state='running',run_id=$2 WHERE id=$1 RETURNING *",
              [prior.id, run.runId],
            )
          ).rows[0];
        });
      }
      assert(job.run_id);
      abort.signal.throwIfAborted();
      await execute({ ...job, run_id: job.run_id }, token, abort.signal);
    } catch (error) {
      if (broken || abort.signal.aborted) throw error;
      // Only fixed error codes enter product records; private target/process text never does.
      const reason =
        error instanceof AppError &&
        [
          'TARGET_VERIFICATION_REQUIRED',
          'CREDENTIAL_INVALID',
          'CLAIM_EXPIRED',
          'STALE_ATTEMPT',
          'ATTEMPT_CLOSED',
          'HOST_UNUSABLE',
          'SCOPE_REQUIRED',
          'LEASE_TOO_SHORT',
        ].includes(error.code)
          ? error.code
          : 'EXECUTION_UNAVAILABLE';
      if (!job.run_id) {
        await db.query(
          "UPDATE hosted_test_jobs SET state='blocked',reason=$2,finished_at=clock_timestamp() WHERE id=$1",
          [job.id, reason],
        );
        return true;
      }
      // A network failure may occur after submission committed. Reconcile below.
    }
    const submitted = (
      await db.query('SELECT id FROM evidence_submissions WHERE run_id=$1', [job.run_id])
    ).rows[0];
    if (submitted) {
      await db.query(
        "UPDATE hosted_test_jobs SET state='submitted',reason=NULL,finished_at=clock_timestamp() WHERE id=$1",
        [job.id],
      );
      return true;
    }
    const journal = (
      await db.query('SELECT phase,cleanup_at FROM preview_executions WHERE run_id=$1', [
        job.run_id,
      ])
    ).rows[0];
    const run = (
      await db.query('SELECT state,grant_expires_at FROM runs WHERE id=$1', [job.run_id])
    ).rows[0];
    if (journal?.cleanup_at && ['dispatching', 'interrupted'].includes(journal.phase)) {
      await db.query(
        "UPDATE hosted_test_jobs SET state='interrupted',reason='EXECUTION_INTERRUPTED',finished_at=clock_timestamp() WHERE id=$1",
        [job.id],
      );
    } else if (
      (!journal || journal.cleanup_at) &&
      (new Date(run.grant_expires_at).getTime() <= Date.now() ||
        !['issued', 'active'].includes(run.state))
    ) {
      await db.query(
        "UPDATE hosted_test_jobs SET state='blocked',reason='DELIVERY_WINDOW_CLOSED',finished_at=clock_timestamp() WHERE id=$1",
        [job.id],
      );
    } else {
      // Keep the original identity and commitment until cleanup/delivery can be resolved.
      await db.query(
        "UPDATE hosted_test_jobs SET retry_at=clock_timestamp()+interval '5 seconds',reason='RECOVERY_PENDING' WHERE id=$1",
        [job.id],
      );
    }
    return true;
  } finally {
    signal?.removeEventListener('abort', stop);
    try {
      if (locked && !broken) await db.query('SELECT pg_advisory_unlock(42120702)');
    } catch {
      broken = true;
    }
    db.removeListener('error', lost);
    db.removeListener('end', lost);
    db.release(broken);
  }
}
