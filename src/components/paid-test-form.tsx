'use client';
import { useState } from 'react';
import { homepageAction } from '@/domain/hosted-tests';
import { toUnits } from '@/domain/values';
import type { BuildRecord } from './live-types';
import { field } from './live-types';

export function PaidTestForm({
  builds,
  onSave,
  onCancel,
}: {
  builds: BuildRecord[];
  onSave: (name: string, terms: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tomorrow = new Date(Date.now() + 86400000);
  const deadline = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  return (
    <section className="editor-panel">
      <div className="section-heading">
        <h2>Create a paid homepage test</h2>
        <button className="text-button" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p>
        The hosted browser loads the approved page, checks its response and records evidence. It
        does not sign in, submit forms or test every feature. You review the execution before a fee
        becomes payable.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="app-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setBusy(true);
          setError('');
          try {
            const priceUnits = toUnits(field(form, 'price'));
            if (BigInt(priceUnits) <= 0n) throw new Error('Enter a fee greater than zero.');
            await onSave(field(form, 'name'), {
              buildId: field(form, 'buildId'),
              expectedVersion: 0,
              service: 'test',
              scope:
                'Load the pinned homepage and report its response and scope checks with browser evidence.',
              allowedActions: [homepageAction],
              exclusions: ['No sign-in, form submission, transactions or private data.'],
              readOnlyDependencyOrigins: field(form, 'dependencies')
                .split('\n')
                .map((x) => x.trim())
                .filter(Boolean),
              acceptanceCriteria:
                'Execute the agreed homepage check on the pinned build with host-witnessed, internally consistent evidence. A website failure is a valid test result.',
              rewardRubric: 'Execution fee only; no discovery reward.',
              artifactRights:
                'The builder may retain and use the sanitized test evidence for product improvement.',
              deadline: new Date(field(form, 'deadline')).toISOString(),
              reviewWindowHours: 48,
              priceUnits,
              discoveryRewardCapUnits: '0',
              resourceAllowanceUnits: '0',
              platformFeeBps: 0,
              paymentTerms:
                'Accepted execution earns the stated USDC fee whether the website passes or fails. Review window: 48 hours. No paid outside resources or additional platform fee. Spending permission is not escrow; accepted obligations survive lost funding.',
              minimumIsolation: 'witnessed',
              scopeApproved: form.get('scopeApproved') === 'on',
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save the test.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Test name
          <input name="name" required maxLength={100} defaultValue="Homepage check" />
        </label>
        <label>
          Pinned build
          <select name="buildId" required>
            {builds.map((build) => (
              <option key={build.id} value={build.id}>
                {build.revision}
              </option>
            ))}
          </select>
        </label>
        <div className="form-pair">
          <label>
            Fee per accepted test (USDC)
            <input name="price" inputMode="decimal" required placeholder="For example, 1.00" />
          </label>
          <label>
            Delivery deadline (your local time)
            <input name="deadline" type="datetime-local" required defaultValue={deadline} />
          </label>
        </div>
        <details>
          <summary>Allow supporting resources</summary>
          <label>
            Read-only dependency origins
            <textarea
              name="dependencies"
              maxLength={1777}
              placeholder="https://fonts.googleapis.com"
            />
            <small>
              Up to seven HTTPS origins, one per line, for GET/HEAD only. Unexpected external
              requests block the result.
            </small>
          </label>
        </details>
        <p>
          Maximum fee: the amount you enter, per assignment. No discovery reward or platform fee.
          Review within 48 hours; a website failure does not cancel a valid execution fee.
        </p>
        <label className="check-field">
          <input name="scopeApproved" type="checkbox" required />I approve this scope and these
          delivery terms.
        </label>
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save paid test draft'}
        </button>
        <small>
          Next: choose a verified payment policy, set the number of tests and publish. Saving this
          draft moves no money.
        </small>
      </form>
    </section>
  );
}
