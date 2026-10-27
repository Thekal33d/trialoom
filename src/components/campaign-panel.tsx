'use client';
import { useCallback, useEffect, useState } from 'react';
import { formatUnits, toUnits } from '@/domain/values';
import { api, type CampaignRecord, field, type TermsRecord } from './live-types';
import { ReviewPanel } from './review-panel';

type Accounting = {
  ceilingUnits: string;
  committedUnits: string;
  acceptedUnits: string;
  finalizedUnits: string;
  availableUnits: string;
  reconciled: boolean;
  byCategory: { category: string; committed: string; accepted: string }[];
};
type Ledger = {
  campaign: {
    status: string;
    slots: number | null;
    maxConcurrent: number | null;
    publishedTermsId: string | null;
    latestVersion: number;
  };
  accounting: Accounting | null;
  assignments: {
    id: string;
    state: string;
    handle: string;
    max_liability_units: string;
    accepted_units: string | null;
    lease_expires_at: string;
    deadline: string;
    closed_reason: string | null;
  }[];
};
type Artifact = {
  id: string;
  name: string;
  kind: string;
  bytes: string;
  sha256: string;
  reviewable: boolean;
  redaction: { mode?: string; decision?: string; reason?: string };
};
type Payout = {
  id: string;
  handle: string;
  kind: 'operator' | 'platform_fee';
  category: string;
  amount_units: string;
  recipient_address: string | null;
  state: string;
  blocked_reason: string | null;
  transaction_hash: string | null;
  included_at: string | null;
  finalized_at: string | null;
};
type Submissions = {
  runs: {
    id: string;
    assignment_id: string;
    state: string;
    handle: string;
    issued_at: string;
    closed_reason: string | null;
    artifact_count: number;
    target_check: {
      finalUrl: string;
      hops: { url: string; status: number }[];
      revisionConfirmed: boolean;
      targetHealthy: boolean;
      addressesChanged: boolean;
    };
  }[];
  submissions: {
    id: string;
    assignment_id: string;
    handle: string;
    outcome: string;
    blocked_reason: string | null;
    content_hash: string;
    artifact_count: number;
    total_bytes: string;
    started_at: string;
    finished_at: string;
    submitted_at: string;
    assignment_state: string;
    decisions: { matter: string; outcome: string; amountUnits: string | null }[] | null;
    document: { summary: string; steps: { status: string }[] };
    artifacts: Artifact[];
  }[];
};
const money = (value: string) => `${formatUnits(value)} USDC`;
const outcomes: Record<string, string> = {
  executed: 'Executed as assigned',
  product_failed: 'Reported a product failure',
  blocked: 'Blocked run, not a product defect',
};

/** Publication, budget, and the campaign's accounting. Only an owner can change money. */
export function CampaignPanel({
  base,
  campaign,
  versions,
  isOwner,
  canDecide,
  reload,
}: {
  base: string;
  campaign: CampaignRecord;
  versions: TermsRecord[];
  isOwner: boolean;
  // Owners and reviewers record decisions; a member can read but not decide.
  canDecide: boolean;
  reload: () => Promise<void>;
}) {
  const campaignBase = `${base}/campaigns/${campaign.id}`;
  const [ledger, setLedger] = useState<Ledger>();
  const [evidence, setEvidence] = useState<Submissions>();
  const [payouts, setPayouts] = useState<{ payouts: Payout[]; note: string }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const load = useCallback(async () => {
    setLedger(await api<Ledger>(`${campaignBase}/ledger`));
    setEvidence(await api<Submissions>(`${campaignBase}/submissions`));
    setPayouts(await api<{ payouts: Payout[]; note: string }>(`${campaignBase}/payouts`));
  }, [campaignBase]);
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Ledger unavailable.'));
  }, [load]);
  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError('');
    try {
      await work();
      await load();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  }
  const status = ledger?.campaign.status ?? campaign.status;
  const published = status !== 'draft';
  const accounting = ledger?.accounting;
  return (
    <section className="campaign-ledger">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="section-heading">
        <h4>Budget and assignments</h4>
        {isOwner && (
          <button
            type="button"
            className="button secondary"
            disabled={busy || ['cancelled', 'completed'].includes(status)}
            onClick={() => {
              setPublishing(!publishing);
              setError('');
            }}
          >
            {publishing ? 'Cancel' : published ? 'Republish terms' : 'Publish to operators'}
          </button>
        )}
      </div>
      {!published && (
        <p className="section-description">
          A draft is not claimable. Publishing offers one exact terms version and reserves its
          maximum liability from an authorized budget as operators claim it.
        </p>
      )}
      {publishing && (
        <form
          className="app-form editor-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void run(async () => {
              await api(`${campaignBase}/publication`, 'POST', {
                termsVersionId: field(form, 'termsVersionId'),
                slots: Number(field(form, 'slots')),
                maxConcurrent: Number(field(form, 'maxConcurrent')),
                authorizeUnits: toUnits(field(form, 'authorize') || '0'),
                spendingAuthorization: field(form, 'spendingAuthorization'),
                authorizationConfirmed: form.get('authorizationConfirmed') === 'on',
              });
              setPublishing(false);
            }, 'The brief could not be published.');
          }}
        >
          <label>
            Terms version to offer
            <select name="termsVersionId" defaultValue={versions[0]?.id}>
              {versions.map((term) => (
                <option key={term.id} value={term.id}>
                  Version {term.version} · {money(term.document.priceUnits)}
                </option>
              ))}
            </select>
          </label>
          <div className="form-pair">
            <label>
              Assignment slots
              <input name="slots" type="number" min={1} max={1000} defaultValue={1} required />
            </label>
            <label>
              Concurrent assignments
              <input
                name="maxConcurrent"
                type="number"
                min={1}
                max={100}
                defaultValue={1}
                required
              />
            </label>
          </div>
          <label>
            Authorize additional budget (USDC)
            <input name="authorize" inputMode="decimal" defaultValue={published ? '0' : '20'} />
          </label>
          <label>
            Spending authorization reference
            <input
              name="spendingAuthorization"
              required
              maxLength={200}
              placeholder="Your Remesso policy reference"
            />
          </label>
          <small>
            This records the authorization you configured; it is not escrow and no funds are held
            here. Accepted work stays owed even if the authorization is later revoked.
          </small>
          <label className="check-field">
            <input name="authorizationConfirmed" type="checkbox" required />I authorize spending up
            to this campaign ceiling for work delivered under these terms.
          </label>
          <button type="submit" className="button primary" disabled={busy}>
            {published ? 'Republish' : 'Publish'}
          </button>
        </form>
      )}
      {accounting && (
        <>
          <div className="project-context">
            <span>
              Ceiling<strong>{money(accounting.ceilingUnits)}</strong>
            </span>
            <span>
              Committed<strong>{money(accounting.committedUnits)}</strong>
            </span>
            <span>
              Accepted, unpaid<strong>{money(accounting.acceptedUnits)}</strong>
            </span>
            <span>
              Finalized<strong>{money(accounting.finalizedUnits)}</strong>
            </span>
            <span>
              Available<strong>{money(accounting.availableUnits)}</strong>
            </span>
            <span>
              Slots
              <strong>
                {ledger?.assignments.filter((item) =>
                  ['claimed', 'running', 'submitted', 'accepted'].includes(item.state),
                ).length ?? 0}{' '}
                of {ledger?.campaign.slots ?? 0} taken
              </strong>
            </span>
          </div>
          <p className="section-description">
            {accounting.reconciled
              ? 'Every entry in the ledger replays to these balances.'
              : 'These balances do not match the ledger entries. Do not act on them.'}{' '}
            Committed amounts are reservations for live assignments, not payments. Nothing here has
            been paid: accepted amounts are recorded as owed, and settlement is not implemented.
          </p>
          {ledger?.campaign.latestVersion !== undefined &&
            versions[0] &&
            ledger.campaign.publishedTermsId !== versions[0].id && (
              <p className="section-description">
                The offered terms are not the latest version. Existing assignments keep the version
                they pinned; republish to offer version {versions[0].version} to new claims.
              </p>
            )}
          <div className="record-list">
            {ledger?.assignments.map((assignment) => (
              <div className="member-row" key={assignment.id}>
                <div>
                  <strong>@{assignment.handle}</strong>
                  <p>
                    Reserves {money(assignment.max_liability_units)} ·{' '}
                    {['claimed', 'running'].includes(assignment.state)
                      ? `lease until ${new Date(assignment.lease_expires_at).toLocaleString()}`
                      : (assignment.closed_reason ?? 'closed')}
                  </p>
                </div>
                <span className="neutral-label">{assignment.state}</span>
              </div>
            ))}
          </div>
          {!ledger?.assignments.length && (
            <p className="section-description">No operator has claimed this work yet.</p>
          )}
          {Boolean(evidence?.runs.length || evidence?.submissions.length) && evidence && (
            <div className="evidence-block">
              <h5>Execution and evidence</h5>
              <p className="section-description">
                Raw artifacts stay private, and only a verified redacted copy can be opened. An
                accepted amount is owed and unpaid: payouts are not implemented.
              </p>
              {evidence.runs.map((item) => (
                <div className="member-row" key={item.id}>
                  <div>
                    <strong>@{item.handle}</strong>
                    <p>
                      Target rechecked at {item.target_check.hops.length} hop
                      {item.target_check.hops.length === 1 ? '' : 's'} ·{' '}
                      {item.target_check.revisionConfirmed
                        ? 'revision confirmed'
                        : 'revision not exposed by the target'}
                      {item.target_check.targetHealthy ? '' : ' · target returned a server error'}
                      {item.target_check.addressesChanged
                        ? ' · addresses changed since pinning'
                        : ''}{' '}
                      · {item.artifact_count} artifact{item.artifact_count === 1 ? '' : 's'}
                    </p>
                  </div>
                  <span className="neutral-label">run {item.state}</span>
                </div>
              ))}
              {evidence.submissions.map((submission) => (
                <div className="editor-panel" key={submission.id}>
                  <div className="section-heading">
                    <h5>
                      @{submission.handle} · {outcomes[submission.outcome] ?? submission.outcome}
                    </h5>
                    <span className="neutral-label">
                      {submission.decisions?.length
                        ? `${submission.decisions.length} decision${submission.decisions.length === 1 ? '' : 's'}`
                        : 'Pending review'}
                    </span>
                  </div>
                  <p>{submission.document.summary}</p>
                  <p className="section-description">
                    {submission.document.steps.length} recorded step
                    {submission.document.steps.length === 1 ? '' : 's'} ·{' '}
                    {submission.artifact_count} artifact
                    {submission.artifact_count === 1 ? '' : 's'} · evidence hash{' '}
                    <code>{submission.content_hash.slice(0, 12)}</code>
                    {submission.blocked_reason ? ` · ${submission.blocked_reason}` : ''}
                  </p>
                  <ul className="artifact-list">
                    {submission.artifacts.map((artifact) => (
                      <li key={artifact.id}>
                        <span>
                          {artifact.name} · {artifact.kind} · {artifact.bytes} bytes
                        </span>
                        {artifact.reviewable ? (
                          <a
                            className="text-button"
                            href={`${campaignBase}/artifacts/${artifact.id}`}
                          >
                            Open redacted copy
                          </a>
                        ) : (
                          <span className="subtle">
                            {artifact.redaction.reason ?? 'Private: no redacted copy exists.'}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {Boolean(payouts?.payouts.length) && payouts && (
                <div className="payout-block">
                  <h5>Payments</h5>
                  <p className="section-description">{payouts.note}</p>
                  <div className="record-list">
                    {payouts.payouts.map((payout) => (
                      <div className="member-row" key={payout.id}>
                        <div>
                          <strong>
                            {payout.kind === 'platform_fee'
                              ? 'Platform fee'
                              : `@${payout.handle} · ${payout.category}`}
                          </strong>
                          <p>
                            {money(payout.amount_units)}
                            {payout.recipient_address
                              ? ` · to ${payout.recipient_address.slice(0, 10)}…`
                              : ' · no recipient fixed yet'}
                            {payout.blocked_reason
                              ? ` · ${payout.blocked_reason.replaceAll('_', ' ')}`
                              : ''}
                          </p>
                          {payout.transaction_hash && (
                            <p className="subtle">
                              {payout.transaction_hash.slice(0, 14)}… ·{' '}
                              {payout.finalized_at
                                ? 'finalized'
                                : payout.included_at
                                  ? 'included, awaiting finality'
                                  : 'submitted'}
                            </p>
                          )}
                        </div>
                        <span className="neutral-label">{payout.state.replaceAll('_', ' ')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <ReviewPanel
                campaignBase={campaignBase}
                submissions={evidence.submissions.map((submission) => ({
                  id: submission.id,
                  assignment_id: submission.assignment_id,
                  handle: submission.handle,
                  outcome: submission.outcome,
                }))}
                canDecide={canDecide}
                reload={load}
              />
            </div>
          )}
          {isOwner && !['cancelled', 'completed'].includes(status) && (
            <div className="status-actions">
              {status === 'paused' ? (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`${campaignBase}/status`, 'POST', {
                        status: 'open',
                        reason: 'Reopened by the workspace owner',
                      });
                    }, 'The campaign could not reopen.')
                  }
                >
                  Reopen for claims
                </button>
              ) : (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`${campaignBase}/status`, 'POST', {
                        status: 'paused',
                        reason: 'Paused by the workspace owner',
                      });
                    }, 'The campaign could not pause.')
                  }
                >
                  Pause new claims
                </button>
              )}
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`${campaignBase}/status`, 'POST', {
                      status: 'cancelled',
                      reason: 'Cancelled by the workspace owner',
                    });
                  }, 'The campaign could not be cancelled.')
                }
              >
                Cancel campaign
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
