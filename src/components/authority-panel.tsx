'use client';
import { useCallback, useEffect, useState } from 'react';
import { formatUnits, toUnits } from '@/domain/values';
import { api, field } from './live-types';
import { PaymentSetup } from './payment-setup';

type Approval = {
  approvalId: string;
  payerAddress: string;
  declaredUnits: string;
  committedUnits: string;
  settledUnits: string;
  uncommittedUnits: string;
  observedAllowanceUnits: string | null;
  observedBalanceUnits: string | null;
  observedAt: string | null;
  shortfallUnits: string | null;
  state: 'declared' | 'verified' | 'short' | 'revoked';
  lastReadAttemptedAt: string | null;
  lastReadError: string | null;
  readingAgeHours: number | null;
  stale: boolean;
};
type Authority = {
  id: string;
  reference: string;
  provider: string;
  policyId: string;
  agentAddress: string;
  revokedAt: string | null;
  revokedReason: string | null;
  campaigns: number;
  approval: Approval;
};
type Authorities = {
  authorities: Authority[];
  currency: { symbol: string; decimals: number };
  note: string;
};

const states: Record<Approval['state'], string> = {
  declared: 'declared, never read from the chain',
  verified: 'read from the chain and covering its commitments',
  short: 'read from the chain and short of its commitments',
  revoked: 'revoked',
};

/**
 * Payment authorities, under Workspace access because granting one is an
 * access decision about money: it says which wallet's approval Trialoom may
 * draw on, and it is revocable at any time.
 */
export function AuthorityPanel({ base }: { base: string }) {
  const [data, setData] = useState<Authorities>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState('');
  const load = useCallback(async () => {
    setData(await api<Authorities>(`${base}/payment-authorities`));
  }, [base]);
  useEffect(() => {
    load().catch((e) =>
      setError(e instanceof Error ? e.message : 'Payment authorities unavailable.'),
    );
  }, [load]);
  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError('');
    try {
      await work();
      await load();
      setOpen('');
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return null;
  const money = (units: string) => `${formatUnits(units)} ${data.currency.symbol}`;
  return (
    <section className="live-section">
      <PaymentSetup base={base} onImported={load} />
      <div className="section-heading">
        <h2>Payment authority</h2>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => {
            setAdding(!adding);
            setError('');
          }}
        >
          {adding ? 'Cancel' : 'Advanced: register authority'}
        </button>
      </div>
      <p className="section-description">{data.note}</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {adding && (
        <form
          className="app-form editor-panel"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const declared = field(form, 'declared');
            void run(async () => {
              await api(`${base}/payment-authorities`, 'POST', {
                reference: field(form, 'reference'),
                provider: 'remesso',
                policyId: field(form, 'policyId'),
                payerAddress: field(form, 'payerAddress'),
                agentAddress: field(form, 'agentAddress'),
                declaredUnits: toUnits(declared),
                declarationAcknowledged: form.get('declarationAcknowledged') === 'on',
              });
              setAdding(false);
            }, 'The authority could not be registered.');
          }}
        >
          <label>
            Your name for it
            <input name="reference" required maxLength={120} placeholder="Treasury policy" />
          </label>
          <div className="form-pair">
            <label>
              Remesso policy id
              <input name="policyId" required inputMode="numeric" placeholder="12" />
            </label>
            <label>
              Approved amount ({data.currency.symbol})
              <input name="declared" required inputMode="decimal" placeholder="100" />
            </label>
          </div>
          <label>
            Payer address, whose approval pays
            <input name="payerAddress" required placeholder="0x…" />
          </label>
          <label>
            Agent address, which Trialoom signs with
            <input name="agentAddress" required placeholder="0x…" />
          </label>
          <small>
            One token approval funds every policy that wallet grants, so the amount you enter is the
            approval itself rather than this brief's budget. A second authority naming the same
            payer and token does not add to it: it describes the same number.
          </small>
          <label className="check-field">
            <input name="declarationAcknowledged" type="checkbox" required />
            This states an approval I granted on chain. Trialoom holds no funds, and I can revoke it
            at any time without cancelling what has already been accepted.
          </label>
          <small>
            Once registered, the approval is re-read from the chain on a timer as well as whenever
            you ask. A reading that no longer covers what your briefs have committed is reported to
            you; it never cancels an obligation on its own.
          </small>
          <button type="submit" className="button primary" disabled={busy}>
            Register authority
          </button>
        </form>
      )}
      <div className="record-list">
        {data.authorities.map((authority) => (
          <div className="editor-panel" key={authority.id}>
            <div className="section-heading">
              <h5>
                {authority.reference} · policy {authority.policyId}
              </h5>
              <span className="neutral-label">
                {authority.revokedAt ? 'revoked' : authority.approval.state}
              </span>
            </div>
            <p className="section-description">
              {money(authority.approval.declaredUnits)} declared ·{' '}
              {money(authority.approval.committedUnits)} committed across{' '}
              {authority.campaigns === 1 ? '1 brief' : `${authority.campaigns} briefs`} ·{' '}
              {money(authority.approval.uncommittedUnits)} left to promise ·{' '}
              {money(authority.approval.settledUnits)} paid out
            </p>
            <p className="section-description">
              {states[authority.approval.state]}
              {authority.approval.observedAt
                ? ` · last read ${new Date(authority.approval.observedAt).toLocaleString()}: allowance ${money(
                    authority.approval.observedAllowanceUnits ?? '0',
                  )}, balance ${money(authority.approval.observedBalanceUnits ?? '0')}`
                : ''}
              {authority.approval.stale ? ' · that reading is stale' : ''}
            </p>
            {authority.approval.lastReadError && !authority.revokedAt && (
              <p className="section-description" role="status">
                The last scheduled read failed: {authority.approval.lastReadError} An approval
                nobody can read is not the same as one that is short, so nothing has changed about
                what is committed against it.
              </p>
            )}
            {authority.approval.shortfallUnits &&
              authority.approval.shortfallUnits !== '0' &&
              !authority.revokedAt && (
                <p className="form-error" role="status">
                  This approval is {money(authority.approval.shortfallUnits)} short of what the
                  briefs drawing on it have committed. Nothing has been cancelled; approve more on
                  chain and declare it, or expect those payouts to block while the debt stays owed.
                </p>
              )}
            {authority.revokedReason && (
              <p className="section-description">Revoked: {authority.revokedReason}</p>
            )}
            {!authority.revokedAt && (
              <div className="status-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(
                        `${base}/payment-authorities/${authority.id}/verification`,
                        'POST',
                        {},
                      );
                    }, 'The approval could not be read from the chain.')
                  }
                >
                  Verify against the chain
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    setOpen(open === `top-${authority.id}` ? '' : `top-${authority.id}`)
                  }
                >
                  Declare more
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    setOpen(open === `revoke-${authority.id}` ? '' : `revoke-${authority.id}`)
                  }
                >
                  Revoke
                </button>
              </div>
            )}
            {open === `top-${authority.id}` && (
              <form
                className="app-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const declared = field(form, 'declared');
                  void run(async () => {
                    await api(`${base}/payment-authorities/${authority.id}`, 'POST', {
                      declaredUnits: toUnits(declared),
                      declarationAcknowledged: form.get('declarationAcknowledged') === 'on',
                    });
                  }, 'The declaration could not be recorded.');
                }}
              >
                <label>
                  The approval now totals ({data.currency.symbol})
                  <input name="declared" required inputMode="decimal" placeholder="200" />
                </label>
                <small>
                  Enter the whole approval, not the increase. It can only rise here: an approval
                  that has really shrunk shows up as a shortfall when it is read.
                </small>
                <label className="check-field">
                  <input name="declarationAcknowledged" type="checkbox" required />I have approved
                  this amount on chain.
                </label>
                <button type="submit" className="button primary" disabled={busy}>
                  Record declaration
                </button>
              </form>
            )}
            {open === `revoke-${authority.id}` && (
              <form
                className="app-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void run(async () => {
                    await api(`${base}/payment-authorities/${authority.id}`, 'DELETE', {
                      reason: field(form, 'reason'),
                    });
                  }, 'The authority could not be revoked.');
                }}
              >
                <label>
                  Reason
                  <textarea name="reason" required minLength={3} maxLength={200} rows={2} />
                </label>
                <small>
                  Revoking stops new claims on every brief this funds. Payouts already accepted stay
                  owed and visible, and block with a named reason rather than disappearing.
                </small>
                <button type="submit" className="button primary" disabled={busy}>
                  Revoke authority
                </button>
              </form>
            )}
          </div>
        ))}
        {!data.authorities.length && (
          <p className="section-description">
            No payment authority is registered, so a published brief records a spending reference
            that pays nobody and every payout blocks as owed. Registering one is what makes a payout
            possible; it is not escrow, and it moves no money by itself.
          </p>
        )}
      </div>
    </section>
  );
}
