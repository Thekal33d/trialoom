import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import {
  type EvidenceInput,
  quoteDecisionSchema,
  repairQuoteSchema,
  uuid,
} from '../domain/schemas.ts';
import { type Actor, audit, requireRole } from './access.ts';
import { transaction } from './database.ts';
import { operatorLink } from './findings.ts';

type Replays = { baseline: Replay[]; candidate: Replay[] };
type Replay = { assertion: string; passed: boolean; cleanSession: true };

/**
 * Proposes a repair against one confirmed defect, one base build, and the paths
 * it may change. A repair is quoted before it can ever be assigned, and the
 * quote is what a later delivery is measured against.
 */
export async function proposeQuote(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  input: unknown,
) {
  const data = repairQuoteSchema.parse(input);
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner', 'member']);
    const campaign = (
      await db.query(
        `SELECT c.id,c.status,c.latest_version,t.document FROM campaigns c
        JOIN projects p ON p.id=c.project_id
        LEFT JOIN terms_versions t ON t.campaign_id=c.id AND t.version=c.latest_version
        WHERE c.id=$1 AND c.project_id=$2 AND p.workspace_id=$3`,
        [data.campaignId, projectId, workspaceId],
      )
    ).rows[0];
    if (!campaign) throw new AppError('NOT_FOUND', 'Work brief not found.', 404);
    if (campaign.status !== 'draft')
      throw new AppError(
        'CAMPAIGN_CLOSED',
        'Quote the repair before the brief is published, so the approval comes first.',
        409,
      );
    if (campaign.document?.service !== 'repair')
      throw new AppError('SERVICE_MISMATCH', 'This brief is not a repair brief.', 409);
    const defect = (
      await db.query('SELECT id,state,repair_state FROM defects WHERE id=$1 AND project_id=$2', [
        data.defectId,
        projectId,
      ])
    ).rows[0];
    if (!defect) throw new AppError('NOT_FOUND', 'Defect not found in this project.', 404);
    // A repair is bought for a defect the builder has confirmed, not a guess.
    if (defect.state !== 'confirmed')
      throw new AppError(
        'DEFECT_UNCONFIRMED',
        `This defect is ${defect.state}. Confirm it before buying a repair for it.`,
        409,
      );
    if (
      !(
        await db.query(
          `SELECT 1 FROM operators o JOIN memberships m ON m.user_id=o.user_id
          WHERE o.id=$1 AND m.workspace_id=$2 AND m.role='operator'`,
          [data.operatorId, workspaceId],
        )
      ).rowCount
    )
      throw new AppError('NOT_ADMITTED', 'That operator is not admitted to this workspace.', 409);
    const build = (
      await db.query('SELECT revision FROM builds WHERE id=$1 AND project_id=$2', [
        data.baseBuildId,
        projectId,
      ])
    ).rows[0];
    if (!build) throw new AppError('BUILD_NOT_FOUND', 'Select a pinned build from this project.');
    let quote: { id: string };
    try {
      quote = (
        await db.query<{ id: string }>(
          `INSERT INTO repair_quotes (project_id,defect_id,campaign_id,operator_id,base_build_id,
          base_revision,amount_units,scope_paths,state,proposed_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'proposed',$9) RETURNING id`,
          [
            projectId,
            data.defectId,
            data.campaignId,
            data.operatorId,
            data.baseBuildId,
            build.revision,
            data.amountUnits,
            JSON.stringify([...new Set(data.scopePaths)].sort()),
            actor.id,
          ],
        )
      ).rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError('QUOTE_EXISTS', 'This brief already has a repair quote.', 409);
      throw error;
    }
    await audit(db, workspaceId, actor.id, 'repair.quoted', quote.id);
    return { quoteId: quote.id, state: 'proposed', baseRevision: build.revision as string };
  });
}

/** Only the workspace owner can approve spending, including on a repair. */
export async function decideQuote(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  quoteId: string,
  input: unknown,
) {
  const data = quoteDecisionSchema.parse(input);
  const id = uuid.parse(quoteId);
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    const quote = (
      await db.query('SELECT * FROM repair_quotes WHERE id=$1 AND project_id=$2 FOR UPDATE', [
        id,
        projectId,
      ])
    ).rows[0];
    if (!quote) throw new AppError('NOT_FOUND', 'Repair quote not found.', 404);
    if (quote.state !== 'proposed')
      throw new AppError('QUOTE_CLOSED', `This quote is already ${quote.state}.`, 409);
    await db.query(
      `UPDATE repair_quotes SET state=$2,decided_reason=$3,
      approved_by=CASE WHEN $2='approved' THEN $4 ELSE NULL END,
      approved_at=CASE WHEN $2='approved' THEN clock_timestamp() ELSE NULL END WHERE id=$1`,
      [id, data.outcome, data.reason, actor.id],
    );
    if (data.outcome === 'approved')
      await db.query(
        "UPDATE defects SET repair_state='quoted' WHERE id=$1 AND repair_state='none'",
        [quote.defect_id],
      );
    await audit(db, workspaceId, actor.id, `repair.quote_${data.outcome}`, id);
    return { quoteId: id, state: data.outcome, amountUnits: quote.amount_units as string };
  });
}

export async function approvedQuote(db: PoolClient | Pool, campaignId: string) {
  const { rows } = await db.query(
    "SELECT * FROM repair_quotes WHERE campaign_id=$1 AND state='approved'",
    [campaignId],
  );
  return rows[0] ?? null;
}

/**
 * In a repair brief the quoted operator delivers and anyone else verifies. The
 * first assignment is held for the author, so a verifier cannot take the slot
 * the repair itself needs.
 */
export async function repairRole(
  db: PoolClient,
  campaignId: string,
  operatorId: string,
): Promise<'author' | 'verifier'> {
  const quote = await approvedQuote(db, campaignId);
  if (!quote)
    throw new AppError('REPAIR_QUOTE_MISSING', 'This repair brief has no approved quote.', 409);
  if (quote.operator_id === operatorId) return 'author';
  if (
    !(
      await db.query('SELECT 1 FROM assignments WHERE campaign_id=$1 AND operator_id=$2', [
        campaignId,
        quote.operator_id,
      ])
    ).rowCount
  )
    throw new AppError(
      'REPAIR_AUTHOR_FIRST',
      'The quoted operator has not claimed this repair yet. Verification comes after a delivery.',
      409,
    );
  return 'verifier';
}

/**
 * Where an existing assignment stands in a repair brief, or null outside one.
 * Unlike `repairRole` this never refuses: it describes work already claimed.
 */
export async function repairPosition(
  db: PoolClient,
  campaignId: string,
  operatorId: string,
): Promise<'author' | 'verifier' | null> {
  const quote = await approvedQuote(db, campaignId);
  if (!quote) return null;
  return quote.operator_id === operatorId ? 'author' : 'verifier';
}

const consistent = (replays: Replay[], expected: boolean) =>
  replays.every((replay) => replay.passed === expected && replay.cleanSession === true);

/**
 * The repair gate. A regression test that also passes on the original revision
 * demonstrates nothing, so the evidence is refused and can be corrected rather
 * than recorded as a fix (R04).
 */
export function assessRegression(regression: Replays, defectAssertions: string[]) {
  if (!consistent(regression.baseline, false))
    throw new AppError(
      'REGRESSION_UNPROVEN',
      'Every clean replay on the original revision must fail. A test that also passes there demonstrates no regression fix.',
      409,
    );
  if (!consistent(regression.candidate, true))
    throw new AppError(
      'REGRESSION_UNPROVEN',
      'Every clean replay on the candidate revision must pass.',
      409,
    );
  const assertions = new Set(regression.baseline.map((replay) => replay.assertion));
  if (assertions.size !== 1)
    throw new AppError(
      'INCONSISTENT_REPLAYS',
      'The replays on the original revision exercised different assertions.',
      409,
    );
  const asserted = [...assertions][0];
  if (new Set(regression.candidate.map((replay) => replay.assertion)).has(asserted) === false)
    throw new AppError(
      'INCONSISTENT_REPLAYS',
      'The candidate replays did not exercise the assertion that failed on the original revision.',
      409,
    );
  // The baseline must fail for the defect being repaired, not for anything else.
  if (defectAssertions.length && !defectAssertions.includes(asserted.trim().toLowerCase()))
    throw new AppError(
      'UNRELATED_FAILURE',
      `The original revision failed on ${asserted}, which is not the failure this defect records.`,
      409,
    );
  return asserted;
}

type Context = {
  projectId: string;
  campaignId: string;
  assignmentId: string;
  submissionId: string;
  operatorId: string;
};

/** Records one delivered repair, measured against its approved quote. */
export async function recordRepair(db: PoolClient, context: Context, document: EvidenceInput) {
  const repair = document.repair;
  if (!repair)
    throw new AppError(
      'REPAIR_REQUIRED',
      'A repair delivery must report its base and candidate revisions, changed files, regression replays, and required checks.',
    );
  const quote = await approvedQuote(db, context.campaignId);
  if (!quote) throw new AppError('REPAIR_QUOTE_MISSING', 'This repair has no approved quote.', 409);
  if ((await db.query('SELECT 1 FROM repairs WHERE quote_id=$1', [quote.id])).rowCount)
    throw new AppError(
      'REPAIR_ALREADY_DELIVERED',
      'This quote already has a delivered repair.',
      409,
    );
  if (repair.baseRevision !== quote.base_revision)
    throw new AppError(
      'BASE_MISMATCH',
      `This repair was quoted against revision ${quote.base_revision}, not ${repair.baseRevision}.`,
      409,
    );
  if (repair.candidateRevision === repair.baseRevision)
    throw new AppError(
      'CANDIDATE_UNCHANGED',
      'The candidate revision is the base revision, so nothing was changed.',
      409,
    );
  // Unrelated edits need a revised quote, so the scope is a hard boundary.
  // A directory may have been stored with a trailing slash, and 'src/' and
  // 'src' name the same boundary; a scope that matched neither would be no
  // boundary at all.
  const scope = (quote.scope_paths as string[]).map((path) => path.replace(/\/+$/, ''));
  const stray = repair.changedFiles
    .map((file) => file.path)
    .filter((path) => !scope.some((allowed) => path === allowed || path.startsWith(`${allowed}/`)));
  if (stray.length)
    throw new AppError(
      'SCOPE_EXCEEDED',
      `This repair changes ${stray.join(', ')}, which the approved quote does not cover. Revise the quote before delivering those edits.`,
      409,
    );
  const unchanged = repair.changedFiles.filter((file) => file.beforeSha256 === file.afterSha256);
  if (unchanged.length)
    throw new AppError(
      'FILE_UNCHANGED',
      `${unchanged.map((file) => file.path).join(', ')} is listed as changed but its contents are identical.`,
    );
  const failed = repair.requiredChecks.filter(
    (check) => !check.baselinePassed || !check.candidatePassed,
  );
  if (failed.length)
    throw new AppError(
      'REQUIRED_CHECK_FAILED',
      `${failed.map((check) => check.label).join(', ')} must pass on both the original and the candidate revision.`,
      409,
    );
  const defect = (await db.query('SELECT id,title FROM defects WHERE id=$1', [quote.defect_id]))
    .rows[0];
  const assertions = (
    await db.query<{ assertion: string }>(
      `SELECT DISTINCT jsonb_array_elements_text(signature->'assertions') AS assertion
      FROM findings WHERE defect_id=$1`,
      [quote.defect_id],
    )
  ).rows.map((row) => row.assertion);
  const asserted = assessRegression(repair.regression, assertions);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO repairs (quote_id,defect_id,campaign_id,assignment_id,submission_id,operator_id,
    base_revision,candidate_revision,changed_files,patch_sha256,test_sha256,regression,
    required_checks,gate_state,gate_detail)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'passed',$14) RETURNING id`,
    [
      quote.id,
      quote.defect_id,
      context.campaignId,
      context.assignmentId,
      context.submissionId,
      context.operatorId,
      repair.baseRevision,
      repair.candidateRevision,
      JSON.stringify(repair.changedFiles),
      repair.patchSha256,
      repair.testSha256,
      JSON.stringify(repair.regression),
      JSON.stringify(repair.requiredChecks),
      `${asserted} failed on every clean replay of ${repair.baseRevision} and passed on every replay of ${repair.candidateRevision}, with ${repair.requiredChecks.length} required checks passing on both`.slice(
        0,
        500,
      ),
    ],
  );
  await db.query("UPDATE defects SET repair_state='delivered' WHERE id=$1", [quote.defect_id]);
  return {
    repairId: rows[0].id,
    defectId: defect.id as string,
    gate: 'passed',
    verifiedAssertion: asserted,
    // The patch is delivered for review. Trialoom never merges or deploys it.
    delivery: 'for_builder_review',
  };
}

/**
 * Records an independent verification. The repair's author and the defect's
 * discoverers cannot verify it, nor can anyone linked to them, and a
 * verification carries its own replays rather than an approval alone.
 */
export async function recordVerification(
  db: PoolClient,
  context: Context,
  document: EvidenceInput,
) {
  const reported = document.repairVerification;
  if (!reported)
    throw new AppError(
      'VERIFICATION_REQUIRED',
      'A verification must report its own regression replays on both revisions and an outcome.',
    );
  const repair = (
    await db.query('SELECT * FROM repairs WHERE campaign_id=$1 FOR UPDATE', [context.campaignId])
  ).rows[0];
  if (!repair)
    throw new AppError(
      'NO_REPAIR',
      'No repair has been delivered for this brief yet, so there is nothing to verify.',
      409,
    );
  const conflicted: string[] = [];
  const authorLink = await operatorLink(db, context.operatorId, repair.operator_id);
  if (authorLink) conflicted.push(`the repair author: ${authorLink}`);
  const discoverers = (
    await db.query<{ operator_id: string }>(
      'SELECT DISTINCT operator_id FROM findings WHERE defect_id=$1',
      [repair.defect_id],
    )
  ).rows;
  for (const row of discoverers) {
    const link = await operatorLink(db, context.operatorId, row.operator_id);
    if (link) conflicted.push(`a discoverer of this defect: ${link}`);
  }
  if (conflicted.length)
    throw new AppError(
      'INDEPENDENCE_FAILED',
      `An independent verifier cannot be ${conflicted[0]}`,
      409,
    );
  if (reported.baseRevision !== repair.base_revision)
    throw new AppError(
      'BASE_MISMATCH',
      `This repair was delivered against revision ${repair.base_revision}.`,
      409,
    );
  if (reported.candidateRevision !== repair.candidate_revision)
    throw new AppError(
      'CANDIDATE_MISMATCH',
      `This repair's candidate revision is ${repair.candidate_revision}.`,
      409,
    );
  // A confirmation has to meet the same gate the delivery met, on the same
  // failure. The delivery's baseline assertion is unique, because the gate it
  // passed required exactly one, so a confirmation that exercises a different
  // test is refused rather than counted.
  const delivered = (repair.regression as Replays).baseline[0].assertion;
  if (reported.outcome === 'confirmed')
    assessRegression(reported.regression, [delivered.trim().toLowerCase()]);
  let verification: { id: string };
  try {
    verification = (
      await db.query<{ id: string }>(
        `INSERT INTO repair_verifications (repair_id,verifier_operator_id,assignment_id,
        submission_id,outcome,regression,evidence_refs,detail)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          repair.id,
          context.operatorId,
          context.assignmentId,
          context.submissionId,
          reported.outcome,
          JSON.stringify(reported.regression),
          JSON.stringify(document.artifacts.map((artifact) => artifact.sha256)),
          reported.detail,
        ],
      )
    ).rows[0];
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new AppError('ALREADY_VERIFIED', 'You have already verified this repair.', 409);
    throw error;
  }
  if (reported.outcome === 'confirmed')
    await db.query("UPDATE defects SET repair_state='verified' WHERE id=$1", [repair.defect_id]);
  return {
    verificationId: verification.id,
    repairId: repair.id as string,
    outcome: reported.outcome,
    verifiedAssertion: delivered,
    independent: true,
  };
}

/** A repair is payable only once an independent verifier has confirmed it. */
export async function repairReadyForPayment(db: PoolClient, assignmentId: string) {
  const repair = (await db.query('SELECT * FROM repairs WHERE assignment_id=$1', [assignmentId]))
    .rows[0];
  if (!repair) return null;
  const confirmed = (
    await db.query(
      "SELECT count(*)::int AS n FROM repair_verifications WHERE repair_id=$1 AND outcome='confirmed'",
      [repair.id],
    )
  ).rows[0].n as number;
  return { repair, confirmed };
}

export async function campaignRepairs(db: Pool | PoolClient, campaignId: string) {
  const quote = (
    await db.query(
      `SELECT q.*,o.handle,d.title AS defect_title,d.repair_state
      FROM repair_quotes q JOIN operators o ON o.id=q.operator_id
      JOIN defects d ON d.id=q.defect_id WHERE q.campaign_id=$1`,
      [campaignId],
    )
  ).rows[0];
  if (!quote) return { quote: null, repair: null, verifications: [] };
  const repair = (
    await db.query(
      `SELECT r.*,o.handle FROM repairs r JOIN operators o ON o.id=r.operator_id
      WHERE r.campaign_id=$1`,
      [campaignId],
    )
  ).rows[0];
  const verifications = repair
    ? (
        await db.query(
          `SELECT v.id,v.outcome,v.detail,v.created_at,o.handle
          FROM repair_verifications v JOIN operators o ON o.id=v.verifier_operator_id
          WHERE v.repair_id=$1 ORDER BY v.created_at`,
          [repair.id],
        )
      ).rows
    : [];
  return { quote, repair: repair ?? null, verifications };
}
