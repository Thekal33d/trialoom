import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import { attemptSchema } from '../domain/schemas.ts';
import { canonicalJson } from '../domain/values.ts';
import { transaction } from './database.ts';
import type { Operator } from './operators.ts';

export type Outcome = 'correct' | 'incorrect' | 'false_report';
export type Grade = { outcome: Outcome; reason: string };
type Report = Record<string, unknown>;
// An operator must clear every active task for a service, never file a false
// report, and waste no more attempts than it passes.
const accuracyFloor = 0.5;

/**
 * Grades one seeded submission against its answer key. Graded fields must match
 * exactly. Asserting a defect that the key says is absent is a false report;
 * describing a real defect incorrectly is an accuracy failure.
 */
export function gradeSubmission(answerKey: unknown, report: Report): Grade {
  const graded = (answerKey as { gradedFields?: Report })?.gradedFields;
  if (!graded || typeof graded !== 'object') throw new Error('Task answer key is unusable');
  const claimsDefect = report.defectPresent === true;
  const defectExpected = graded.defectPresent === true;
  if (claimsDefect && !defectExpected)
    return {
      outcome: 'false_report',
      reason: 'Reported a defect the seeded build does not contain',
    };
  const wrong = Object.keys(graded).filter(
    (field) => canonicalJson(report[field] ?? null) !== canonicalJson(graded[field] ?? null),
  );
  if (!wrong.length) return { outcome: 'correct', reason: 'All graded fields matched' };
  if (defectExpected && !claimsDefect)
    return { outcome: 'incorrect', reason: 'Missed the seeded defect' };
  return {
    outcome: 'incorrect',
    reason: `Graded fields did not match: ${wrong.sort().join(', ')}`,
  };
}

export async function recomputeEligibility(db: PoolClient, operatorId: string, service: string) {
  const totals = (
    await db.query<{
      tasks_total: string;
      tasks_passed: string;
      attempts: string;
      correct: string;
      false_reports: string;
    }>(
      `WITH active AS (SELECT id FROM qualification_tasks WHERE service=$2 AND active),
      mine AS (SELECT a.* FROM qualification_attempts a JOIN active ON active.id=a.task_id WHERE a.operator_id=$1)
      SELECT (SELECT count(*) FROM active) AS tasks_total,
        (SELECT count(DISTINCT task_id) FROM mine WHERE outcome='correct') AS tasks_passed,
        (SELECT count(*) FROM mine) AS attempts,
        (SELECT count(*) FROM mine WHERE outcome='correct') AS correct,
        (SELECT count(*) FROM mine WHERE outcome='false_report') AS false_reports`,
      [operatorId, service],
    )
  ).rows[0];
  const counts = {
    tasksTotal: Number(totals.tasks_total),
    tasksPassed: Number(totals.tasks_passed),
    attempts: Number(totals.attempts),
    correct: Number(totals.correct),
    falseReports: Number(totals.false_reports),
  };
  let reason = 'qualified';
  if (counts.falseReports > 0) reason = 'false_report';
  else if (!counts.tasksTotal || counts.tasksPassed < counts.tasksTotal) reason = 'incomplete';
  else if (counts.correct / counts.attempts < accuracyFloor) reason = 'accuracy_below_threshold';
  const state = reason === 'qualified' ? 'eligible' : 'ineligible';
  await db.query(
    `INSERT INTO operator_eligibility
    (operator_id,service,state,reason,tasks_total,tasks_passed,attempts,correct,false_reports,evaluated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())
    ON CONFLICT (operator_id,service) DO UPDATE SET state=EXCLUDED.state,reason=EXCLUDED.reason,
    tasks_total=EXCLUDED.tasks_total,tasks_passed=EXCLUDED.tasks_passed,attempts=EXCLUDED.attempts,
    correct=EXCLUDED.correct,false_reports=EXCLUDED.false_reports,evaluated_at=EXCLUDED.evaluated_at`,
    [
      operatorId,
      service,
      state,
      reason,
      counts.tasksTotal,
      counts.tasksPassed,
      counts.attempts,
      counts.correct,
      counts.falseReports,
    ],
  );
  return { service, state, reason, ...counts };
}

export async function qualificationStatus(pool: Pool, operatorId: string) {
  const tasks = (
    await pool.query(
      `SELECT t.slug,t.version,t.service,t.brief,t.max_attempts,
        count(a.id)::int AS attempts_used,
        bool_or(a.outcome='correct') AS passed,
        bool_or(a.outcome='false_report') AS false_reported
      FROM qualification_tasks t
      LEFT JOIN qualification_attempts a ON a.task_id=t.id AND a.operator_id=$1
      WHERE t.active GROUP BY t.id ORDER BY t.service,t.slug`,
      [operatorId],
    )
  ).rows;
  const eligibility = (
    await pool.query(
      'SELECT service,state,reason,tasks_total,tasks_passed,attempts,correct,false_reports FROM operator_eligibility WHERE operator_id=$1 ORDER BY service',
      [operatorId],
    )
  ).rows;
  // Answer keys stay server-side; only the brief and the operator's own history are returned.
  return { tasks, eligibility, accuracyFloor };
}

export async function recordAttempt(
  db: PoolClient,
  operator: Operator,
  credentialId: string | null,
  input: unknown,
) {
  const data = attemptSchema.parse(input);
  const task = (
    await db.query('SELECT * FROM qualification_tasks WHERE slug=$1 AND active', [data.task])
  ).rows[0];
  if (!task)
    throw new AppError('TASK_NOT_FOUND', 'No active qualification task has that slug.', 404);
  const expected: string[] = task.brief.reportFields ?? [];
  const supplied = Object.keys(data.report);
  const missing = expected.filter((field) => !supplied.includes(field));
  const unexpected = supplied.filter((field) => !expected.includes(field));
  if (missing.length || unexpected.length)
    throw new AppError(
      'REPORT_FIELDS_INVALID',
      `Report exactly these fields: ${expected.join(', ')}.${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}${unexpected.length ? ` Unexpected: ${unexpected.join(', ')}.` : ''}`,
    );
  // Serialize this operator's attempts on this task so concurrent submissions
  // cannot exceed the limit or collide on an attempt number.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `qualification:${operator.id}:${task.id}`,
  ]);
  const used = (
    await db.query<{ attempt_number: number }>(
      'SELECT attempt_number FROM qualification_attempts WHERE operator_id=$1 AND task_id=$2 ORDER BY attempt_number DESC',
      [operator.id, task.id],
    )
  ).rows;
  if (used.length >= task.max_attempts)
    throw new AppError(
      'ATTEMPTS_EXHAUSTED',
      `This task allows ${task.max_attempts} attempts. Ask for a review to reset it.`,
      409,
    );
  const grade = gradeSubmission(task.answer_key, data.report);
  const { rows } = await db.query(
    `INSERT INTO qualification_attempts
    (operator_id,task_id,credential_id,attempt_number,submission,outcome,reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,attempt_number,outcome,reason,submitted_at`,
    [
      operator.id,
      task.id,
      credentialId,
      (used[0]?.attempt_number ?? 0) + 1,
      JSON.stringify({ task: data.task, taskVersion: task.version, report: data.report }),
      grade.outcome,
      grade.reason,
    ],
  );
  const eligibility = await recomputeEligibility(db, operator.id, task.service);
  return {
    attempt: rows[0],
    attemptsRemaining: task.max_attempts - used.length - 1,
    eligibility,
  };
}

export async function submitAttempt(pool: Pool, operator: Operator, input: unknown) {
  return transaction(pool, (db) => recordAttempt(db, operator, null, input));
}
