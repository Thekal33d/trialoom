'use client';
import { useCallback, useEffect, useState } from 'react';
import { formatUnits, toUnits } from '@/domain/values';
import { api, field } from './live-types';

type Quote = {
  id: string;
  handle: string;
  defect_title: string;
  repair_state: string;
  base_revision: string;
  amount_units: string;
  scope_paths: string[];
  state: 'proposed' | 'approved' | 'rejected' | 'withdrawn';
  decided_reason: string | null;
};
type Repair = {
  id: string;
  handle: string;
  base_revision: string;
  candidate_revision: string;
  changed_files: { path: string }[];
  patch_sha256: string;
  gate_detail: string;
  created_at: string;
};
type Verification = {
  id: string;
  handle: string;
  outcome: 'confirmed' | 'refuted' | 'inconclusive';
  detail: string;
  created_at: string;
};
type RepairRecord = {
  quote: Quote | null;
  repair: Repair | null;
  verifications: Verification[];
  candidates: {
    defects: { id: string; title: string; build_id: string }[];
    operators: { id: string; handle: string }[];
  } | null;
  note: string;
};
const money = (value: string) => `${formatUnits(value)} USDC`;
const states: Record<string, string> = {
  none: 'No repair quoted',
  quoted: 'Quote approved, awaiting delivery',
  delivered: 'Delivered for builder review',
  verified: 'Independently confirmed',
  accepted: 'Accepted and owed',
};

/**
 * The repair record for one brief: its quote, the delivered patch, and every
 * independent verification of it. Nothing here merges or deploys a repair.
 */
export function RepairPanel({
  base,
  campaignId,
  buildId,
  isOwner,
  reload,
}: {
  base: string;
  campaignId: string;
  buildId: string | undefined;
  isOwner: boolean;
  reload: () => Promise<void>;
}) {
  const campaignBase = `${base}/campaigns/${campaignId}`;
  const [record, setRecord] = useState<RepairRecord>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const load = useCallback(async () => {
    setRecord(await api<RepairRecord>(`${campaignBase}/repairs`));
  }, [campaignBase]);
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Repair record unavailable.'));
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
  // A repair brief without a readable record is a fact worth showing, not a
  // blank: the brief cannot be claimed until its quote is approved.
  if (!record)
    return error ? (
      <section className="evidence-block">
        <h5>Repair</h5>
        <p className="form-error" role="alert">
          {error}
        </p>
      </section>
    ) : null;
  const { quote, repair, verifications, candidates } = record;
  const confirmed = verifications.filter((item) => item.outcome === 'confirmed').length;
  return (
    <section className="evidence-block">
      <div className="section-heading">
        <h5>Repair</h5>
        {isOwner && !quote && candidates && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setQuoting(!quoting);
              setError('');
            }}
          >
            {quoting ? 'Cancel' : 'Quote a repair'}
          </button>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="section-description">{record.note}</p>
      {!quote && (
        <p className="section-description">
          This brief has no approved quote, so it cannot be published and no operator can claim it.
          A repair is quoted against one confirmed defect, one pinned build, and the paths it may
          change.
          {candidates && !candidates.defects.length
            ? ' No defect in this project is confirmed yet.'
            : ''}
        </p>
      )}
      {quoting && candidates && (
        <form
          className="app-form editor-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void run(async () => {
              await api(`${base}/repair-quotes`, 'POST', {
                campaignId,
                defectId: field(form, 'defectId'),
                operatorId: field(form, 'operatorId'),
                baseBuildId: field(form, 'baseBuildId'),
                amountUnits: toUnits(field(form, 'amount')),
                scopePaths: field(form, 'scopePaths')
                  .split('\n')
                  .map((path) => path.trim())
                  .filter(Boolean),
              });
              setQuoting(false);
            }, 'The repair could not be quoted.');
          }}
        >
          <label>
            Defect to repair
            <select name="defectId" required defaultValue={candidates.defects[0]?.id}>
              {candidates.defects.map((defect) => (
                <option key={defect.id} value={defect.id}>
                  {defect.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Operator to commission
            <select name="operatorId" required defaultValue={candidates.operators[0]?.id}>
              {candidates.operators.map((operator) => (
                <option key={operator.id} value={operator.id}>
                  @{operator.handle}
                </option>
              ))}
            </select>
          </label>
          <input type="hidden" name="baseBuildId" value={buildId ?? ''} />
          <label>
            Quoted amount (USDC)
            <input name="amount" inputMode="decimal" defaultValue="5" required />
          </label>
          <label>
            Paths this repair may change, one per line
            <textarea name="scopePaths" rows={4} required defaultValue={'src/\ntests/'} />
          </label>
          <small>
            Publishing this brief will be refused unless its terms price the repair at exactly this
            amount and pin this build. Anything changed outside these paths is refused on delivery.
          </small>
          <button type="submit" className="button primary" disabled={busy}>
            Propose quote
          </button>
        </form>
      )}
      {quote && (
        <div className="editor-panel">
          <div className="section-heading">
            <h5>
              @{quote.handle} · {money(quote.amount_units)}
            </h5>
            <span className="neutral-label">{quote.state}</span>
          </div>
          <p>{quote.defect_title}</p>
          <p className="section-description">
            Base revision <code>{quote.base_revision}</code> · scope {quote.scope_paths.join(', ')}{' '}
            · {states[quote.repair_state] ?? quote.repair_state}
            {quote.decided_reason ? ` · ${quote.decided_reason}` : ''}
          </p>
          {isOwner && quote.state === 'proposed' && (
            <div className="status-actions">
              {(['approved', 'rejected'] as const).map((outcome) => (
                <button
                  key={outcome}
                  type="button"
                  className={outcome === 'approved' ? 'button primary' : 'text-button'}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`${base}/repair-quotes/${quote.id}`, 'POST', {
                        outcome,
                        reason:
                          outcome === 'approved'
                            ? 'Approved by the workspace owner against the confirmed defect.'
                            : 'Rejected by the workspace owner.',
                      });
                    }, 'The quote decision could not be recorded.')
                  }
                >
                  {outcome === 'approved' ? 'Approve quote' : 'Reject'}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {repair && (
        <div className="editor-panel">
          <div className="section-heading">
            <h5>@{repair.handle} delivered a patch</h5>
            <span className="neutral-label">gate passed</span>
          </div>
          <p className="section-description">
            <code>{repair.base_revision}</code> → <code>{repair.candidate_revision}</code> ·{' '}
            {repair.changed_files.length} file
            {repair.changed_files.length === 1 ? '' : 's'} · patch{' '}
            <code>{repair.patch_sha256.slice(0, 12)}</code>
          </p>
          <p>{repair.gate_detail}</p>
          <p className="section-description">
            {confirmed
              ? `${confirmed} independent confirmation${confirmed === 1 ? '' : 's'}; this repair can be accepted.`
              : 'No independent confirmation yet, so this repair cannot be accepted.'}
          </p>
          <div className="record-list">
            {verifications.map((item) => (
              <div className="member-row" key={item.id}>
                <div>
                  <strong>@{item.handle}</strong>
                  <p>{item.detail}</p>
                </div>
                <span className="neutral-label">{item.outcome}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
