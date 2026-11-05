import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '../domain/errors.ts';
import { canonicalJson } from '../domain/values.ts';
import { type Actor, audit, requireRole } from './access.ts';
import { buyReportService, prepareBuyReport } from './buy-report.ts';
import { transaction } from './database.ts';

export const freeReportVersion = 'free-checks-v1';
const names = ['homepage', 'navigation', 'scope', 'infrastructure'] as const;
const resultSchema = z.object({
  schemaVersion: z.literal(1),
  outcome: z.enum(['completed', 'blocked']),
  checks: z
    .array(z.object({ check: z.enum(names), passed: z.boolean() }).strict())
    .min(3)
    .max(4),
});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Preserve recorded booleans; never infer HTTP codes, counts or a failure cause. */
export function projectFreeTestReport(kind: 'sample' | 'homepage', input: unknown) {
  const result = resultSchema.parse(input);
  const expected = names.filter((name) => kind === 'sample' || name !== 'navigation');
  if (
    result.checks.length !== expected.length ||
    expected.some((name) => result.checks.filter((check) => check.check === name).length !== 1)
  )
    throw new Error('FREE_REPORT_CHECKS_INVALID');
  const checks = expected.map((name) => {
    const check = result.checks.find((item) => item.check === name);
    if (!check) throw new Error('FREE_REPORT_CHECKS_INVALID');
    return { check: 'recorded_browser_check' as const, name, passed: check.passed };
  });
  const allPassed = checks.every((check) => check.passed);
  if (result.outcome === 'completed' && !allPassed) throw new Error('FREE_REPORT_OUTCOME_INVALID');
  return { observations: { steps: checks }, allPassed };
}

type Source = {
  id: string;
  user_id: string;
  workspace_id: string;
  kind: 'sample' | 'homepage';
  phase: string;
  cancel_requested: boolean;
  cleanup_at: Date | null;
  result: unknown;
  result_hash: string | null;
};
type InputRow = {
  id: string;
  status: 'prepared' | 'skipped';
  skip_reason: 'all_checks_passed' | null;
  result_hash: string;
  evidence_hash: string;
  request_hash: string | null;
  request_body: string | null;
  observations: unknown;
};
const summary = (row: InputRow) => ({
  id: row.id,
  status: row.status,
  skipReason: row.skip_reason,
  resultHash: row.result_hash,
  evidenceHash: row.evidence_hash,
  requestHash: row.request_hash,
});

async function prepare(db: PoolClient, source: Source) {
  if (
    !['completed', 'blocked'].includes(source.phase) ||
    source.cancel_requested ||
    !source.cleanup_at ||
    !source.result
  )
    throw new AppError('REPORT_NOT_READY', 'A finished test result is required.', 409);
  if (digest(canonicalJson(source.result)) !== source.result_hash)
    throw new Error('FREE_REPORT_SOURCE_CORRUPT');
  if (resultSchema.parse(source.result).outcome !== source.phase)
    throw new Error('FREE_REPORT_OUTCOME_INVALID');
  const projected = projectFreeTestReport(source.kind, source.result);
  const prepared = prepareBuyReport(projected.observations);
  const status = projected.allPassed ? 'skipped' : 'prepared';
  const body = projected.allPassed ? null : prepared.body;
  const bodyHash = projected.allPassed ? null : prepared.bodyHash;
  const existing = (
    await db.query<InputRow>(
      'SELECT * FROM buy_report_inputs WHERE free_test_id=$1 AND service=$2 AND template_version=$3',
      [source.id, buyReportService.id, freeReportVersion],
    )
  ).rows[0];
  if (existing) {
    if (
      existing.result_hash !== source.result_hash ||
      existing.evidence_hash !== prepared.evidenceHash ||
      canonicalJson(existing.observations) !== canonicalJson(projected.observations) ||
      existing.request_body !== body ||
      existing.request_hash !== bodyHash ||
      existing.status !== status
    )
      throw new Error('FREE_REPORT_BINDING_CHANGED');
    return summary(existing);
  }
  const row = (
    await db.query<InputRow>(
      `INSERT INTO buy_report_inputs
      (free_test_id,user_id,workspace_id,result_hash,service,template_version,status,skip_reason,observations,evidence_hash,request_body,request_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        source.id,
        source.user_id,
        source.workspace_id,
        source.result_hash,
        buyReportService.id,
        freeReportVersion,
        status,
        projected.allPassed ? 'all_checks_passed' : null,
        canonicalJson(projected.observations),
        prepared.evidenceHash,
        body,
        bodyHash,
      ],
    )
  ).rows[0];
  await audit(db, source.workspace_id, null, `free_report.${status}`, row.id);
  return summary(row);
}

/** Owner-scoped preparation, with no provider call or spending side effect. */
export async function prepareFreeTestReport(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  testId: string,
) {
  z.uuid().parse(testId);
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    const source = (
      await db.query<Source>(
        'SELECT * FROM free_tests WHERE id=$1 AND user_id=$2 AND workspace_id=$3 FOR UPDATE',
        [testId, actor.id, workspaceId],
      )
    ).rows[0];
    if (!source) throw new AppError('NOT_FOUND', 'Test not found in this workspace.', 404);
    return prepare(db, source);
  });
}

/** Trusted local worker: catches up after a restart without repeating a browser or provider call. */
export async function prepareNextFreeTestReport(pool: Pool) {
  return transaction(pool, async (db) => {
    const source = (
      await db.query<Source>(
        `SELECT f.* FROM free_tests f
        WHERE f.phase IN ('completed','blocked') AND NOT f.cancel_requested AND f.cleanup_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM buy_report_inputs r WHERE r.free_test_id=f.id AND r.service=$1 AND r.template_version=$2)
        ORDER BY f.created_at,f.id LIMIT 1 FOR UPDATE OF f SKIP LOCKED`,
        [buyReportService.id, freeReportVersion],
      )
    ).rows[0];
    if (!source) return null;
    // The selection's snapshot may predate a different worker's commit even
    // when its row lock has already been released. Recheck under the lock in
    // a fresh statement so this worker reports only work it actually prepared.
    const alreadyPrepared = await db.query(
      'SELECT 1 FROM buy_report_inputs WHERE free_test_id=$1 AND service=$2 AND template_version=$3',
      [source.id, buyReportService.id, freeReportVersion],
    );
    return alreadyPrepared.rowCount ? null : prepare(db, source);
  });
}
