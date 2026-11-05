import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import {
  attemptTokenSchema,
  campaignStatusSchema,
  claimSchema,
  publicationSchema,
  uuid,
} from '../domain/schemas.ts';
import { type Actor, audit, requireRole } from './access.ts';
import type { AgentSession } from './agents.ts';
import { commitOnAuthority, releaseOnClose, resolveAuthority } from './authority.ts';
import { transaction } from './database.ts';
import { emit } from './events.ts';
import {
  authorizeBudget,
  campaignAccounting,
  commitAssignment,
  lockAccount,
  maximumLiability,
  releaseCommitment,
  type TermsDocument,
  total,
} from './ledger.ts';
import { requirePublicFunding, requirePublicOperator } from './marketplace.ts';
import { approvedQuote, repairRole } from './repairs.ts';
import { requireMarketplaceWorkspace } from './signup.ts';

export const leaseSeconds = 900;
type CampaignRow = {
  id: string;
  project_id: string;
  name: string;
  status: string;
  latest_version: number;
  published_terms_id: string | null;
  slots: number | null;
  max_concurrent: number | null;
  visibility: 'private' | 'public';
  authority_id: string | null;
};

async function lockCampaign(db: PoolClient, projectId: string, campaignId: string) {
  const { rows } = await db.query<CampaignRow>(
    'SELECT * FROM campaigns WHERE id=$1 AND project_id=$2 FOR UPDATE',
    [campaignId, projectId],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Work brief not found.', 404);
  return rows[0];
}
async function termsVersion(db: PoolClient | Pool, campaignId: string, versionId: string) {
  const { rows } = await db.query<{
    id: string;
    build_id: string;
    version: number;
    document: TermsDocument;
  }>('SELECT id,build_id,version,document FROM terms_versions WHERE id=$1 AND campaign_id=$2', [
    versionId,
    campaignId,
  ]);
  if (!rows[0])
    throw new AppError('TERMS_NOT_FOUND', 'Those terms do not belong to this brief.', 404);
  return rows[0];
}

/**
 * Offers one exact terms version to operators. Publishing never follows the
 * latest version by itself: a later revision needs another explicit publication
 * and another funding check, and existing assignments keep what they pinned.
 */
export async function publishCampaign(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  campaignId: string,
  input: unknown,
) {
  const data = publicationSchema.parse(input);
  try {
    return await publish(pool, actor, workspaceId, projectId, campaignId, data);
  } catch (error) {
    // A refused publication rolls its own transaction back, so the event is
    // written afterwards on the pool. Otherwise the stream would record only
    // the publications that succeeded, and funding failure would be invisible.
    const code = (error as { code?: string }).code;
    if (code && ['INSUFFICIENT_BUDGET', 'AMOUNT_INVALID', 'CAMPAIGN_UNFUNDED'].includes(code))
      await emit(
        pool,
        'campaign.funding_failed',
        { workspaceId, projectId, campaignId, actorId: actor.id },
        { reason: code, detail: (error as Error).message, slots: data.slots },
      );
    throw error;
  }
}

async function publish(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  campaignId: string,
  data: ReturnType<typeof publicationSchema.parse>,
) {
  return transaction(pool, async (db) => {
    // Money decisions belong to the workspace owner.
    await requireRole(db, actor, workspaceId, ['owner']);
    await requireMarketplaceWorkspace(db, workspaceId);
    if (
      !(
        await db.query('SELECT 1 FROM projects WHERE id=$1 AND workspace_id=$2', [
          projectId,
          workspaceId,
        ])
      ).rowCount
    )
      throw new AppError('NOT_FOUND', 'Project not found in this workspace.', 404);
    const campaign = await lockCampaign(db, projectId, campaignId);
    if (!['draft', 'open', 'paused'].includes(campaign.status))
      throw new AppError('CAMPAIGN_CLOSED', 'This brief can no longer be published.', 409);
    const terms = await termsVersion(db, campaignId, data.termsVersionId);
    const visibility = data.visibility ?? campaign.visibility;
    if (campaign.visibility === 'public' && visibility === 'private')
      throw new AppError(
        'PUBLICATION_IRREVERSIBLE',
        'Published terms cannot become private again. Pause or close this job to stop new claims.',
        409,
      );
    if (visibility === 'public' && data.publicTermsConfirmed !== true)
      throw new AppError(
        'PUBLIC_TERMS_CONFIRMATION_REQUIRED',
        'Confirm that qualified operators may read this job and its terms.',
        400,
      );
    if (
      visibility === 'public' &&
      (terms.document.minimumIsolation !== 'witnessed' || BigInt(terms.document.priceUnits) <= 0n)
    )
      throw new AppError(
        'PUBLIC_JOB_INVALID',
        'Public paid jobs require a positive execution fee and witnessed browser isolation.',
        400,
      );
    if (new Date(terms.document.deadline) <= new Date())
      throw new AppError('DEADLINE_PAST', 'These terms have passed their delivery deadline.');
    // A repair is bought against an approved quote, so the offer operators see
    // must be the one the owner approved: the same build, at the same price.
    // Otherwise the quote would decide nothing.
    if (terms.document.service === 'repair') {
      const quote = await approvedQuote(db, campaignId);
      if (!quote)
        throw new AppError(
          'REPAIR_QUOTE_MISSING',
          'A repair brief needs an approved quote before it can be published.',
          409,
        );
      if (quote.base_build_id !== terms.build_id)
        throw new AppError(
          'QUOTE_BUILD_MISMATCH',
          `This repair was quoted against revision ${quote.base_revision}. Publish the terms that pin that build, or revise the quote.`,
          409,
        );
      if (BigInt(quote.amount_units) !== BigInt(terms.document.priceUnits))
        throw new AppError(
          'QUOTE_PRICE_MISMATCH',
          `These terms price the repair at ${terms.document.priceUnits} base units, but the approved quote is ${quote.amount_units}. Revise one so the approval and the published offer agree.`,
          409,
        );
    }
    const perAssignment = total(maximumLiability(terms.document));
    const first = campaign.status === 'draft';
    const authorization = BigInt(data.authorizeUnits);
    if (first && authorization <= 0n)
      throw new AppError('AMOUNT_INVALID', 'Authorize a budget before publishing.');
    if (first)
      await db.query(
        `INSERT INTO campaign_accounts (campaign_id,ceiling_units,currency_chain_id,currency_address)
        VALUES ($1,0,$2,$3)`,
        [campaignId, 42220, '0xcebA9300f2b948710d2653dD7B07f33A8B32118C'],
      );
    // Which approval will actually pay. Resolved before the budget rises, so a
    // brief whose authority cannot cover it is refused rather than published
    // with a promise two campaigns are both relying on.
    const authority = await resolveAuthority(db, workspaceId, campaignId, data.authorityId);
    if (visibility === 'public')
      await requirePublicFunding(db, authority?.id ?? null, authorization);
    if (authorization > 0n) {
      if (authority) await commitOnAuthority(db, authority.id, campaignId, authorization, actor.id);
      await authorizeBudget(
        db,
        campaignId,
        authorization,
        data.spendingAuthorization,
        actor.id,
        authority?.id ?? null,
      );
    }
    const account = await lockAccount(db, campaignId);
    const required = perAssignment * BigInt(data.slots);
    const headroom =
      BigInt(account.ceiling_units) -
      BigInt(account.accepted_units) -
      BigInt(account.finalized_units);
    // A ceiling that cannot cover every offered slot would publish work the
    // builder has not authorized. Spending authority is not escrow either way.
    if (headroom < required)
      throw new AppError(
        'INSUFFICIENT_BUDGET',
        `These terms reserve ${perAssignment} base units per assignment, so ${data.slots} slots need ${required}. The campaign ceiling leaves ${headroom}.`,
        409,
      );
    await db.query(
      `UPDATE campaigns SET status='open',slots=$2,max_concurrent=$3,published_terms_id=$4,
      published_by=$5,published_at=COALESCE(published_at,clock_timestamp()),closed_at=NULL,
      spending_authorization=$6,authority_id=COALESCE($7,authority_id),visibility=$8 WHERE id=$1`,
      [
        campaignId,
        data.slots,
        data.maxConcurrent,
        terms.id,
        actor.id,
        data.spendingAuthorization,
        authority?.id ?? null,
        visibility,
      ],
    );
    if (visibility === 'public' && authority)
      await db.query(
        "UPDATE outbox_jobs SET available_at=LEAST(available_at,clock_timestamp()+interval '2 minutes') WHERE dedupe_key=$1 AND state='pending'",
        [`authority:${authority.id}`],
      );
    await audit(
      db,
      workspaceId,
      actor.id,
      first ? 'campaign.published' : 'campaign.republished',
      campaignId,
    );
    await emit(
      db,
      'campaign.published',
      { workspaceId, projectId, campaignId, actorId: actor.id },
      {
        first,
        service: terms.document.service,
        termsVersion: terms.version,
        slots: data.slots,
        maxConcurrent: data.maxConcurrent,
        perAssignmentUnits: perAssignment.toString(),
        ceilingUnits: account.ceiling_units,
        minimumIsolation: terms.document.minimumIsolation ?? 'attested',
      },
    );
    // A builder returning to buy again is the pilot's first metric, and it is
    // only knowable at the moment they publish.
    const earlier = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM campaigns c JOIN projects p ON p.id=c.project_id
      WHERE p.workspace_id=$1 AND c.id<>$2 AND c.published_at IS NOT NULL`,
      [workspaceId, campaignId],
    );
    if (first && earlier.rows[0].n > 0)
      await emit(
        db,
        'purchase.repeated',
        { workspaceId, projectId, campaignId, actorId: actor.id },
        { earlierCampaigns: earlier.rows[0].n },
      );
    return {
      campaignId,
      status: 'open',
      termsVersionId: terms.id,
      termsVersion: terms.version,
      buildId: terms.build_id,
      slots: data.slots,
      maxConcurrent: data.maxConcurrent,
      perAssignmentUnits: perAssignment.toString(),
      ceilingUnits: account.ceiling_units,
    };
  });
}

export async function authorizeMore(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  campaignId: string,
  input: unknown,
) {
  const data = publicationSchema
    .pick({ authorizeUnits: true, spendingAuthorization: true, authorityId: true })
    .parse(input);
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    const campaign = await lockCampaign(db, projectId, campaignId);
    if (campaign.status === 'draft')
      throw new AppError(
        'CAMPAIGN_CLOSED',
        'Publish the brief before authorizing more budget.',
        409,
      );
    await lockAccount(db, campaignId);
    const authority = await resolveAuthority(db, workspaceId, campaignId, data.authorityId);
    const amount = BigInt(data.authorizeUnits);
    if (authority) await commitOnAuthority(db, authority.id, campaignId, amount, actor.id);
    await authorizeBudget(
      db,
      campaignId,
      amount,
      data.spendingAuthorization,
      actor.id,
      authority?.id ?? null,
    );
    await audit(db, workspaceId, actor.id, 'campaign.budget_authorized', campaignId);
    return campaignAccounting(db, campaignId);
  });
}

/**
 * Pausing and cancelling stop new claims. Live assignments drain under the exact
 * terms they pinned, and accepted obligations are never erased.
 */
export async function setCampaignStatus(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  campaignId: string,
  input: unknown,
) {
  const { status, reason } = campaignStatusSchema.parse(input);
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner']);
    const campaign = await lockCampaign(db, projectId, campaignId);
    if (campaign.status === 'draft')
      throw new AppError('CAMPAIGN_CLOSED', 'This brief is still a draft.', 409);
    if (['cancelled', 'completed'].includes(campaign.status))
      throw new AppError('CAMPAIGN_CLOSED', 'This campaign is already closed.', 409);
    if (status === 'open' && campaign.status !== 'paused')
      throw new AppError('CAMPAIGN_CLOSED', 'Only a paused campaign can reopen.', 409);
    const live = (
      await db.query(
        `SELECT count(*)::int AS live FROM assignments
        WHERE campaign_id=$1 AND state IN ('claimed','running','submitted')`,
        [campaignId],
      )
    ).rows[0].live as number;
    await db.query(
      `UPDATE campaigns SET status=$2,closed_at=CASE WHEN $2 IN ('cancelled','completed')
      THEN clock_timestamp() ELSE NULL END WHERE id=$1`,
      [campaignId, status],
    );
    // A closed brief will never spend its remainder, so the approval can
    // promise it to the next one. What is still owed on a payable stays
    // reserved: withdrawing an authorization has never cancelled a debt.
    const returned = ['cancelled', 'completed'].includes(status)
      ? await releaseOnClose(db, campaignId, `Campaign ${status}`, actor.id)
      : 0n;
    await audit(db, workspaceId, actor.id, `campaign.${status}`, campaignId);
    return {
      status,
      reason,
      drainingAssignments: live,
      approvalReleasedUnits: returned.toString(),
      note:
        status === 'cancelled'
          ? 'New claims stopped. Live assignments continue under their pinned terms and accepted obligations remain owed.'
          : 'New claims stopped while paused.',
    };
  });
}

/** Expiry fences a lapsed attempt and returns its reservation to the campaign. */
export async function expireLapsedAssignments(db: PoolClient, campaignId?: string) {
  const { rows } = await db.query<{ id: string; campaign_id: string }>(
    `UPDATE assignments SET state='expired',closed_at=clock_timestamp(),
    closed_reason='Claim lease expired before submission'
    WHERE state IN ('claimed','running') AND lease_expires_at<=clock_timestamp()
    ${campaignId ? 'AND campaign_id=$1' : ''} RETURNING id,campaign_id`,
    campaignId ? [campaignId] : [],
  );
  if (rows.length)
    // The same moment retires the run grant a runner is holding.
    await db.query(
      `UPDATE runs SET state='expired',closed_at=clock_timestamp(),
      closed_reason='Claim lease expired during the run'
      WHERE assignment_id = ANY($1::uuid[]) AND state IN ('issued','active')`,
      [rows.map((row) => row.id)],
    );
  for (const row of rows) {
    await lockAccount(db, row.campaign_id);
    await releaseCommitment(db, row.campaign_id, row.id, 'Claim expired', null);
  }
  return rows.length;
}

export async function sweepExpiredAssignments(pool: Pool) {
  return transaction(pool, (db) => expireLapsedAssignments(db));
}

/**
 * Takes the caller's transaction so an idempotency reservation and the claim it
 * covers commit or roll back together.
 */
export async function claimAssignment(db: PoolClient, session: AgentSession, input: unknown) {
  const campaignId = claimSchema.parse(input).campaignId;
  {
    const campaign = (
      await db.query<CampaignRow & { workspace_id: string }>(
        `SELECT c.*,p.workspace_id FROM campaigns c JOIN projects p ON p.id=c.project_id WHERE c.id=$1 FOR UPDATE OF c`,
        [campaignId],
      )
    ).rows[0];
    if (!campaign) throw new AppError('NOT_FOUND', 'That campaign is not available.', 404);
    if (campaign.visibility === 'public') await requirePublicFunding(db, campaign.authority_id);
    // Serialize every claim on this campaign behind one row.
    const account = await lockAccount(db, campaignId);
    await expireLapsedAssignments(db, campaignId);
    if (campaign.status !== 'open')
      throw new AppError(
        'CAMPAIGN_CLOSED',
        'This campaign is not accepting claims. Existing assignments continue under their own terms.',
        409,
      );
    if (campaign.visibility === 'public') {
      await requirePublicOperator(db, campaign.workspace_id, session.userId, session.operator.id);
    } else if (
      !(
        await db.query(
          `SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND role='operator'`,
          [campaign.workspace_id, session.userId],
        )
      ).rowCount
    )
      throw new AppError('NOT_ADMITTED', 'This builder has not admitted you to their work.', 403);
    // Never resolve through latest_version: the published version is the offer.
    const terms = await termsVersion(db, campaignId, campaign.published_terms_id ?? '');
    if (
      !(
        await db.query(
          `SELECT 1 FROM operator_eligibility WHERE operator_id=$1 AND service=$2 AND state='eligible'`,
          [session.operator.id, terms.document.service],
        )
      ).rowCount
    )
      throw new AppError(
        'NOT_QUALIFIED',
        `Pass the seeded ${terms.document.service} qualification before claiming this work.`,
        403,
      );
    // The first slot of a repair brief belongs to the quoted operator. Until
    // they have claimed it, nobody else can take the slot the repair needs.
    if (terms.document.service === 'repair') await repairRole(db, campaignId, session.operator.id);
    const deadline = new Date(terms.document.deadline);
    if (deadline <= new Date())
      throw new AppError('DEADLINE_PAST', 'These terms have passed their delivery deadline.', 409);
    const counts = (
      await db.query(
        `SELECT count(*) FILTER (WHERE state IN ('claimed','running','submitted','accepted'))::int AS used,
          count(*) FILTER (WHERE state IN ('claimed','running','submitted'))::int AS live
        FROM assignments WHERE campaign_id=$1`,
        [campaignId],
      )
    ).rows[0];
    if (counts.used >= (campaign.slots ?? 0))
      throw new AppError('NO_SLOTS', 'Every assignment slot in this campaign is taken.', 409);
    if (counts.live >= (campaign.max_concurrent ?? 0))
      throw new AppError('NO_SLOTS', 'This campaign is at its concurrent assignment limit.', 409);
    const parts = maximumLiability(terms.document);
    const lease = new Date(Math.min(Date.now() + leaseSeconds * 1000, deadline.getTime()));
    let assignment: { id: string; attempt_token: string };
    try {
      assignment = (
        await db.query<{ id: string; attempt_token: string }>(
          `INSERT INTO assignments (campaign_id,project_id,terms_version_id,build_id,operator_id,
          credential_id,state,max_liability_units,lease_expires_at,deadline)
          VALUES ($1,$2,$3,$4,$5,$6,'claimed',$7,$8,$9) RETURNING id,attempt_token`,
          [
            campaignId,
            campaign.project_id,
            terms.id,
            terms.build_id,
            session.operator.id,
            session.credential.id,
            total(parts).toString(),
            lease,
            deadline,
          ],
        )
      ).rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError(
          'ALREADY_CLAIMED',
          'You already hold a live assignment in this campaign.',
          409,
        );
      throw error;
    }
    await commitAssignment(db, campaignId, assignment.id, parts, null);
    await emit(
      db,
      'assignment.claimed',
      {
        workspaceId: campaign.workspace_id,
        projectId: campaign.project_id,
        campaignId,
        assignmentId: assignment.id,
        operatorId: session.operator.id,
      },
      {
        service: terms.document.service,
        termsVersion: terms.version,
        maxLiabilityUnits: total(parts).toString(),
        slotsUsed: counts.used + 1,
      },
    );
    return {
      assignmentId: assignment.id,
      // The attempt token fences this execution attempt. It is shown once.
      attemptToken: assignment.attempt_token,
      campaignId,
      projectId: campaign.project_id,
      termsVersionId: terms.id,
      termsVersion: terms.version,
      buildId: terms.build_id,
      terms: terms.document,
      state: 'claimed',
      maxLiabilityUnits: total(parts).toString(),
      leaseExpiresAt: lease.toISOString(),
      deadline: deadline.toISOString(),
      availableUnitsAfter: (
        BigInt(account.ceiling_units) -
        BigInt(account.committed_units) -
        BigInt(account.accepted_units) -
        BigInt(account.finalized_units) -
        total(parts)
      ).toString(),
    };
  }
}

export async function claim(pool: Pool, session: AgentSession, input: unknown) {
  return transaction(pool, (db) => claimAssignment(db, session, input));
}

/** The single fencing check: the right operator, the active attempt, still live. */
export async function liveAssignment(
  db: PoolClient,
  session: AgentSession,
  assignmentId: string,
  attemptToken: string,
) {
  await expireLapsedAssignments(db, undefined);
  const { rows } = await db.query(
    `SELECT * FROM assignments WHERE id=$1 AND operator_id=$2 FOR UPDATE`,
    [assignmentId, session.operator.id],
  );
  const assignment = rows[0];
  if (!assignment) throw new AppError('NOT_FOUND', 'Assignment not found.', 404);
  // A retired attempt can never act again, however long it kept running.
  if (assignment.attempt_token !== attemptToken)
    throw new AppError(
      'STALE_ATTEMPT',
      'This attempt token is not the active attempt for that assignment.',
      409,
    );
  if (!['claimed', 'running'].includes(assignment.state))
    throw new AppError(
      'ATTEMPT_CLOSED',
      `This assignment is ${assignment.state} and cannot be continued. ${assignment.closed_reason ?? ''}`.trim(),
      409,
    );
  return assignment;
}

export async function heartbeatAssignment(
  pool: Pool,
  session: AgentSession,
  assignmentId: string,
  input: unknown,
) {
  const { attemptToken } = attemptTokenSchema.parse(input);
  return transaction(pool, async (db) => {
    const assignment = await liveAssignment(db, session, uuid.parse(assignmentId), attemptToken);
    const lease = new Date(
      Math.min(Date.now() + leaseSeconds * 1000, new Date(assignment.deadline).getTime()),
    );
    const { rows } = await db.query(
      `UPDATE assignments SET state='running',lease_expires_at=$2 WHERE id=$1
      RETURNING id,state,lease_expires_at,deadline`,
      [assignment.id, lease],
    );
    // A run grant never outlives the lease that justifies it.
    await db.query(
      `UPDATE runs SET grant_expires_at=$2 WHERE assignment_id=$1 AND state IN ('issued','active')`,
      [assignment.id, lease],
    );
    return {
      assignmentId: rows[0].id,
      state: rows[0].state,
      leaseExpiresAt: rows[0].lease_expires_at,
      deadline: rows[0].deadline,
    };
  });
}

export async function releaseAssignment(
  pool: Pool,
  session: AgentSession,
  assignmentId: string,
  input: unknown,
) {
  const { attemptToken } = attemptTokenSchema.parse(input);
  return transaction(pool, async (db) => {
    const assignment = await liveAssignment(db, session, uuid.parse(assignmentId), attemptToken);
    await db.query(
      `UPDATE assignments SET state='released',closed_at=clock_timestamp(),
      closed_reason='Released by the operator' WHERE id=$1`,
      [assignment.id],
    );
    await lockAccount(db, assignment.campaign_id);
    const released = await releaseCommitment(
      db,
      assignment.campaign_id,
      assignment.id,
      'Assignment released',
      null,
    );
    return { assignmentId: assignment.id, state: 'released', releasedUnits: released.toString() };
  });
}

export async function operatorAssignments(pool: Pool, operatorId: string) {
  await sweepExpiredAssignments(pool);
  const { rows } = await pool.query(
    `SELECT a.id,a.campaign_id,a.project_id,a.terms_version_id,a.build_id,a.state,
      a.max_liability_units,a.lease_expires_at,a.deadline,a.claimed_at,a.closed_reason,
      c.name AS campaign,t.document->>'service' AS service,t.version AS terms_version,
      (SELECT r.state FROM runs r WHERE r.assignment_id=a.id
        ORDER BY r.issued_at DESC LIMIT 1) AS run_state,
      (SELECT r.id FROM runs r WHERE r.assignment_id=a.id AND r.state IN ('issued','active')
        LIMIT 1) AS live_run_id,
      s.outcome,s.submitted_at,
      (SELECT x.outcome FROM decisions x WHERE x.assignment_id=a.id AND x.matter='execution')
        AS execution_outcome,
      (SELECT x.outcome FROM decisions x WHERE x.assignment_id=a.id AND x.matter='discovery')
        AS discovery_outcome,
      (SELECT count(*)::int FROM decisions x WHERE x.assignment_id=a.id
        AND x.matter='appeal' AND x.outcome='opened') AS appeal_open
    FROM assignments a JOIN campaigns c ON c.id=a.campaign_id
    JOIN terms_versions t ON t.id=a.terms_version_id
    LEFT JOIN evidence_submissions s ON s.assignment_id=a.id
    WHERE a.operator_id=$1 ORDER BY a.claimed_at DESC LIMIT 100`,
    [operatorId],
  );
  // The attempt token is never re-served; a lost token ends that attempt.
  return { assignments: rows };
}

export async function campaignLedger(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  campaignId: string,
) {
  return transaction(pool, async (db) => {
    const role = await requireRole(db, actor, workspaceId, ['owner', 'member', 'reviewer']);
    const campaign = (
      await db.query<CampaignRow>(
        `SELECT c.* FROM campaigns c JOIN projects p ON p.id=c.project_id
        WHERE c.id=$1 AND c.project_id=$2 AND p.workspace_id=$3`,
        [campaignId, projectId, workspaceId],
      )
    ).rows[0];
    if (!campaign) throw new AppError('NOT_FOUND', 'Work brief not found.', 404);
    await expireLapsedAssignments(db, campaignId);
    const assignments = (
      await db.query(
        `SELECT a.id,a.state,a.operator_id,o.handle,a.terms_version_id,a.build_id,
          a.max_liability_units,a.accepted_units,a.lease_expires_at,a.deadline,a.claimed_at,a.closed_reason
        FROM assignments a JOIN operators o ON o.id=a.operator_id
        WHERE a.campaign_id=$1 ORDER BY a.claimed_at DESC`,
        [campaignId],
      )
    ).rows;
    if (role === 'reviewer')
      await audit(db, workspaceId, actor.id, 'reviewer.ledger_read', campaignId);
    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        visibility: campaign.visibility,
        slots: campaign.slots,
        maxConcurrent: campaign.max_concurrent,
        publishedTermsId: campaign.published_terms_id,
        latestVersion: campaign.latest_version,
      },
      accounting: await campaignAccounting(db, campaignId),
      assignments,
    };
  });
}
