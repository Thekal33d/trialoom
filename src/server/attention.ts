import type { Pool, PoolClient } from 'pg';
import { AppError } from '../domain/errors.ts';
import { uuid } from '../domain/schemas.ts';
import { settlementCurrency } from '../domain/values.ts';
import { type Actor, audit, requireRole } from './access.ts';
import { authorityListing, stalenessHours, verificationIntervalHours } from './authority.ts';
import { transaction } from './database.ts';
import { appealWindowHours } from './decisions.ts';

/**
 * The review promise, and when silence stops being the builder's alone. The
 * PRD's escalation sends a waiting submission to a platform reviewer; it never
 * accepts or rejects the work by itself, so nothing here decides anything.
 */
export const reviewTargetHours = 24;
export const escalationHours = 48;

const hoursSince = (value: string | null) =>
  value === null ? null : Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000);

/**
 * What one campaign is waiting on. Every count is derived, so this cannot
 * disagree with the records it reads: a submission is awaiting review exactly
 * when no execution decision exists for its assignment.
 */
export async function campaignAttention(db: PoolClient | Pool, campaignId: string) {
  const { rows } = await db.query(
    `SELECT
      (SELECT count(*)::int FROM evidence_submissions s
        WHERE s.campaign_id=c.id
          AND NOT EXISTS (SELECT 1 FROM decisions d
            WHERE d.assignment_id=s.assignment_id AND d.matter='execution')) AS awaiting_decision,
      (SELECT min(s.submitted_at) FROM evidence_submissions s
        WHERE s.campaign_id=c.id
          AND NOT EXISTS (SELECT 1 FROM decisions d
            WHERE d.assignment_id=s.assignment_id AND d.matter='execution')) AS waiting_since,
      (SELECT count(*)::int FROM findings f JOIN defects x ON x.id=f.defect_id
        WHERE f.campaign_id=c.id AND x.review_flag IS NOT NULL) AS flagged_defects,
      (SELECT count(*)::int FROM findings f
        WHERE f.campaign_id=c.id AND f.match='uncertain'
          AND NOT EXISTS (SELECT 1 FROM decisions d
            WHERE d.subject_id=f.id AND d.matter='duplicate')) AS ungrouped_reports,
      (SELECT count(*)::int FROM decisions d
        WHERE d.campaign_id=c.id AND d.matter='appeal' AND d.outcome='opened') AS open_appeals,
      (SELECT min(d.appeal_deadline) FROM decisions d
        WHERE d.campaign_id=c.id AND d.matter='appeal' AND d.outcome='opened') AS appeal_due,
      (SELECT count(*)::int FROM repairs r
        WHERE r.campaign_id=c.id AND NOT EXISTS (SELECT 1 FROM repair_verifications v
          WHERE v.repair_id=r.id AND v.outcome='confirmed')) AS repairs_awaiting_verification,
      (SELECT count(*)::int FROM repair_quotes q
        WHERE q.campaign_id=c.id AND q.state='proposed') AS quotes_awaiting_approval,
      (SELECT count(*)::int FROM payables p
        WHERE p.campaign_id=c.id AND p.state='blocked') AS blocked_payouts,
      (SELECT count(*)::int FROM payables p
        WHERE p.campaign_id=c.id AND p.state='needs_reconciliation') AS payouts_needing_reconciliation,
      (SELECT COALESCE(SUM(p.amount_units),0)::text FROM payables p
        WHERE p.campaign_id=c.id AND p.state NOT IN ('finalized','cancelled')) AS owed_units,
      (SELECT count(*)::int FROM resource_purchases u
        WHERE u.campaign_id=c.id AND u.reconciled_at IS NULL) AS resources_unreconciled,
      (SELECT count(*)::int FROM assignments a
        WHERE a.campaign_id=c.id AND a.state IN ('claimed','running')) AS live_assignments
    FROM campaigns c WHERE c.id=$1`,
    [campaignId],
  );
  const row = rows[0];
  if (!row) return null;
  const waiting = hoursSince(row.waiting_since);
  return {
    ...row,
    waitingHours: waiting,
    // The target and the escalation are facts about the clock, not decisions.
    pastReviewTarget: waiting !== null && waiting >= reviewTargetHours,
    pastEscalation: waiting !== null && waiting >= escalationHours,
  };
}

/** Everything in one blocked or blocked reason, counted once per campaign. */
const sum = (rows: { attention: Record<string, unknown> | null }[], key: string) =>
  rows.reduce((total, row) => total + Number(row.attention?.[key] ?? 0), 0);

/**
 * One place that answers what is waiting and on whom, across every campaign in
 * a workspace. Owners and members see their own work; a reviewer sees the same
 * queue, and that read is recorded like every other reviewer read.
 */
export async function workspaceAttention(pool: Pool, actor: Actor, workspaceId: string) {
  const id = uuid.parse(workspaceId);
  return transaction(pool, async (db) => {
    const role = await requireRole(db, actor, id, ['owner', 'member', 'reviewer']);
    const campaigns = (
      await db.query<{ id: string; name: string; status: string; project: string }>(
        `SELECT c.id,c.name,c.status,p.name AS project,p.id AS project_id
        FROM campaigns c JOIN projects p ON p.id=c.project_id
        WHERE p.workspace_id=$1 AND c.status<>'draft' ORDER BY c.created_at DESC LIMIT 100`,
        [id],
      )
    ).rows;
    const rows = [];
    for (const campaign of campaigns) {
      const attention = await campaignAttention(db, campaign.id);
      const pending =
        attention === null
          ? 0
          : Number(attention.awaiting_decision) +
            Number(attention.ungrouped_reports) +
            Number(attention.open_appeals) +
            Number(attention.quotes_awaiting_approval) +
            Number(attention.repairs_awaiting_verification) +
            Number(attention.blocked_payouts) +
            Number(attention.payouts_needing_reconciliation) +
            Number(attention.resources_unreconciled);
      rows.push({ ...campaign, attention, pending });
    }
    // What can actually pay, and how lately anyone checked. An approval is in
    // this queue when nobody has read it, when the last read failed, when the
    // reading has gone stale, or when it does not cover what it is funding.
    const authorities = (await authorityListing(db, id)).authorities
      .filter((authority) => !authority.revokedAt)
      .map((authority) => {
        const approval = authority.approval;
        const short = approval.shortfallUnits !== null && approval.shortfallUnits !== '0';
        return {
          id: authority.id,
          reference: authority.reference,
          campaigns: authority.campaigns,
          state: approval.state,
          declaredUnits: approval.declaredUnits,
          committedUnits: approval.committedUnits,
          shortfallUnits: short ? approval.shortfallUnits : null,
          readingAgeHours: approval.readingAgeHours,
          stale: approval.stale,
          neverRead: approval.observedAt === null,
          lastReadError: approval.lastReadError,
          needsAttention: short || approval.stale || approval.observedAt === null,
        };
      });
    if (role === 'reviewer') await audit(db, id, actor.id, 'reviewer.attention_read', id);
    const waiting = rows
      .map((row) => row.attention?.waitingHours)
      .filter((hours): hours is number => typeof hours === 'number');
    return {
      // Busiest first: a reviewer should not have to hunt for the queue.
      campaigns: rows.sort((a, b) => b.pending - a.pending),
      totals: {
        awaitingDecision: sum(rows, 'awaiting_decision'),
        ungroupedReports: sum(rows, 'ungrouped_reports'),
        flaggedDefects: sum(rows, 'flagged_defects'),
        openAppeals: sum(rows, 'open_appeals'),
        quotesAwaitingApproval: sum(rows, 'quotes_awaiting_approval'),
        repairsAwaitingVerification: sum(rows, 'repairs_awaiting_verification'),
        blockedPayouts: sum(rows, 'blocked_payouts'),
        payoutsNeedingReconciliation: sum(rows, 'payouts_needing_reconciliation'),
        resourcesUnreconciled: sum(rows, 'resources_unreconciled'),
        owedUnits: rows
          .reduce((total, row) => total + BigInt(String(row.attention?.owed_units ?? '0')), 0n)
          .toString(),
        pastReviewTarget: rows.filter((row) => row.attention?.pastReviewTarget).length,
        pastEscalation: rows.filter((row) => row.attention?.pastEscalation).length,
        longestWaitHours: waiting.length ? Math.max(...waiting) : null,
        authoritiesNeverRead: authorities.filter((row) => row.neverRead).length,
        authoritiesUnreadable: authorities.filter((row) => row.lastReadError !== null).length,
        authoritiesStale: authorities.filter((row) => row.stale).length,
        authoritiesShort: authorities.filter((row) => row.shortfallUnits !== null).length,
      },
      authorities: authorities.sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention)),
      policy: {
        reviewTargetHours,
        escalationHours,
        appealWindowHours,
        escalates: 'to a platform reviewer; silence never accepts or rejects the work',
        verificationIntervalHours,
        stalenessHours,
        staleReadings:
          'an approval is re-read on a timer; a stale or short reading is reported and never cancels an obligation or blocks a payment by itself',
      },
      currency: settlementCurrency,
      note: 'Work state and money state are separate. An accepted amount can still have a blocked payment, and nothing here decides anything.',
    };
  });
}

/** The campaign's own waiting list, for the panel that shows one brief. */
export async function campaignAttentionRecord(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  projectId: string,
  campaignId: string,
) {
  return transaction(pool, async (db) => {
    await requireRole(db, actor, workspaceId, ['owner', 'member', 'reviewer']);
    const campaign = (
      await db.query(
        `SELECT c.id FROM campaigns c JOIN projects p ON p.id=c.project_id
        WHERE c.id=$1 AND c.project_id=$2 AND p.workspace_id=$3`,
        [campaignId, projectId, workspaceId],
      )
    ).rows[0];
    if (!campaign) throw new AppError('NOT_FOUND', 'Work brief not found.', 404);
    return {
      attention: await campaignAttention(db, campaignId),
      policy: { reviewTargetHours, escalationHours, appealWindowHours },
    };
  });
}
