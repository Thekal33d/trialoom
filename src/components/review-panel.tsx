'use client';
import { useCallback, useEffect, useState } from 'react';
import { formatUnits, toUnits } from '@/domain/values';
import { api, field } from './live-types';

type Finding = {
  id: string;
  defect_id: string | null;
  assignment_id: string;
  submission_id: string;
  title: string;
  handle: string;
  match: 'first' | 'exact' | 'uncertain';
  independent: boolean;
  independence_reason: string | null;
  proposed_severity: string | null;
  severity: string | null;
  defect_state: string | null;
  review_flag: string | null;
  awarded_finding_id: string | null;
  candidate_defect_ids: string[];
  reports: number | null;
  independent_reports: number | null;
};
type Defect = {
  id: string;
  title: string;
  state: string;
  severity: string | null;
  review_flag: string | null;
};
type Decision = {
  id: string;
  subject_id: string;
  matter: string;
  outcome: string;
  reason: string;
  criteria: string;
  amount_units: string | null;
  actor_role: string;
  actor_name: string;
  created_at: string;
  assignment_id: string;
};
type Review = { findings: Finding[]; defects: Defect[]; decisions: Decision[]; note: string };
type Submission = { id: string; assignment_id: string; handle: string; outcome: string };

const flags: Record<string, string> = {
  uncertain_duplicate: 'Needs a grouping decision: same failing assertions, different detail.',
  independence_failed: 'A linked operator reported this, so it is not independent reproduction.',
  inconsistent_result: 'A clean run contradicted this defect. Potentially flaky.',
};
const matches: Record<string, string> = {
  first: 'First report of this defect',
  exact: 'Same failure signature',
  uncertain: 'Unclustered: needs a grouping decision',
};

/** Reports, how they were clustered, and every decision recorded against them. */
export function ReviewPanel({
  campaignBase,
  submissions,
  canDecide,
  reload,
}: {
  campaignBase: string;
  submissions: Submission[];
  canDecide: boolean;
  reload: () => Promise<void>;
}) {
  const [review, setReview] = useState<Review>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState('');
  const load = useCallback(async () => {
    setReview(await api<Review>(`${campaignBase}/review`));
  }, [campaignBase]);
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Review unavailable.'));
  }, [load]);
  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError('');
    try {
      await work();
      await load();
      await reload();
      setOpen('');
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  }
  const decided = new Set(
    review?.decisions
      .filter((decision) => decision.matter === 'execution')
      .map((decision) => decision.assignment_id) ?? [],
  );
  const rewarded = new Set(
    review?.decisions
      .filter((decision) => decision.matter === 'discovery')
      .map((decision) => decision.subject_id) ?? [],
  );
  if (!review) return null;
  return (
    <div className="review-block">
      <h5>Reports and decisions</h5>
      <p className="section-description">{review.note}</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {review.findings.map((finding) => {
        const settled = rewarded.has(finding.id);
        return (
          <div className="editor-panel" key={finding.id}>
            <div className="section-heading">
              <h5>
                @{finding.handle} · {finding.title}
              </h5>
              <span className="neutral-label">{finding.defect_state ?? 'ungrouped'}</span>
            </div>
            <p className="section-description">
              {matches[finding.match]}
              {finding.reports
                ? ` · ${finding.reports} report${finding.reports === 1 ? '' : 's'}`
                : ''}
              {finding.independent_reports
                ? ` · ${finding.independent_reports} independent`
                : ' · no independent reproduction yet'}
              {finding.severity ? ` · severity ${finding.severity}` : ''}
              {finding.proposed_severity && !finding.severity
                ? ` · operator proposed ${finding.proposed_severity}`
                : ''}
              {finding.awarded_finding_id === finding.id ? ' · discovery reward awarded' : ''}
            </p>
            {finding.independence_reason && (
              <p className="section-description">{finding.independence_reason}</p>
            )}
            {finding.review_flag && (
              <p className="form-error" role="status">
                {flags[finding.review_flag]}
              </p>
            )}
            {canDecide && !settled && (
              <div className="status-actions">
                {finding.match === 'uncertain' && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      setOpen(open === `group-${finding.id}` ? '' : `group-${finding.id}`)
                    }
                  >
                    Group this report
                  </button>
                )}
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    setOpen(open === `reward-${finding.id}` ? '' : `reward-${finding.id}`)
                  }
                >
                  Discovery decision
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    setOpen(open === `severity-${finding.id}` ? '' : `severity-${finding.id}`)
                  }
                >
                  Set severity
                </button>
              </div>
            )}
            {open === `group-${finding.id}` && (
              <form
                className="app-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void run(async () => {
                    await api(`${campaignBase}/findings/${finding.id}/duplicate`, 'POST', {
                      defectId: field(form, 'defectId') || null,
                      reason: field(form, 'reason'),
                      evidenceRefs: [finding.submission_id],
                    });
                  }, 'The grouping could not be recorded.');
                }}
              >
                <label>
                  Group into
                  <select name="defectId" defaultValue="">
                    <option value="">Keep as its own defect</option>
                    {review.defects
                      .filter((defect) => finding.candidate_defect_ids.includes(defect.id))
                      .map((defect) => (
                        <option key={defect.id} value={defect.id}>
                          {defect.title}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Reason
                  <textarea name="reason" required minLength={3} maxLength={2000} rows={2} />
                </label>
                <button type="submit" className="button primary" disabled={busy}>
                  Record grouping
                </button>
              </form>
            )}
            {open === `reward-${finding.id}` && (
              <form
                className="app-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const amount = field(form, 'amount');
                  void run(async () => {
                    await api(`${campaignBase}/findings/${finding.id}/discovery`, 'POST', {
                      outcome: field(form, 'outcome'),
                      ...(field(form, 'outcome') === 'awarded' && amount
                        ? { amountUnits: toUnits(amount) }
                        : {}),
                      reason: field(form, 'reason'),
                      evidenceRefs: [finding.submission_id],
                    });
                  }, 'The discovery decision could not be recorded.');
                }}
              >
                <label>
                  Outcome
                  <select name="outcome" defaultValue="awarded">
                    <option value="awarded">Award the discovery reward</option>
                    <option value="declined">Decline the reward</option>
                  </select>
                </label>
                <label>
                  Reward (USDC, up to the published cap)
                  <input name="amount" inputMode="decimal" placeholder="1" />
                </label>
                <label>
                  Reason, against the published rubric
                  <textarea name="reason" required minLength={3} maxLength={2000} rows={2} />
                </label>
                <button type="submit" className="button primary" disabled={busy}>
                  Record decision
                </button>
              </form>
            )}
            {open === `severity-${finding.id}` && (
              <form
                className="app-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void run(async () => {
                    await api(`${campaignBase}/findings/${finding.id}/severity`, 'POST', {
                      severity: field(form, 'severity'),
                      reason: field(form, 'reason'),
                      evidenceRefs: [],
                    });
                  }, 'The severity could not be recorded.');
                }}
              >
                <label>
                  Severity
                  <select name="severity" defaultValue="major">
                    <option value="blocking">Blocking a core journey</option>
                    <option value="major">Materially incorrect with a workaround</option>
                    <option value="minor">Minor in-scope defect</option>
                  </select>
                </label>
                <label>
                  Reason
                  <textarea name="reason" required minLength={3} maxLength={2000} rows={2} />
                </label>
                <button type="submit" className="button primary" disabled={busy}>
                  Record severity
                </button>
              </form>
            )}
          </div>
        );
      })}
      {canDecide &&
        submissions
          .filter((submission) => !decided.has(submission.assignment_id))
          .map((submission) => (
            <div className="editor-panel" key={submission.id}>
              <div className="section-heading">
                <h5>@{submission.handle} · execution not decided</h5>
                <span className="neutral-label">{submission.outcome}</span>
              </div>
              <form
                className="app-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const amount = field(form, 'amount');
                  void run(async () => {
                    await api(
                      `${campaignBase}/assignments/${submission.assignment_id}/execution`,
                      'POST',
                      {
                        outcome: field(form, 'outcome'),
                        ...(field(form, 'outcome') === 'accepted' && amount
                          ? { amountUnits: toUnits(amount) }
                          : {}),
                        reason: field(form, 'reason'),
                        evidenceRefs: [submission.id],
                      },
                    );
                  }, 'The execution decision could not be recorded.');
                }}
              >
                <label>
                  Outcome
                  <select name="outcome" defaultValue="accepted">
                    <option value="accepted">Accept the execution</option>
                    <option value="rejected">Refuse the execution</option>
                  </select>
                </label>
                <label>
                  Amount (USDC, defaults to the published execution price)
                  <input name="amount" inputMode="decimal" placeholder="2" />
                </label>
                <label>
                  Reason, against the pinned acceptance criteria
                  <textarea name="reason" required minLength={3} maxLength={2000} rows={2} />
                </label>
                <small>
                  A refusal keeps its reservation while the operator can still appeal it.
                </small>
                <button type="submit" className="button primary" disabled={busy}>
                  Record decision
                </button>
              </form>
            </div>
          ))}
      {review.decisions.length > 0 && (
        <ul className="decision-trail">
          {review.decisions.map((decision) => (
            <li key={decision.id}>
              <div>
                <strong>
                  {decision.matter} {decision.outcome}
                </strong>
                {decision.amount_units && decision.amount_units !== '0'
                  ? ` · ${formatUnits(decision.amount_units)} USDC`
                  : ''}
                <p>{decision.reason}</p>
                <p className="subtle">
                  Criteria applied: {decision.criteria} · {decision.actor_name} (
                  {decision.actor_role}) · {new Date(decision.created_at).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!review.findings.length && !review.decisions.length && (
        <p className="section-description">No report or decision has been recorded yet.</p>
      )}
    </div>
  );
}
