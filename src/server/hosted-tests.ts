import { createHash, createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '../domain/errors.ts';
import { supportsHostedTest } from '../domain/hosted-tests.ts';
import type { AgentSession } from './agents.ts';
import { requireScope } from './agents.ts';
import { liveAssignment } from './assignments.ts';
import { transaction } from './database.ts';
import { requireVerifiedTarget } from './target-verification.ts';

export function dispatchKey(env = process.env) {
  const key = env.TRIALOOM_RUNNER_DISPATCH_KEY ?? '';
  if (!/^[a-f0-9]{64}$/i.test(key))
    throw new AppError(
      'HOSTED_TESTING_UNAVAILABLE',
      'Hosted paid testing has not been configured yet.',
      503,
    );
  return Buffer.from(key, 'hex');
}
export const dispatchKeyHash = () => createHash('sha256').update(dispatchKey()).digest('hex');
/** Recover the same narrow run grant after a crash. No wallet or agent key is stored. */
export function hostedRunToken(
  jobId: string,
  assignmentId: string,
  attemptToken: string,
  key = dispatchKey(),
) {
  return `trun_${createHmac('sha256', key).update(`hosted-test-v1:${jobId}:${assignmentId}:${attemptToken}`).digest('base64url')}`;
}
export async function paidRunnerHeartbeat(pool: Pool, hostId: string, image: string) {
  z.string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .parse(image);
  const result = await pool.query(
    `INSERT INTO paid_runner_runtime (host_id,image,dispatch_key_hash,heartbeat_at)
    SELECT id,$2,$3,clock_timestamp() FROM runner_hosts WHERE id=$1 AND platform_managed AND revoked_at IS NULL
    ON CONFLICT(host_id) DO UPDATE SET image=excluded.image,dispatch_key_hash=excluded.dispatch_key_hash,heartbeat_at=excluded.heartbeat_at RETURNING host_id`,
    [hostId, image, dispatchKeyHash()],
  );
  if (!result.rowCount)
    throw new AppError(
      'HOST_UNUSABLE',
      'Only a platform-managed runner can advertise hosted execution.',
      409,
    );
}
export async function queueHostedTest(
  db: PoolClient,
  session: AgentSession,
  assignmentId: string,
  input: unknown,
) {
  requireScope(session, 'runs:execute');
  const data = z.object({ attemptToken: z.uuid() }).strict().parse(input);
  const prior = (
    await db.query(
      'SELECT id,state,run_id FROM hosted_test_jobs WHERE assignment_id=$1 AND operator_id=$2 AND attempt_token=$3',
      [assignmentId, session.operator.id, data.attemptToken],
    )
  ).rows[0];
  if (prior)
    return {
      id: prior.id as string,
      state: prior.state as string,
      runId: prior.run_id as string | null,
    };
  dispatchKey();
  const assignment = await liveAssignment(db, session, assignmentId, data.attemptToken);
  const terms = (
    await db.query('SELECT document FROM terms_versions WHERE id=$1', [assignment.terms_version_id])
  ).rows[0].document;
  if (!supportsHostedTest(terms))
    throw new AppError(
      'HOSTED_SCOPE_UNSUPPORTED',
      'Hosted execution supports the read-only homepage test. Other journeys require a compatible runner and their own evidence.',
      409,
    );
  await requireVerifiedTarget(db, assignment.project_id);
  const runner = (
    await db.query(
      `SELECT r.host_id,r.image,r.dispatch_key_hash FROM paid_runner_runtime r JOIN runner_hosts h ON h.id=r.host_id
    WHERE h.platform_managed AND h.revoked_at IS NULL AND r.heartbeat_at>clock_timestamp()-interval '60 seconds'
    AND r.dispatch_key_hash=$1 ORDER BY r.heartbeat_at DESC LIMIT 1`,
      [dispatchKeyHash()],
    )
  ).rows[0];
  if (!runner)
    throw new AppError(
      'HOSTED_TESTING_UNAVAILABLE',
      'The paid test runner is offline. Keep or release this assignment and try again when it is available.',
      503,
    );
  if (
    (
      await db.query("SELECT 1 FROM runs WHERE assignment_id=$1 AND state IN ('issued','active')", [
        assignmentId,
      ])
    ).rowCount
  )
    throw new AppError('RUN_ALREADY_ACTIVE', 'This assignment already has an active run.', 409);
  const row = (
    await db.query(
      `INSERT INTO hosted_test_jobs (assignment_id,operator_id,credential_id,attempt_token,host_id,image,dispatch_key_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(assignment_id) DO UPDATE SET assignment_id=excluded.assignment_id RETURNING id,state,run_id`,
      [
        assignmentId,
        session.operator.id,
        session.credential.id,
        data.attemptToken,
        runner.host_id,
        runner.image,
        runner.dispatch_key_hash,
      ],
    )
  ).rows[0];
  return { id: row.id as string, state: row.state as string, runId: row.run_id as string | null };
}
export async function requestHostedTest(
  pool: Pool,
  session: AgentSession,
  assignmentId: string,
  input: unknown,
) {
  return transaction(pool, (db) => queueHostedTest(db, session, assignmentId, input));
}
export async function hostedTestStatus(pool: Pool, session: AgentSession, assignmentId: string) {
  requireScope(session, 'assignments:read');
  const row = (
    await pool.query(
      'SELECT id,state,run_id,reason,created_at,finished_at FROM hosted_test_jobs WHERE assignment_id=$1 AND operator_id=$2',
      [assignmentId, session.operator.id],
    )
  ).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 'Hosted test not found.', 404);
  return row;
}
