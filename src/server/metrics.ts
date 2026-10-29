import type { Pool, PoolClient } from 'pg';
import { uuid } from '../domain/schemas.ts';
import { settlementCurrency } from '../domain/values.ts';
import { type Actor, audit, requireRole } from './access.ts';
import { transaction } from './database.ts';
import { feeRecipient } from './payables.ts';

/**
 * The PRD's eight pilot decision targets. Each one carries its definition, its
 * threshold, the numerator and denominator it was computed from, and whether
 * its inputs actually exist yet.
 *
 * A metric whose inputs are missing reports `complete: false` and names what is
 * missing. It never reports a number that looks like a measurement when half of
 * what it needs is unrecorded: an exit gate read off an incomplete figure is
 * worse than an openly empty one.
 */
export type Metric = {
  id: string;
  name: string;
  definition: string;
  target: string;
  /** null when the denominator is empty: nothing to measure yet. */
  value: number | null;
  unit: 'ratio' | 'count' | 'minutes' | 'units';
  numerator: number | null;
  denominator: number | null;
  meetsTarget: boolean | null;
  complete: boolean;
  missing: string[];
  detail?: Record<string, unknown>;
};

const ratio = (numerator: number, denominator: number) =>
  denominator === 0 ? null : numerator / denominator;

/** The pilot targets five builders; the first five are the ones measured. */
const pilotBuilders = 5;
const repeatWindowDays = 30;

export async function pilotMetrics(db: Pool | PoolClient, workspaceId: string): Promise<Metric[]> {
  const scope = [workspaceId];
  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = scope) =>
    (await db.query<T>(sql, params)).rows[0];

  // Useful delivery: submissions accepted after verification. A passing test is
  // a valid delivery, so the denominator is every submission that was decided.
  const delivery = await one<{ decided: number; accepted: number; rejected: number }>(
    `SELECT
      count(*) FILTER (WHERE d.id IS NOT NULL)::int AS decided,
      count(*) FILTER (WHERE d.outcome='accepted')::int AS accepted,
      count(*) FILTER (WHERE d.outcome='rejected')::int AS rejected
    FROM evidence_submissions s
    JOIN projects p ON p.id=(SELECT project_id FROM campaigns c WHERE c.id=s.campaign_id)
    LEFT JOIN decisions d ON d.assignment_id=s.assignment_id AND d.matter='execution'
    WHERE p.workspace_id=$1`,
  );
  const rejectionClasses = (
    await db.query<{ blocked_reason: string | null; outcome: string; n: number }>(
      `SELECT s.outcome,s.blocked_reason,count(*)::int AS n
      FROM evidence_submissions s
      JOIN projects p ON p.id=(SELECT project_id FROM campaigns c WHERE c.id=s.campaign_id)
      JOIN decisions d ON d.assignment_id=s.assignment_id AND d.matter='execution'
      WHERE p.workspace_id=$1 AND d.outcome='rejected'
      GROUP BY s.outcome,s.blocked_reason ORDER BY n DESC`,
      scope,
    )
  ).rows;

  // Discovery precision: independently confirmed unique defects over the
  // discovery submissions that were adjudicated either way. A defect only
  // reaches 'confirmed' on two independent reports, so that state is what
  // "independently confirmed" means here.
  //
  // The numerator is scoped to the defects those adjudicated submissions were
  // about. Counting every confirmed defect in the workspace would measure the
  // project rather than the decisions, and an earlier version of this query
  // joined on the wrong column and could only ever answer zero.
  const discovery = await one<{ adjudicated: number; confirmed: number }>(
    `WITH adjudicated AS (
      SELECT d.id,f.defect_id FROM decisions d
      LEFT JOIN findings f ON f.id=d.subject_id AND d.subject_type='finding'
      WHERE d.matter='discovery' AND d.campaign_id IN
        (SELECT c.id FROM campaigns c JOIN projects q ON q.id=c.project_id
          WHERE q.workspace_id=$1)
    )
    SELECT (SELECT count(*)::int FROM adjudicated) AS adjudicated,
      (SELECT count(DISTINCT a.defect_id)::int FROM adjudicated a
        JOIN defects x ON x.id=a.defect_id WHERE x.state='confirmed') AS confirmed`,
  );

  // Review burden: the attended span from a reviewer opening a submission to
  // the decision. It exists only for reviews done through the review screen.
  const burden = await one<{ reviews: number; median: string | null; decided: number }>(
    `WITH opened AS (
      SELECT e.assignment_id,min(e.occurred_at) AS opened_at FROM events e
      WHERE e.topic='review.opened' AND e.workspace_id=$1 GROUP BY e.assignment_id
    ), spans AS (
      SELECT EXTRACT(EPOCH FROM (d.created_at - o.opened_at))/60 AS minutes
      FROM opened o JOIN decisions d ON d.assignment_id=o.assignment_id
      WHERE d.matter='execution' AND d.created_at >= o.opened_at
    )
    SELECT (SELECT count(*)::int FROM spans) AS reviews,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes)::text FROM spans) AS median,
      (SELECT count(*)::int FROM decisions d
        WHERE d.matter='execution' AND d.campaign_id IN
          (SELECT c.id FROM campaigns c JOIN projects q ON q.id=c.project_id
            WHERE q.workspace_id=$1)) AS decided`,
  );

  // Payment correctness: a duplicate finalized payout, or spend past what the
  // builder authorized. Both must be zero, and both are checked structurally.
  const correctness = await one<{ duplicates: number; overspent: number }>(
    `SELECT
      (SELECT count(*)::int FROM (
        SELECT decision_id,kind FROM payables
        WHERE state='finalized' AND decision_id IS NOT NULL
          AND campaign_id IN (SELECT c.id FROM campaigns c JOIN projects q ON q.id=c.project_id
            WHERE q.workspace_id=$1)
        GROUP BY decision_id,kind HAVING count(*) > 1) AS repeated) AS duplicates,
      (SELECT count(*)::int FROM campaign_accounts a
        JOIN campaigns c ON c.id=a.campaign_id JOIN projects q ON q.id=c.project_id
        WHERE q.workspace_id=$1
          AND a.committed_units + a.accepted_units + a.finalized_units > a.ceiling_units)
        AS overspent`,
  );

  // Payment timeliness: finalized within an hour of the acceptance that owed
  // it. An incident -- a blocked payout, one needing reconciliation, or no
  // payment authority at all -- is excluded and reported separately.
  const timeliness = await one<{ eligible: number; within: number; excluded: number }>(
    `WITH owned AS (
      SELECT p.*, d.created_at AS accepted_at FROM payables p
      JOIN decisions d ON d.id=p.decision_id
      WHERE p.campaign_id IN (SELECT c.id FROM campaigns c JOIN projects q ON q.id=c.project_id
        WHERE q.workspace_id=$1)
    )
    SELECT
      count(*) FILTER (WHERE state='finalized')::int AS eligible,
      count(*) FILTER (WHERE state='finalized'
        AND finalized_at <= accepted_at + interval '60 minutes')::int AS within,
      count(*) FILTER (WHERE state IN ('blocked','needs_reconciliation'))::int AS excluded
    FROM owned`,
  );
  const incidents = (
    await db.query<{ blocked_reason: string; n: number }>(
      `SELECT COALESCE(blocked_reason,state) AS blocked_reason,count(*)::int AS n FROM payables
      WHERE state IN ('blocked','needs_reconciliation')
        AND campaign_id IN (SELECT c.id FROM campaigns c JOIN projects q ON q.id=c.project_id
          WHERE q.workspace_id=$1)
      GROUP BY 1 ORDER BY n DESC`,
      scope,
    )
  ).rows;

  // Repeat purchase: a builder publishing again within thirty days of their
  // first completed campaign. A campaign is completed when work it accepted has
  // actually been paid; nothing counts as repeat business until then.
  const repeat = await one<{ completed: number; repeated: number }>(
    `WITH finished AS (
      SELECT c.id,min(p.finalized_at) AS completed_at FROM campaigns c
      JOIN projects q ON q.id=c.project_id
      JOIN payables p ON p.campaign_id=c.id AND p.state='finalized'
      WHERE q.workspace_id=$1 GROUP BY c.id
    ), first_completion AS (
      SELECT min(completed_at) AS at FROM finished
    )
    SELECT (SELECT count(*)::int FROM finished) AS completed,
      (SELECT count(*)::int FROM campaigns c JOIN projects q ON q.id=c.project_id,
        first_completion f
        WHERE q.workspace_id=$1 AND f.at IS NOT NULL AND c.published_at > f.at
          AND c.published_at <= f.at + ($2 || ' days')::interval) AS repeated`,
    [workspaceId, String(repeatWindowDays)],
  );

  // Additional value: a defect the builder's own checks missed. Nothing records
  // that judgement, so the metric has no input rather than a low value.
  const value = await one<{ confirmed: number }>(
    `SELECT count(*)::int AS confirmed FROM defects
    WHERE state='confirmed' AND project_id IN (SELECT id FROM projects WHERE workspace_id=$1)`,
  );

  // Economics: contribution margin. Revenue is known; most of the cost side is
  // not recorded anywhere, so this reports its inputs and refuses a figure.
  const economics = await one<{ fees: string; absorbed: string; campaigns: number }>(
    `SELECT
      (SELECT COALESCE(SUM(amount_units),0)::text FROM payables
        WHERE kind='platform_fee' AND state='finalized'
          AND campaign_id IN (SELECT c.id FROM campaigns c JOIN projects q ON q.id=c.project_id
            WHERE q.workspace_id=$1)) AS fees,
      (SELECT COALESCE(SUM(cost_units),0)::text FROM resource_purchases
        WHERE charge='platform_absorbed'
          AND campaign_id IN (SELECT c.id FROM campaigns c JOIN projects q ON q.id=c.project_id
            WHERE q.workspace_id=$1)) AS absorbed,
      (SELECT count(*)::int FROM campaigns c JOIN projects q ON q.id=c.project_id
        WHERE q.workspace_id=$1 AND c.published_at IS NOT NULL) AS campaigns`,
  );
  const feeConfigured = feeRecipient() !== null;

  const usefulDelivery = ratio(delivery.accepted, delivery.decided);
  const precision = ratio(discovery.confirmed, discovery.adjudicated);
  const timely = ratio(timeliness.within, timeliness.eligible);
  const medianBurden = burden.median === null ? null : Number(burden.median);

  return [
    {
      id: 'repeat-purchase',
      name: 'Repeat purchase',
      definition: `Builders publishing another paid campaign within ${repeatWindowDays} days of their first completed one.`,
      target: `At least 3 of the first ${pilotBuilders} builders`,
      value: repeat.repeated,
      unit: 'count',
      numerator: repeat.repeated,
      denominator: repeat.completed,
      meetsTarget: repeat.completed === 0 ? null : repeat.repeated >= 3,
      // A campaign completes when it has paid for work. Nothing has.
      complete: repeat.completed > 0,
      missing:
        repeat.completed > 0
          ? []
          : [
              'No campaign has completed: completion needs a finalized payout, and no funded payment authority is configured.',
            ],
      detail: { completedCampaigns: repeat.completed, windowDays: repeatWindowDays },
    },
    {
      id: 'additional-value',
      name: 'Additional value',
      definition: 'Builders confirming a reproduced defect their existing checks missed.',
      target: `At least 3 of ${pilotBuilders} builders`,
      value: null,
      unit: 'count',
      numerator: null,
      denominator: null,
      meetsTarget: null,
      complete: false,
      missing: [
        'Whether a defect was already covered by the builder’s own checks is a judgement nobody records. Confirmed defects are counted below, but they are not the same measurement.',
      ],
      detail: { confirmedDefects: value.confirmed },
    },
    {
      id: 'useful-delivery',
      name: 'Useful delivery',
      definition:
        'Submitted assignments accepted after verification, including valid passing tests, over every submission that was decided.',
      target: 'At least 70 percent',
      value: usefulDelivery,
      unit: 'ratio',
      numerator: delivery.accepted,
      denominator: delivery.decided,
      meetsTarget: usefulDelivery === null ? null : usefulDelivery >= 0.7,
      complete: delivery.decided > 0,
      missing: delivery.decided > 0 ? [] : ['No submission has been decided yet.'],
      // The PRD asks for each rejection class to be inspected, not just a rate.
      detail: { rejected: delivery.rejected, rejectionClasses },
    },
    {
      id: 'discovery-precision',
      name: 'Discovery precision',
      definition: 'Independently confirmed unique defects over adjudicated discovery submissions.',
      target: 'At least 70 percent',
      value: precision,
      unit: 'ratio',
      numerator: discovery.confirmed,
      denominator: discovery.adjudicated,
      meetsTarget: precision === null ? null : precision >= 0.7,
      complete: discovery.adjudicated > 0,
      missing:
        discovery.adjudicated > 0 ? [] : ['No discovery submission has been adjudicated yet.'],
    },
    {
      id: 'review-burden',
      name: 'Review burden',
      definition:
        'Median minutes from a reviewer opening a submission to recording its execution decision.',
      target: 'At most 10 minutes',
      value: medianBurden,
      unit: 'minutes',
      numerator: burden.reviews,
      denominator: burden.decided,
      meetsTarget: medianBurden === null ? null : medianBurden <= 10,
      // Only reviews done through the review screen are timed at all.
      complete: burden.reviews > 0 && burden.reviews === burden.decided,
      missing:
        burden.reviews === burden.decided && burden.reviews > 0
          ? []
          : [
              `${burden.decided - burden.reviews} of ${burden.decided} execution decisions were recorded without the review screen being opened, so their review time is unknown. The attended span is also an upper bound: it includes time a reviewer spent away from the screen.`,
            ],
      detail: { timedReviews: burden.reviews, executionDecisions: burden.decided },
    },
    {
      id: 'payment-correctness',
      name: 'Payment correctness',
      definition: 'Duplicate finalized payouts, or spend past the ceiling the builder authorized.',
      target: 'Zero',
      value: correctness.duplicates + correctness.overspent,
      unit: 'count',
      numerator: correctness.duplicates + correctness.overspent,
      denominator: null,
      meetsTarget: correctness.duplicates + correctness.overspent === 0,
      // This one is complete whatever has happened: zero of nothing is zero,
      // and the ceiling invariant is a table check rather than a sample.
      complete: true,
      missing: [],
      detail: {
        duplicateFinalizedPayouts: correctness.duplicates,
        campaignsOverCeiling: correctness.overspent,
      },
    },
    {
      id: 'payment-timeliness',
      name: 'Payment timeliness',
      definition:
        'Finalized payouts reaching finality within 60 minutes of the acceptance that owed them.',
      target: 'At least 95 percent, with incidents reported separately',
      value: timely,
      unit: 'ratio',
      numerator: timeliness.within,
      denominator: timeliness.eligible,
      meetsTarget: timely === null ? null : timely >= 0.95,
      complete: timeliness.eligible > 0,
      missing:
        timeliness.eligible > 0
          ? []
          : ['No payout has reached finality, so there is no interval to measure.'],
      detail: { excludedIncidents: timeliness.excluded, incidents },
    },
    {
      id: 'economics',
      name: 'Economics',
      definition:
        'Contribution margin per campaign: collected revenue minus platform-funded compute, payout gas, verification costs, unrecovered resources, refunds and human review.',
      target: 'Nonnegative median across the final ten pilot campaigns',
      value: null,
      unit: 'units',
      numerator: null,
      denominator: economics.campaigns,
      meetsTarget: null,
      complete: false,
      missing: [
        'Platform-funded compute is not recorded: Trialoom does not run the runner host.',
        'Payout gas is not recorded: no transfer has been made.',
        'Verification cost and human review time carry no rate, so neither converts to money.',
        'Refunds do not exist as a concept in the ledger.',
        ...(feeConfigured
          ? []
          : ['No fee recipient is configured, so no revenue has been collected.']),
      ],
      // What is known is reported as its parts, never summed into a margin.
      detail: {
        currency: settlementCurrency.symbol,
        feeRevenueFinalizedUnits: economics.fees,
        unrecoveredResourceUnits: economics.absorbed,
        publishedCampaigns: economics.campaigns,
      },
    },
  ];
}

/**
 * The instrumented stream's own coverage: which topics have been seen. A metric
 * resting on a topic that has never fired is not measuring anything, and the
 * reader should be able to see that directly.
 */
export async function eventCoverage(db: Pool | PoolClient, workspaceId: string) {
  const { rows } = await db.query<{ topic: string; n: number; latest: string }>(
    `SELECT topic,count(*)::int AS n,max(occurred_at)::text AS latest FROM events
    WHERE workspace_id=$1 OR campaign_id IN
      (SELECT c.id FROM campaigns c JOIN projects q ON q.id=c.project_id WHERE q.workspace_id=$1)
    GROUP BY topic ORDER BY topic`,
    [workspaceId],
  );
  return rows;
}

/** The pilot readiness report: every target, what it rests on, and what is missing. */
export async function pilotReadiness(pool: Pool, actor: Actor, workspaceId: string) {
  const id = uuid.parse(workspaceId);
  return transaction(pool, async (db) => {
    const role = await requireRole(db, actor, id, ['owner', 'member', 'reviewer']);
    const metrics = await pilotMetrics(db, id);
    const coverage = await eventCoverage(db, id);
    if (role === 'reviewer') await audit(db, id, actor.id, 'reviewer.metrics_read', id);
    const measurable = metrics.filter((metric) => metric.complete);
    return {
      metrics,
      coverage,
      summary: {
        targets: metrics.length,
        measurable: measurable.length,
        meeting: measurable.filter((metric) => metric.meetsTarget === true).length,
        failing: measurable.filter((metric) => metric.meetsTarget === false).length,
        unmeasurable: metrics.length - measurable.length,
      },
      note: 'A target whose inputs do not exist reports what is missing instead of a number. An exit gate read off an incomplete figure is worse than an openly empty one.',
    };
  });
}
