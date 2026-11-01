import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '../domain/errors.ts';
import type { FreeTestsView } from '../domain/free-tests.ts';
import { type Actor, audit, requireRole } from './access.ts';
import { transaction } from './database.ts';

const requestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sample'), requestId: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal('homepage'),
      requestId: z.uuid(),
      projectId: z.uuid(),
      authorizationConfirmed: z.literal(true),
    })
    .strict(),
]);
const active = "('queued','running','captured')";
const utcDay = "date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
export const freeTestLimits = { perAccount: 3, perOrigin: 5, globalDaily: 30, queue: 10 } as const;
export function freeTestsEnabled(env = process.env) {
  return env.TRIALOOM_FREE_TESTS === 'true';
}
async function owner(db: PoolClient, actor: Actor, workspaceId: string) {
  await requireRole(db, actor, workspaceId, ['owner']);
  const account = await db.query(
    'SELECT 1 FROM free_beta_accounts WHERE user_id=$1 AND workspace_id=$2 FOR UPDATE',
    [actor.id, workspaceId],
  );
  if (!account.rowCount)
    throw new AppError('FREE_ACCOUNT_REQUIRED', 'Use your free workspace for this test.', 403);
}
async function runtime(db: PoolClient) {
  return (
    await db.query(
      "SELECT allowed_origins, heartbeat_at > clock_timestamp()-interval '60 seconds' AS ready FROM free_test_runtime WHERE id=true",
    )
  ).rows[0];
}
export async function freeTestsView(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  enabled = freeTestsEnabled(),
): Promise<FreeTestsView> {
  return transaction(pool, async (db) => {
    await owner(db, actor, workspaceId);
    const service = await runtime(db);
    const projectOrigins = (
      await db.query('SELECT DISTINCT authorized_origin FROM projects WHERE workspace_id=$1', [
        workspaceId,
      ])
    ).rows.map((row) => row.authorized_origin as string);
    const count = (
      await db.query(
        `SELECT count(*)::integer AS total FROM free_tests WHERE user_id=$1 AND created_at>=${utcDay}`,
        [actor.id],
      )
    ).rows[0].total;
    const tests = (
      await db.query(
        'SELECT id,project_id,kind,phase,cancel_requested,created_at,result FROM free_tests WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 30',
        [workspaceId],
      )
    ).rows;
    return {
      available: enabled && service?.ready === true,
      allowedOrigins: enabled
        ? projectOrigins.filter((origin) => service?.allowed_origins.includes(origin))
        : [],
      remaining: Math.max(0, freeTestLimits.perAccount - count),
      tests,
    };
  });
}
export async function requestFreeTest(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  input: unknown,
  enabled = freeTestsEnabled(),
) {
  const data = requestSchema.parse(input);
  return transaction(pool, async (db) => {
    // One admission lock serializes global/account/target limits and idempotency.
    await db.query('SELECT pg_advisory_xact_lock(42120701)');
    await owner(db, actor, workspaceId);
    const prior = (
      await db.query(
        'SELECT id,kind,project_id FROM free_tests WHERE user_id=$1 AND request_id=$2',
        [actor.id, data.requestId],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.kind !== data.kind ||
        prior.project_id !== (data.kind === 'homepage' ? data.projectId : null)
      )
        throw new AppError(
          'REQUEST_CONFLICT',
          'This request identity already belongs to another test.',
          409,
        );
      return { id: prior.id as string };
    }
    const service = await runtime(db);
    if (!enabled || !service?.ready)
      throw new AppError(
        'RUNNER_UNAVAILABLE',
        'The test runner is offline. Your projects are saved; try again when it is available.',
        503,
      );
    let target = {
      url: 'https://preview.example.com/',
      origin: 'https://preview.example.com',
      addresses: ['127.0.0.1'],
    };
    let environment = 'preview';
    if (data.kind === 'homepage') {
      const project = (
        await db.query('SELECT * FROM projects WHERE id=$1 AND workspace_id=$2', [
          data.projectId,
          workspaceId,
        ])
      ).rows[0];
      if (!project) throw new AppError('NOT_FOUND', 'Project not found in this workspace.', 404);
      if (!service.allowed_origins.includes(project.authorized_origin))
        throw new AppError(
          'TARGET_NOT_ENABLED',
          'Testing for this origin has not been enabled yet. Try the prepared sample.',
          409,
        );
      target = {
        url: project.target_url,
        origin: project.authorized_origin,
        addresses: project.admission_addresses,
      };
      environment = project.environment;
    }
    const counts = (
      await db.query(
        `SELECT
      count(*) FILTER (WHERE phase IN ${active} AND user_id=$1)::integer AS account_active,
      count(*) FILTER (WHERE created_at>=${utcDay} AND user_id=$1)::integer AS account_daily,
      count(*) FILTER (WHERE created_at>=${utcDay})::integer AS global_daily,
      count(*) FILTER (WHERE phase IN ${active})::integer AS queued,
      count(*) FILTER (WHERE created_at>=${utcDay} AND kind='homepage' AND target->>'origin'=$2)::integer AS origin_daily
      FROM free_tests WHERE created_at>=${utcDay} OR phase IN ${active}`,
        [actor.id, target.origin],
      )
    ).rows[0];
    if (counts.account_active)
      throw new AppError(
        'TEST_ACTIVE',
        'Wait for your active test to finish or cancel it first.',
        409,
      );
    if (counts.account_daily >= freeTestLimits.perAccount)
      throw new AppError(
        'DAILY_TEST_LIMIT',
        'Your three free test requests are used. The allowance resets at midnight UTC.',
        429,
      );
    if (
      counts.global_daily >= freeTestLimits.globalDaily ||
      counts.queued >= freeTestLimits.queue ||
      (data.kind === 'homepage' && counts.origin_daily >= freeTestLimits.perOrigin)
    )
      throw new AppError(
        'TEST_CAPACITY',
        'The beta testing limit has been reached. Please try again later.',
        429,
      );
    const row = (
      await db.query(
        `INSERT INTO free_tests (user_id,workspace_id,project_id,request_id,kind,target,environment,container_prefix) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          actor.id,
          workspaceId,
          data.kind === 'homepage' ? data.projectId : null,
          data.requestId,
          data.kind,
          JSON.stringify(target),
          environment,
          `trialoom-run-${randomBytes(12).toString('hex')}`,
        ],
      )
    ).rows[0];
    await audit(db, workspaceId, actor.id, 'free_test.requested', row.id);
    return { id: row.id as string };
  });
}
export async function cancelFreeTest(pool: Pool, actor: Actor, workspaceId: string, id: string) {
  z.uuid().parse(id);
  return transaction(pool, async (db) => {
    await owner(db, actor, workspaceId);
    const changed = await db.query(
      `UPDATE free_tests SET cancel_requested=true,
      phase=CASE WHEN phase='queued' THEN 'cancelled' ELSE phase END,
      cleanup_at=CASE WHEN phase='queued' THEN clock_timestamp() ELSE cleanup_at END
      WHERE id=$1 AND workspace_id=$2 AND phase IN ${active} RETURNING id`,
      [id, workspaceId],
    );
    if (
      !changed.rowCount &&
      !(
        await db.query('SELECT 1 FROM free_tests WHERE id=$1 AND workspace_id=$2', [
          id,
          workspaceId,
        ])
      ).rowCount
    )
      throw new AppError('NOT_FOUND', 'Test not found in this workspace.', 404);
    if (changed.rowCount) await audit(db, workspaceId, actor.id, 'free_test.cancel_requested', id);
    return { id };
  });
}
