import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { EvidenceInput } from '../domain/schemas.ts';
import { canonicalJson } from '../domain/values.ts';

/**
 * Clustering is deterministic and decides nothing. The same failure signature
 * on the same build is the same defect; anything less certain is recorded as a
 * candidate and sent to review, because only a recorded decision may group,
 * reward, or reject a report.
 */
const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

export type Signature = {
  buildId: string;
  assertions: string[];
  steps: { action: string; expected: string; actual: string }[];
};

/** The failure a report describes: which assertions failed and how. */
export function failureSignature(document: EvidenceInput): Signature {
  return {
    buildId: document.build.id,
    assertions: document.assertions
      .filter((assertion) => !assertion.passed)
      .map((assertion) => normalize(assertion.name))
      .sort(),
    steps: document.steps
      .filter((step) => step.status === 'failed')
      .map((step) => ({
        action: normalize(step.action),
        expected: normalize(step.expected),
        actual: normalize(step.actual),
      }))
      .sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : 1)),
  };
}
export const signatureHash = (signature: Signature) =>
  createHash('sha256').update(canonicalJson(signature)).digest('hex');

/**
 * Two operators are linked when they are the same identity, belong to the same
 * account, or have ever proven the same payout wallet. A linked operator cannot
 * independently reproduce the other's finding (FR11).
 */
export async function operatorLink(
  db: PoolClient,
  operatorId: string,
  otherId: string,
): Promise<string | null> {
  if (operatorId === otherId) return 'The same operator reported this defect.';
  const shared = await db.query(
    `SELECT o.user_id=p.user_id AS same_account,
      EXISTS (SELECT 1 FROM operator_wallets a JOIN operator_wallets b
        ON a.chain_id=b.chain_id AND lower(a.address)=lower(b.address)
        WHERE a.operator_id=o.id AND b.operator_id=p.id) AS same_wallet
    FROM operators o, operators p WHERE o.id=$1 AND p.id=$2`,
    [operatorId, otherId],
  );
  const row = shared.rows[0];
  if (!row) return null;
  if (row.same_account) return 'Both operators belong to the same account.';
  // A revoked address still links the identities that proved it.
  if (row.same_wallet) return 'Both operators have proven the same payout wallet.';
  return null;
}

async function independenceOf(db: PoolClient, defectId: string, operatorId: string) {
  const { rows } = await db.query<{ operator_id: string }>(
    'SELECT DISTINCT operator_id FROM findings WHERE defect_id=$1',
    [defectId],
  );
  for (const row of rows) {
    const link = await operatorLink(db, operatorId, row.operator_id);
    if (link) return link;
  }
  return null;
}

type Context = {
  projectId: string;
  campaignId: string;
  assignmentId: string;
  submissionId: string;
  operatorId: string;
  buildId: string;
};

/**
 * Derives one finding from a reported product failure and clusters it.
 * An exact signature match joins the existing defect; a report whose failing
 * assertions match but whose detail does not is left unclustered and flagged
 * for review rather than guessed either way.
 */
export async function recordFinding(db: PoolClient, context: Context, document: EvidenceInput) {
  const signature = failureSignature(document);
  const hash = signatureHash(signature);
  const title = document.summary.slice(0, 200);
  const exact = (
    await db.query<{ id: string; state: string }>(
      'SELECT id,state FROM defects WHERE project_id=$1 AND build_id=$2 AND signature_hash=$3 FOR UPDATE',
      [context.projectId, context.buildId, hash],
    )
  ).rows[0];
  let defectId: string | null = null;
  let match: 'first' | 'exact' | 'uncertain' = 'first';
  let independent = true;
  let reason: string | null = null;
  let candidates: string[] = [];
  if (exact) {
    defectId = exact.id;
    match = 'exact';
    reason = await independenceOf(db, exact.id, context.operatorId);
    independent = reason === null;
  } else {
    // The same failing assertions with different detail may or may not be the
    // same defect. That is a judgement, so it goes to a reviewer.
    candidates = (
      await db.query<{ id: string }>(
        `SELECT DISTINCT d.id FROM defects d JOIN findings f ON f.defect_id=d.id
        WHERE d.project_id=$1 AND d.build_id=$2 AND d.signature_hash<>$3
          AND f.signature->'assertions'=$4::jsonb`,
        [context.projectId, context.buildId, hash, JSON.stringify(signature.assertions)],
      )
    ).rows.map((row) => row.id);
    if (candidates.length) match = 'uncertain';
    else {
      defectId = (
        await db.query<{ id: string }>(
          `INSERT INTO defects (project_id,build_id,signature_hash,title,state)
          VALUES ($1,$2,$3,$4,'unconfirmed') RETURNING id`,
          [context.projectId, context.buildId, hash, title],
        )
      ).rows[0].id;
    }
  }
  const finding = (
    await db.query<{ id: string }>(
      `INSERT INTO findings (defect_id,project_id,campaign_id,assignment_id,submission_id,
      operator_id,build_id,signature_hash,signature,title,proposed_severity,match,
      independent,independence_reason,state,candidate_defect_ids)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'submitted',$15) RETURNING id`,
      [
        defectId,
        context.projectId,
        context.campaignId,
        context.assignmentId,
        context.submissionId,
        context.operatorId,
        context.buildId,
        hash,
        JSON.stringify(signature),
        title,
        document.proposedSeverity ?? null,
        match,
        independent,
        reason,
        JSON.stringify(candidates),
      ],
    )
  ).rows[0];
  if (match === 'uncertain')
    await db.query(
      `UPDATE defects SET review_flag='uncertain_duplicate' WHERE id = ANY($1::uuid[])`,
      [candidates],
    );
  if (defectId) await refreshDefect(db, defectId);
  if (!independent)
    await db.query("UPDATE defects SET review_flag='independence_failed' WHERE id=$1", [defectId]);
  return { findingId: finding.id, defectId, match, independent, independenceReason: reason, hash };
}

/**
 * A defect is confirmed by two independent reports of the same failure, which
 * is what the PRD's two consistent replays mean here. Trialoom does not
 * re-execute anything: each report is its own operator's run.
 */
async function refreshDefect(db: PoolClient, defectId: string) {
  const { rows } = await db.query<{ independent: number }>(
    `SELECT count(*) FILTER (WHERE independent)::int AS independent
    FROM findings WHERE defect_id=$1`,
    [defectId],
  );
  if (rows[0].independent >= 2)
    await db.query("UPDATE defects SET state='confirmed' WHERE id=$1 AND state='unconfirmed'", [
      defectId,
    ]);
}

/**
 * A clean run of the same assertions on the same build contradicts a reported
 * failure. That inconsistency is marked and sent to review; it is not treated
 * as proof that the original report was false.
 */
export async function noteConsistentPass(
  db: PoolClient,
  projectId: string,
  buildId: string,
  document: EvidenceInput,
) {
  const passed = document.assertions
    .filter((assertion) => assertion.passed)
    .map((assertion) => normalize(assertion.name));
  if (!passed.length) return 0;
  const { rowCount } = await db.query(
    `UPDATE defects SET state='flaky',review_flag='inconsistent_result'
    WHERE project_id=$1 AND build_id=$2 AND state IN ('unconfirmed','confirmed')
      AND EXISTS (SELECT 1 FROM findings f WHERE f.defect_id=defects.id
        AND f.signature->'assertions' <@ $3::jsonb)`,
    [projectId, buildId, JSON.stringify(passed)],
  );
  return rowCount ?? 0;
}

export async function campaignFindings(db: Pool | PoolClient, campaignId: string) {
  const { rows } = await db.query(
    `SELECT f.id,f.defect_id,f.title,f.match,f.independent,f.independence_reason,f.state,
      f.proposed_severity,f.candidate_defect_ids,f.created_at,f.assignment_id,f.submission_id,
      o.handle,d.state AS defect_state,d.severity,d.review_flag,d.signature_hash,
      d.awarded_finding_id,
      (SELECT count(*)::int FROM findings s WHERE s.defect_id=f.defect_id) AS reports,
      (SELECT count(*)::int FROM findings s WHERE s.defect_id=f.defect_id AND s.independent)
        AS independent_reports
    FROM findings f JOIN operators o ON o.id=f.operator_id
    LEFT JOIN defects d ON d.id=f.defect_id
    WHERE f.campaign_id=$1 ORDER BY f.created_at DESC LIMIT 100`,
    [campaignId],
  );
  return rows;
}
