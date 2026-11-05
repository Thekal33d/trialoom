'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, field } from './live-types';

type Setup = {
  available: boolean;
  agentAddress: string | null;
  wallets: string[];
  policyUrl: string;
};
export function PaymentSetup({
  base,
  onImported,
}: {
  base: string;
  onImported: () => Promise<void>;
}) {
  const [data, setData] = useState<Setup>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    api<Setup>(`${base}/payment-setup`)
      .then(setData)
      .catch(() => setError('Payment setup could not be loaded. Refresh to try again.'));
  }, [base]);
  return (
    <section className="editor-panel">
      <h2>Set up paid testing</h2>
      <p>
        You choose a USDC spending limit in your own wallet. Accepted testing fees are paid from
        that allowance; your funds remain in your wallet until payment.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p role="status">
          Policy connected and checked. You can select it when publishing a paid test.
        </p>
      )}
      {data && !data.available && (
        <p role="status">
          Payments are not configured on this deployment yet. Your work briefs can be saved as
          drafts.
        </p>
      )}
      {data?.available &&
        (!data.wallets.length ? (
          <p>
            <Link href="/account">Link your paying wallet</Link> before connecting its spending
            policy.
          </p>
        ) : (
          <div className="app-form">
            <label>
              Trialoom payment agent
              <input
                readOnly
                value={data.agentAddress ?? ''}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <p>
              Open Remesso, connect your linked wallet, and create a Celo USDC policy for this
              agent. Choose the total allowance, per-payment cap, daily cap and expiry yourself.
              Your per-payment cap must cover each test’s maximum fee. Leave the recipient allowlist
              off so independent operators can receive their accepted fees.
            </p>
            <a className="button secondary" href={data.policyUrl} target="_blank" rel="noreferrer">
              Create spending policy in Remesso ↗
            </a>
            <small>
              Creating the policy requires wallet-approved transactions and network fees. Connecting
              it here only reads the chain. A spending allowance is not escrow.
            </small>
            <form
              className="app-form"
              onSubmit={async (event) => {
                event.preventDefault();
                const id = field(new FormData(event.currentTarget), 'policyId');
                setBusy(true);
                setError('');
                setDone(false);
                try {
                  await api(`${base}/payment-setup`, 'POST', { policyId: id });
                  await onImported();
                  setDone(true);
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Could not connect this policy.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Policy number from Remesso
                <input
                  name="policyId"
                  inputMode="numeric"
                  pattern="[1-9][0-9]*"
                  maxLength={78}
                  required
                  placeholder="For example, 12"
                />
              </label>
              <button className="button primary" disabled={busy} type="submit">
                {busy ? 'Checking policy…' : 'Connect spending policy'}
              </button>
            </form>
          </div>
        ))}
    </section>
  );
}
