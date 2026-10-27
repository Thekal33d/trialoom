import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import {
  appealResolutionSchema,
  appealSchema,
  discoveryDecisionSchema,
  duplicateDecisionSchema,
  executionDecisionSchema,
  severityDecisionSchema,
  uuid,
} from '../domain/schemas.ts';
import { type Actor, audit, requireRole } from './access.ts';
import type { AgentSession } from './agents.ts';
import { transaction } from './database.ts';
import {
  acceptedByAssignment,
  type Breakdown,
  feeFor,
  lockAccount,
  outstandingCommitment,
  reclassifyToAccepted,
  releaseCommitment,
  type TermsDocument,
} from './ledger.ts';

/** An operator has seven days to appeal, and the refused amount stays reserved. */
export const appealWindowHours = 168;

type Subject = { type: 'submission' | 'finding'; id: string };
type Posted = {
  matter: string;
  outcome: string;
  criteria: string;
  reason: string;
  evidenceRefs: string[];
  amount?: bigint;
  appealable: boolean;
};

async function decisionContext(
  db: PoolClient,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  assignmentId: string,
  roles: ('owner' | 'reviewer' | 'member')[] = ['owner', 'reviewer'],
) {
  const role = await requireRole(db, actor, workspaceId, roles);
  const assignment = (
    await db.query(
      `SELECT a.* FROM assignments a JOIN projects p ON p.id=a.project_id
      WHERE a.id=$1 AND a.project_id=$2 AND p.workspace_id=$3 FOR UPDATE OF a`,
      [assignmentId, projectId, workspaceId],
    )
  ).rows[0];
  if (!assignment) throw new AppError('NOT_FOUND', 'Assignment not found.', 404);
  const terms = (
    await db.query<{
      document: TermsDocument & { acceptanceCriteria: string; rewardRubric: string };
    }>('SELECT document FROM terms_versions WHERE id=$1', [assignment.terms_version_id])
  ).rows[0].document;
  const submission = (
    await db.query('SELECT id,outcome FROM evidence_submissions WHERE assignment_id=$1', [
      assignment.id,
    ])
  ).rows[0];
  return { role: role as 'owner' | 'reviewer', assignment, terms, submission };
}

/**
 * Writes one decision and moves exactly the money it authorizes. The fee is
 * charged on the running payout total, so two separate acceptances on one
 * assignment can never exceed the single fee its claim reserved.
 */
async function post(
  db: PoolClient,
  actor: Actor,
  role: 'owner' | 'reviewer' | 'operator',
  campaignId: string,
  assignmentId: string,
  subject: Subject,
  posted: Posted,
  bps: bigint,
  category: 'execution' | 'discovery' | null,
) {
  // The decision is written first, so a second decision on a settled matter is
  // refused by its unique index before any money moves.
  const { rows } = await db.query<{ id: string; created_at: string }>(
    `INSERT INTO decisions (campaign_id,assignment_id,subject_type,subject_id,matter,outcome,
    criteria,reason,evidence_refs,amount_units,actor_id,actor_role,appeal_deadline)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,created_at`,
    [
      campaignId,
      assignmentId,
      subject.type,
      subject.id,
      posted.matter,
      posted.outcome,
      posted.criteria,
      posted.reason,
      JSON.stringify(posted.evidenceRefs),
      posted.amount === undefined ? null : posted.amount.toString(),
      actor.id,
      role,
      posted.appealable ? new Date(Date.now() + appealWindowHours * 3_600_000).toISOString() : null,
    ],
  );
  let moved = 0n;
  if (posted.amount && posted.amount > 0n && category) {
    await lockAccount(db, campaignId);
    const already = await acceptedByAssignment(db, assignmentId);
    const payoutBefore = already.execution + already.discovery;
    // The fee is charged on the running payout, not on each award, so two
    // acceptances never round past the one fee the claim reserved.
    const feeDue = feeFor(payoutBefore + posted.amount, bps) - already.fee;
    const take: Partial<Breakdown> = { [category]: posted.amount, fee: feeDue };
    moved = await reclassifyToAccepted(
      db,
      campaignId,
      assignmentId,
      take,
      `${posted.matter} ${posted.outcome}`,
      actor.id,
      { releaseRemainder: false },
    );
  }
  // Base units cross the API as strings; a BigInt has no JSON form.
  return { decisionId: rows[0].id, createdAt: rows[0].created_at, movedUnits: moved.toString() };
}

/** References must point at this assignment's own evidence, not anywhere else. */
async function checkEvidenceRefs(db: PoolClient, assignmentId: string, refs: string[]) {
  if (!refs.length) return;
  const { rows } = await db.query<{ id: string }>(
    `SELECT a.id FROM evidence_artifacts a JOIN runs r ON r.id=a.run_id
      WHERE r.assignment_id=$1 AND a.id = ANY($2::uuid[])
    UNION SELECT s.id FROM evidence_submissions s WHERE s.assignment_id=$1 AND s.id = ANY($2::uuid[])
    UNION SELECT f.id FROM findings f WHERE f.assignment_id=$1 AND f.id = ANY($2::uuid[])`,
    [assignmentId, refs],
  );
  const known = new Set(rows.map((row) => row.id));
  const stray = refs.filter((ref) => !known.has(ref));
  if (stray.length)
    throw new AppError(
      'EVIDENCE_REF_UNKNOWN',
      `These references do not belong to this assignment: ${stray.join(', ')}.`,
    );
}

/** Keeps the assignment row equal to what the ledger says it has earned. */
async function syncAssignment(db: PoolClient, assignmentId: string) {
  const accepted = await acceptedByAssignment(db, assignmentId);
  const owed = accepted.execution + accepted.discovery + accepted.fee + accepted.resource;
  await db.query(
    `UPDATE assignments SET state=$2,closed_at=COALESCE(closed_at,clock_timestamp()),
    closed_reason=$3,accepted_units=$4,decided_at=COALESCE(decided_at,clock_timestamp())
    WHERE id=$1`,
    [
      assignmentId,
      owed > 0n ? 'accepted' : 'rejected',
      owed > 0n ? 'Decision recorded; amount owed' : 'Decision recorded; nothing accepted',
      owed > 0n ? owed.toString() : null,
    ],
  );
  return owed;
}

/**
 * Schedules the release of what is left once nothing is still to be decided.
 * A refusal keeps its reservation while it can still be appealed, so an appeal
 * resolved in the operator's favour still has the funds to pay.
 */
async function settleIfComplete(db: PoolClient, assignmentId: string) {
  const matters = (
    await db.query<{ matter: string; outcome: string }>(
      `SELECT matter,outcome FROM decisions WHERE assignment_id=$1 AND matter IN ('execution','discovery')`,
      [assignmentId],
    )
  ).rows;
  const execution = matters.find((row) => row.matter === 'execution');
  if (!execution) return;
  const finding = (
    await db.query<{ id: string }>('SELECT id FROM findings WHERE assignment_id=$1', [assignmentId])
  ).rows[0];
  const discovery = matters.find((row) => row.matter === 'discovery');
  if (finding && !discovery) return;
  const refused = [execution, discovery].some(
    (row) => row && ['rejected', 'declined'].includes(row.outcome),
  );
  await db.query(
    `UPDATE assignments SET release_after=clock_timestamp()+make_interval(hours=>$2) WHERE id=$1`,
    [assignmentId, refused ? appealWindowHours : 0],
  );
}

export async function decideExecution(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  assignmentId: string,
  input: unknown,
) {
  const data = executionDecisionSchema.parse(input);
  const id = uuid.parse(assignmentId);
  return transaction(pool, async (db) => {
    const { role, assignment, terms, submission } = await decisionContext(
      db,
      actor,
      workspaceId,
      projectId,
      id,
    );
    if (!submission)
      throw new AppError(
        'NO_SUBMISSION',
        'This assignment has no submitted evidence to decide on.',
        409,
      );
    await checkEvidenceRefs(db, id, data.evidenceRefs);
    const price = BigInt(terms.priceUnits);
    const amount = data.outcome === 'accepted' ? BigInt(data.amountUnits ?? terms.priceUnits) : 0n;
    if (amount > price)
      throw new AppError(
        'EXCEEDS_TERMS',
        `These terms price execution at ${price} base units.`,
        409,
      );
    if (data.outcome === 'accepted' && amount <= 0n)
      throw new AppError('AMOUNT_INVALID', 'An accepted execution pays a positive amount.');
    let result: Awaited<ReturnType<typeof post>>;
    try {
      result = await post(
        db,
        actor,
        role,
        assignment.campaign_id,
        id,
        { type: 'submission', id: submission.id },
        {
          matter: 'execution',
          outcome: data.outcome,
          // The criteria applied are the ones the claim pinned, not today's.
          criteria: terms.acceptanceCriteria,
          reason: data.reason,
          evidenceRefs: data.evidenceRefs,
          amount,
          appealable: data.outcome === 'rejected',
        },
        BigInt(terms.platformFeeBps),
        'execution',
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError(
          'ALREADY_DECIDED',
          'This assignment already has an execution decision. Resolve an appeal to change it.',
          409,
        );
      throw error;
    }
    await syncAssignment(db, id);
    await settleIfComplete(db, id);
    await audit(db, workspaceId, actor.id, `decision.execution_${data.outcome}`, id);
    return { ...result, assignmentId: id, matter: 'execution', outcome: data.outcome };
  });
}

export async function decideDiscovery(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  findingId: string,
  input: unknown,
) {
  const data = discoveryDecisionSchema.parse(input);
  const id = uuid.parse(findingId);
  return transaction(pool, async (db) => {
    const finding = (await db.query('SELECT * FROM findings WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!finding) throw new AppError('NOT_FOUND', 'Finding not found.', 404);
    const { role, assignment, terms } = await decisionContext(
      db,
      actor,
      workspaceId,
      projectId,
      finding.assignment_id,
    );
    await checkEvidenceRefs(db, assignment.id, data.evidenceRefs);
    if (finding.match === 'uncertain')
      throw new AppError(
        'DUPLICATE_UNDECIDED',
        'Record a duplicate decision for this report before awarding a discovery reward.',
        409,
      );
    const cap = BigInt(terms.discoveryRewardCapUnits);
    const amount = data.outcome === 'awarded' ? BigInt(data.amountUnits ?? cap) : 0n;
    if (amount > cap)
      throw new AppError(
        'EXCEEDS_TERMS',
        `These terms cap the discovery reward at ${cap} base units.`,
        409,
      );
    if (data.outcome === 'awarded') {
      if (amount <= 0n)
        throw new AppError('AMOUNT_INVALID', 'An awarded discovery pays a positive amount.');
      const defect = (
        await db.query('SELECT * FROM defects WHERE id=$1 FOR UPDATE', [finding.defect_id])
      ).rows[0];
      // The first complete valid report of a defect earns its discovery reward,
      // and only that one, however many reports follow.
      if (defect.awarded_finding_id && defect.awarded_finding_id !== id)
        throw new AppError(
          'DISCOVERY_ALREADY_AWARDED',
          'The discovery reward for this defect is already awarded to the earlier report. A later report can still be paid for its execution.',
          409,
        );
      const earliest = (
        await db.query<{ id: string }>(
          'SELECT id FROM findings WHERE defect_id=$1 ORDER BY created_at,id LIMIT 1',
          [finding.defect_id],
        )
      ).rows[0];
      if (earliest.id !== id)
        throw new AppError(
          'NOT_FIRST_REPORT',
          'An earlier report of this defect exists. Decide that one first; a later report earns no discovery reward.',
          409,
        );
    }
    let result: Awaited<ReturnType<typeof post>>;
    try {
      result = await post(
        db,
        actor,
        role,
        assignment.campaign_id,
        assignment.id,
        { type: 'finding', id },
        {
          matter: 'discovery',
          outcome: data.outcome,
          criteria: terms.rewardRubric,
          reason: data.reason,
          evidenceRefs: data.evidenceRefs,
          amount,
          appealable: data.outcome === 'declined',
        },
        BigInt(terms.platformFeeBps),
        'discovery',
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError(
          'ALREADY_DECIDED',
          'This finding already has a discovery decision.',
          409,
        );
      throw error;
    }
    await db.query(`UPDATE findings SET state=$2 WHERE id=$1`, [
      id,
      data.outcome === 'awarded' ? 'confirmed' : 'inconclusive',
    ]);
    if (data.outcome === 'awarded')
      await db.query('UPDATE defects SET awarded_finding_id=$2 WHERE id=$1', [
        finding.defect_id,
        id,
      ]);
    if (data.severity)
      await db.query('UPDATE defects SET severity=$2 WHERE id=$1', [
        finding.defect_id,
        data.severity,
      ]);
    await syncAssignment(db, assignment.id);
    await settleIfComplete(db, assignment.id);
    await audit(db, workspaceId, actor.id, `decision.discovery_${data.outcome}`, id);
    return { ...result, findingId: id, matter: 'discovery', outcome: data.outcome };
  });
}

/** Grouping a report into a defect, or keeping it apart, is a recorded call. */
export async function decideDuplicate(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  findingId: string,
  input: unknown,
) {
  const data = duplicateDecisionSchema.parse(input);
  const id = uuid.parse(findingId);
  return transaction(pool, async (db) => {
    const finding = (await db.query('SELECT * FROM findings WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!finding) throw new AppError('NOT_FOUND', 'Finding not found.', 404);
    const { role, assignment, terms } = await decisionContext(
      db,
      actor,
      workspaceId,
      projectId,
      finding.assignment_id,
    );
    await checkEvidenceRefs(db, assignment.id, data.evidenceRefs);
    let defectId = data.defectId;
    if (defectId) {
      const candidates = (finding.candidate_defect_ids as string[]) ?? [];
      if (finding.defect_id !== defectId && !candidates.includes(defectId))
        throw new AppError(
          'DEFECT_NOT_CANDIDATE',
          'That defect is not one of this report’s candidates.',
          409,
        );
    } else if (!finding.defect_id) {
      defectId = (
        await db.query<{ id: string }>(
          `INSERT INTO defects (project_id,build_id,signature_hash,title,state)
          VALUES ($1,$2,$3,$4,'unconfirmed') RETURNING id`,
          [finding.project_id, finding.build_id, finding.signature_hash, finding.title],
        )
      ).rows[0].id;
    } else defectId = finding.defect_id;
    await db.query(
      `UPDATE findings SET defect_id=$2,match=CASE WHEN match='uncertain' THEN 'exact' ELSE match END,
      state=$3 WHERE id=$1`,
      [id, defectId, defectId === finding.defect_id ? finding.state : 'duplicate'],
    );
    // The review flag is answered now, so it stops asking.
    await db.query('UPDATE defects SET review_flag=NULL WHERE id=$1', [defectId]);
    const result = await post(
      db,
      actor,
      role,
      assignment.campaign_id,
      assignment.id,
      { type: 'finding', id },
      {
        matter: 'duplicate',
        outcome: 'duplicate',
        criteria: terms.rewardRubric,
        reason: data.reason,
        evidenceRefs: data.evidenceRefs,
        appealable: false,
      },
      BigInt(terms.platformFeeBps),
      null,
    );
    await audit(db, workspaceId, actor.id, 'decision.duplicate', id);
    return { ...result, findingId: id, defectId, matter: 'duplicate' };
  });
}

export async function decideSeverity(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  findingId: string,
  input: unknown,
) {
  const data = severityDecisionSchema.parse(input);
  const id = uuid.parse(findingId);
  return transaction(pool, async (db) => {
    const finding = (await db.query('SELECT * FROM findings WHERE id=$1', [id])).rows[0];
    if (!finding) throw new AppError('NOT_FOUND', 'Finding not found.', 404);
    if (!finding.defect_id)
      throw new AppError(
        'DUPLICATE_UNDECIDED',
        'Group this report into a defect before setting its severity.',
        409,
      );
    const { role, assignment, terms } = await decisionContext(
      db,
      actor,
      workspaceId,
      projectId,
      finding.assignment_id,
    );
    await checkEvidenceRefs(db, assignment.id, data.evidenceRefs);
    await db.query('UPDATE defects SET severity=$2 WHERE id=$1', [
      finding.defect_id,
      data.severity,
    ]);
    const result = await post(
      db,
      actor,
      role,
      assignment.campaign_id,
      assignment.id,
      { type: 'finding', id },
      {
        matter: 'severity',
        outcome: 'changed',
        criteria: terms.rewardRubric,
        reason: data.reason,
        evidenceRefs: data.evidenceRefs,
        appealable: false,
      },
      BigInt(terms.platformFeeBps),
      null,
    );
    await audit(db, workspaceId, actor.id, 'decision.severity_changed', id);
    return { ...result, findingId: id, severity: data.severity, matter: 'severity' };
  });
}

/**
 * An operator appeals a refusal from their own agent session. The refused
 * amount stays reserved while the appeal is open, so a resolution can still
 * pay it.
 */
export async function openAppeal(
  pool: Pool,
  session: AgentSession,
  assignmentId: string,
  input: unknown,
) {
  const data = appealSchema.parse(input);
  const id = uuid.parse(assignmentId);
  return transaction(pool, async (db) => {
    const assignment = (
      await db.query('SELECT * FROM assignments WHERE id=$1 AND operator_id=$2 FOR UPDATE', [
        id,
        session.operator.id,
      ])
    ).rows[0];
    if (!assignment) throw new AppError('NOT_FOUND', 'Assignment not found.', 404);
    const matter = data.subject === 'execution' ? 'execution' : 'discovery';
    const decision = (
      await db.query(
        `SELECT * FROM decisions WHERE assignment_id=$1 AND matter=$2
        ORDER BY created_at DESC LIMIT 1`,
        [id, matter],
      )
    ).rows[0];
    if (!decision)
      throw new AppError('NOT_DECIDED', `No ${matter} decision has been recorded yet.`, 409);
    if (!['rejected', 'declined'].includes(decision.outcome))
      throw new AppError('NOT_REFUSED', `That ${matter} decision was not a refusal.`, 409);
    if (decision.appeal_deadline && new Date(decision.appeal_deadline) <= new Date())
      throw new AppError(
        'APPEAL_WINDOW_CLOSED',
        'The appeal window for that decision has closed.',
        409,
      );
    const subject = (
      await db.query<{ id: string }>(
        data.subject === 'execution'
          ? 'SELECT id FROM evidence_submissions WHERE assignment_id=$1'
          : 'SELECT id FROM findings WHERE assignment_id=$1',
        [id],
      )
    ).rows[0];
    let posted: Awaited<ReturnType<typeof post>>;
    try {
      posted = await post(
        db,
        { id: session.userId, email: '', name: session.operator.handle },
        'operator',
        assignment.campaign_id,
        id,
        { type: data.subject === 'execution' ? 'submission' : 'finding', id: subject.id },
        {
          matter: 'appeal',
          outcome: 'opened',
          criteria: decision.criteria,
          reason: data.reason,
          evidenceRefs: [],
          appealable: false,
        },
        0n,
        null,
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError('APPEAL_OPEN', 'An appeal is already open for this assignment.', 409);
      throw error;
    }
    // The reservation is held until the appeal is resolved.
    await db.query('UPDATE assignments SET release_after=NULL WHERE id=$1', [id]);
    return { ...posted, assignmentId: id, subject: data.subject, state: 'open' };
  });
}

export async function resolveAppeal(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  assignmentId: string,
  input: unknown,
) {
  const data = appealResolutionSchema.parse(input);
  const id = uuid.parse(assignmentId);
  return transaction(pool, async (db) => {
    const { role, assignment, terms } = await decisionContext(
      db,
      actor,
      workspaceId,
      projectId,
      id,
    );
    const appeal = (
      await db.query(
        `SELECT * FROM decisions WHERE assignment_id=$1 AND matter='appeal' AND outcome='opened'`,
        [id],
      )
    ).rows[0];
    if (!appeal) throw new AppError('NO_APPEAL', 'No appeal is open for this assignment.', 409);
    await checkEvidenceRefs(db, id, data.evidenceRefs);
    const category = appeal.subject_type === 'submission' ? 'execution' : 'discovery';
    const cap =
      category === 'execution' ? BigInt(terms.priceUnits) : BigInt(terms.discoveryRewardCapUnits);
    const amount = data.outcome === 'overturned' ? BigInt(data.amountUnits ?? cap.toString()) : 0n;
    if (amount > cap)
      throw new AppError('EXCEEDS_TERMS', `These terms cap that amount at ${cap} base units.`, 409);
    if (data.outcome === 'overturned' && amount <= 0n)
      throw new AppError('AMOUNT_INVALID', 'An overturned refusal pays a positive amount.');
    const result = await post(
      db,
      actor,
      role,
      assignment.campaign_id,
      id,
      { type: appeal.subject_type, id: appeal.subject_id },
      {
        matter: 'appeal',
        outcome: data.outcome,
        criteria: appeal.criteria,
        reason: data.reason,
        evidenceRefs: data.evidenceRefs,
        amount,
        appealable: false,
      },
      BigInt(terms.platformFeeBps),
      category,
    );
    await syncAssignment(db, id);
    await db.query('UPDATE assignments SET release_after=clock_timestamp() WHERE id=$1', [id]);
    await audit(db, workspaceId, actor.id, `decision.appeal_${data.outcome}`, id);
    return { ...result, assignmentId: id, matter: 'appeal', outcome: data.outcome };
  });
}

/**
 * Releases what a settled assignment no longer holds, once its appeal window
 * has closed. An open appeal clears the schedule, so nothing is freed while it
 * can still be paid.
 */
export async function releaseSettledAssignments(pool: Pool) {
  return transaction(pool, async (db) => {
    const { rows } = await db.query<{ id: string; campaign_id: string }>(
      `SELECT id,campaign_id FROM assignments
      WHERE release_after IS NOT NULL AND release_after<=clock_timestamp()
        AND state IN ('accepted','rejected') FOR UPDATE SKIP LOCKED LIMIT 50`,
      [],
    );
    let released = 0n;
    for (const row of rows) {
      await lockAccount(db, row.campaign_id);
      const held = await outstandingCommitment(db, row.id);
      if (held.execution + held.discovery + held.resource + held.fee > 0n)
        released += await releaseCommitment(
          db,
          row.campaign_id,
          row.id,
          'Decision settled; appeal window closed',
          null,
        );
      await db.query('UPDATE assignments SET release_after=NULL WHERE id=$1', [row.id]);
    }
    return { assignments: rows.length, releasedUnits: released.toString() };
  });
}

export async function campaignDecisions(db: Pool | PoolClient, campaignId: string) {
  const { rows } = await db.query(
    `SELECT d.id,d.subject_type,d.subject_id,d.matter,d.outcome,d.criteria,d.reason,
      d.evidence_refs,d.amount_units,d.actor_role,d.appeal_deadline,d.created_at,
      d.assignment_id,u.name AS actor_name
    FROM decisions d JOIN auth_user u ON u.id=d.actor_id
    WHERE d.campaign_id=$1 ORDER BY d.created_at DESC LIMIT 100`,
    [campaignId],
  );
  return rows;
}

export async function operatorDecisions(pool: Pool, operatorId: string) {
  const { rows } = await pool.query(
    `SELECT d.id,d.assignment_id,d.subject_type,d.matter,d.outcome,d.reason,d.criteria,
      d.amount_units,d.appeal_deadline,d.created_at,c.name AS campaign,a.state AS assignment_state
    FROM decisions d JOIN assignments a ON a.id=d.assignment_id
    JOIN campaigns c ON c.id=d.campaign_id
    WHERE a.operator_id=$1 ORDER BY d.created_at DESC LIMIT 100`,
    [operatorId],
  );
  return { decisions: rows, appealWindowHours };
}
