import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';

/** Read permission afresh; a previously authenticated grant is not a lease renewal. */
export async function assertRunLive(
  db: Pool | PoolClient,
  run: {
    state: string;
    grant_expires_at: string | Date;
    assignment_id: string;
    attempt_token: string;
    host_id: string | null;
  },
  lock = false,
) {
  if (!['issued', 'active'].includes(run.state))
    throw new AppError('RUN_CLOSED', 'This run is closed.', 409);
  if (new Date(run.grant_expires_at).getTime() <= Date.now())
    throw new AppError('RUN_EXPIRED', 'This run grant has expired.', 401);
  const assignment = (
    await db.query(
      `SELECT state,attempt_token,lease_expires_at FROM assignments WHERE id=$1${lock ? ' FOR SHARE' : ''}`,
      [run.assignment_id],
    )
  ).rows[0];
  if (!assignment || assignment.attempt_token !== run.attempt_token)
    throw new AppError('STALE_ATTEMPT', 'This run no longer owns the assignment attempt.', 409);
  if (!['claimed', 'running'].includes(assignment.state))
    throw new AppError('ATTEMPT_CLOSED', 'This assignment no longer permits execution.', 409);
  if (new Date(assignment.lease_expires_at).getTime() <= Date.now())
    throw new AppError('CLAIM_EXPIRED', 'This assignment lease has expired.', 409);
  if (run.host_id) {
    const host = (
      await db.query(`SELECT revoked_at FROM runner_hosts WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [
        run.host_id,
      ])
    ).rows[0];
    if (!host || host.revoked_at)
      throw new AppError('HOST_UNUSABLE', 'The runner host has been revoked.', 409);
  }
}

/** Assignment before run, matching lease/release paths and evidence ingestion. */
export async function lockLiveRun(db: PoolClient, runId: string) {
  await db.query(
    `SELECT id FROM assignments WHERE id=(SELECT assignment_id FROM runs WHERE id=$1) FOR UPDATE`,
    [runId],
  );
  const run = (await db.query('SELECT * FROM runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
  if (!run) throw new AppError('NOT_FOUND', 'Run not found.', 404);
  await assertRunLive(db, run, true);
  return run;
}
