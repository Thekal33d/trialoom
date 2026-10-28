'use client';
import { useCallback, useEffect, useState } from 'react';
import { formatUnits } from '@/domain/values';
import { api } from './live-types';

type Attention = {
  awaiting_decision: number;
  waiting_since: string | null;
  waitingHours: number | null;
  pastReviewTarget: boolean;
  pastEscalation: boolean;
  flagged_defects: number;
  ungrouped_reports: number;
  open_appeals: number;
  appeal_due: string | null;
  repairs_awaiting_verification: number;
  quotes_awaiting_approval: number;
  blocked_payouts: number;
  payouts_needing_reconciliation: number;
  owed_units: string;
  resources_unreconciled: number;
  live_assignments: number;
};
type Queue = {
  campaigns: {
    id: string;
    name: string;
    status: string;
    project: string;
    pending: number;
    attention: Attention | null;
  }[];
  totals: {
    awaitingDecision: number;
    ungroupedReports: number;
    flaggedDefects: number;
    openAppeals: number;
    quotesAwaitingApproval: number;
    repairsAwaitingVerification: number;
    blockedPayouts: number;
    payoutsNeedingReconciliation: number;
    resourcesUnreconciled: number;
    owedUnits: string;
    pastReviewTarget: number;
    pastEscalation: number;
    longestWaitHours: number | null;
  };
  policy: { reviewTargetHours: number; escalationHours: number; appealWindowHours: number };
  note: string;
};
const money = (value: string) => `${formatUnits(value)} USDC`;

/** Each line is only shown when it has something waiting. */
function Waiting({ attention }: { attention: Attention }) {
  const lines: string[] = [];
  const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  if (attention.awaiting_decision)
    lines.push(
      `${plural(attention.awaiting_decision, 'submission', 'submissions')} awaiting your decision${
        attention.waitingHours === null ? '' : `, the oldest for ${attention.waitingHours}h`
      }`,
    );
  if (attention.ungrouped_reports)
    lines.push(
      `${plural(attention.ungrouped_reports, 'report', 'reports')} clustering could not group`,
    );
  if (attention.flagged_defects)
    lines.push(`${plural(attention.flagged_defects, 'defect', 'defects')} flagged for review`);
  if (attention.open_appeals)
    lines.push(`${plural(attention.open_appeals, 'appeal', 'appeals')} open`);
  if (attention.quotes_awaiting_approval)
    lines.push(
      `${plural(attention.quotes_awaiting_approval, 'repair quote', 'repair quotes')} awaiting approval`,
    );
  if (attention.repairs_awaiting_verification)
    lines.push(
      `${plural(attention.repairs_awaiting_verification, 'repair', 'repairs')} awaiting independent verification`,
    );
  if (attention.blocked_payouts)
    lines.push(`${plural(attention.blocked_payouts, 'payout', 'payouts')} blocked and still owed`);
  if (attention.payouts_needing_reconciliation)
    lines.push(
      `${plural(attention.payouts_needing_reconciliation, 'payout', 'payouts')} needing reconciliation`,
    );
  if (attention.resources_unreconciled)
    lines.push(
      `${plural(attention.resources_unreconciled, 'resource purchase', 'resource purchases')} holding a reservation`,
    );
  if (!lines.length)
    lines.push(
      attention.live_assignments
        ? `${plural(attention.live_assignments, 'assignment', 'assignments')} running; nothing waiting on you`
        : 'Nothing waiting on you',
    );
  return (
    <ul className="waiting-list">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/**
 * One queue that answers what is waiting and on whom. Owners and members see
 * their own work; a reviewer sees the same list, busiest first.
 */
export function AttentionPanel({ base, role }: { base: string; role: string }) {
  const [queue, setQueue] = useState<Queue>();
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setQueue(await api<Queue>(`${base}/attention`));
  }, [base]);
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'The queue is unavailable.'));
  }, [load]);
  if (error)
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  if (!queue) return <p className="section-description">Loading what is waiting…</p>;
  const { totals, policy } = queue;
  return (
    <section className="attention-panel">
      <div className="section-heading">
        <h3>{role === 'reviewer' ? 'Review queue' : "What's waiting"}</h3>
        <span className="neutral-label">
          {queue.campaigns.filter((campaign) => campaign.pending > 0).length} of{' '}
          {queue.campaigns.length} briefs need attention
        </span>
      </div>
      <p className="section-description">
        {queue.note} A submission is awaiting review for {policy.reviewTargetHours} hours before it
        is late, and {policy.escalationHours} hours of silence escalates it to a platform reviewer
        rather than deciding it.
      </p>
      <div className="project-context">
        <span>
          Awaiting a decision<strong>{totals.awaitingDecision}</strong>
        </span>
        <span>
          Past the review target<strong>{totals.pastReviewTarget}</strong>
        </span>
        <span>
          Escalated<strong>{totals.pastEscalation}</strong>
        </span>
        <span>
          Open appeals<strong>{totals.openAppeals}</strong>
        </span>
        <span>
          Blocked payouts<strong>{totals.blockedPayouts}</strong>
        </span>
        <span>
          Owed, unpaid<strong>{money(totals.owedUnits)}</strong>
        </span>
      </div>
      {totals.pastEscalation > 0 && (
        <p className="section-description" role="status">
          {totals.pastEscalation === 1 ? 'One brief has' : `${totals.pastEscalation} briefs have`}{' '}
          waited past {policy.escalationHours} hours. A platform reviewer takes these up; the work
          is neither accepted nor refused by the delay.
        </p>
      )}
      {!queue.campaigns.length && (
        <p className="section-description">
          No brief is published yet, so nothing can be waiting. Publish one to offer it to
          operators.
        </p>
      )}
      <div className="record-list">
        {queue.campaigns.map((campaign) => (
          <div className="member-row" key={campaign.id}>
            <div>
              <strong>
                {campaign.name} · {campaign.project}
              </strong>
              {campaign.attention && <Waiting attention={campaign.attention} />}
              {campaign.attention && BigInt(campaign.attention.owed_units) > 0n && (
                <p className="subtle">
                  {money(campaign.attention.owed_units)} accepted and not yet paid
                </p>
              )}
            </div>
            <span className="neutral-label">
              {campaign.attention?.pastEscalation
                ? 'escalated'
                : campaign.attention?.pastReviewTarget
                  ? 'review late'
                  : campaign.pending
                    ? `${campaign.pending} waiting`
                    : campaign.status}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
