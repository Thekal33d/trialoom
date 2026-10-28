'use client';
import { useCallback, useEffect, useState } from 'react';
import { formatUnits } from '@/domain/values';
import { api } from './live-types';

type Purchase = {
  id: string;
  handle: string;
  provider: string;
  sku: string;
  quoted_units: string;
  ceiling_units: string;
  cost_units: string | null;
  state: string;
  reason: string | null;
  charge: 'pending' | 'builder' | 'platform_absorbed' | 'none';
  transaction_hash: string | null;
  attempts: number;
  reconciled_at: string | null;
};
const money = (value: string) => `${formatUnits(value)} USDC`;
const states: Record<string, string> = {
  quoted: 'Quoted, nothing sent',
  reserved: 'Reserved, authorizing',
  submitted: 'Paid, resource arriving',
  usable: 'Paid and usable',
  reconciled: 'Reconciled',
  refused: 'Refused before payment',
  failed: 'Paid but undeliverable',
  uncertain: 'Settlement uncertain',
};
const charges: Record<string, string> = {
  pending: 'charge undecided, reservation held',
  builder: 'reimbursable by you',
  platform_absorbed: 'absorbed by the platform',
  none: 'nothing owed',
};

/** What this campaign's runs bought, what it cost, and who bears it. */
export function ResourcePanel({ campaignBase }: { campaignBase: string }) {
  const [record, setRecord] = useState<{ purchases: Purchase[]; note: string }>();
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setRecord(await api<{ purchases: Purchase[]; note: string }>(`${campaignBase}/resources`));
  }, [campaignBase]);
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Resource record unavailable.'));
  }, [load]);
  if (error)
    return (
      <section className="evidence-block">
        <h5>Resources</h5>
        <p className="form-error" role="alert">
          {error}
        </p>
      </section>
    );
  if (!record?.purchases.length) return null;
  return (
    <section className="evidence-block">
      <h5>Resources</h5>
      <p className="section-description">{record.note}</p>
      <div className="record-list">
        {record.purchases.map((purchase) => (
          <div className="member-row" key={purchase.id}>
            <div>
              <strong>
                {purchase.sku} · @{purchase.handle}
              </strong>
              <p>
                Authorized up to {money(purchase.ceiling_units)} · quoted{' '}
                {money(purchase.quoted_units)}
                {purchase.cost_units === null
                  ? ' · no cost recorded'
                  : ` · cost ${money(purchase.cost_units)}`}{' '}
                · {charges[purchase.charge] ?? purchase.charge}
                {purchase.reason ? ` · ${purchase.reason.replaceAll('_', ' ')}` : ''}
              </p>
              {purchase.transaction_hash && (
                <p className="subtle">
                  {purchase.transaction_hash.slice(0, 14)}… ·{' '}
                  {purchase.reconciled_at ? 'reconciled' : `${purchase.attempts} attempt(s)`}
                </p>
              )}
            </div>
            <span className="neutral-label">{states[purchase.state] ?? purchase.state}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
