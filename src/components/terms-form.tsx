'use client';
import { useState } from 'react';
import { formatUnits, toUnits } from '@/domain/values';
import type { BuildRecord, TermsRecord } from './live-types';
import { field } from './live-types';
export function TermsForm({
  builds,
  current,
  onSave,
  onCancel,
}: {
  builds: BuildRecord[];
  current?: TermsRecord;
  onSave: (name: string, terms: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const d = current?.document;
  async function submit(form: FormData) {
    setBusy(true);
    setError('');
    try {
      await onSave(field(form, 'name'), {
        buildId: field(form, 'buildId'),
        expectedVersion: current?.version ?? 0,
        service: field(form, 'service'),
        scope: field(form, 'scope'),
        allowedActions: field(form, 'allowedActions')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        exclusions: field(form, 'exclusions')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        readOnlyDependencyOrigins: field(form, 'readOnlyDependencyOrigins')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        acceptanceCriteria: field(form, 'acceptanceCriteria'),
        rewardRubric: field(form, 'rewardRubric'),
        artifactRights: field(form, 'artifactRights'),
        deadline: new Date(field(form, 'deadline')).toISOString(),
        reviewWindowHours: Number(field(form, 'reviewWindowHours')),
        priceUnits: toUnits(field(form, 'price')),
        discoveryRewardCapUnits: toUnits(field(form, 'discoveryReward')),
        resourceAllowanceUnits: toUnits(field(form, 'resourceAllowance')),
        platformFeeBps: Number(toUnits(field(form, 'platformFee'), 2)),
        paymentTerms: field(form, 'paymentTerms'),
        minimumIsolation:
          field(form, 'minimumIsolation') === 'witnessed' ? 'witnessed' : 'attested',
        scopeApproved: form.get('scopeApproved') === 'on',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save these terms.');
      setBusy(false);
    }
  }
  const localDate = d
    ? new Date(new Date(d.deadline).getTime() - new Date(d.deadline).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : '';
  return (
    <section className="editor-panel">
      <div className="section-heading">
        <h2>{current ? `Revise terms · v${current.version}` : 'Prepare a work brief'}</h2>
        <button type="button" className="text-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="editor-description">
        Approve the exact scope and delivery rules. Saving creates a permanent version; this brief
        stays a draft until funding and claim controls are ready.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="app-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(new FormData(event.currentTarget));
        }}
      >
        {!current && (
          <label>
            Brief name
            <input name="name" required maxLength={100} placeholder="Invitation journey" />
          </label>
        )}
        <div className="form-pair">
          <label>
            Pinned build
            <select name="buildId" defaultValue={d?.buildId} required>
              {builds.map((build) => (
                <option key={build.id} value={build.id}>
                  {build.revision} · {build.fixture_version}
                </option>
              ))}
            </select>
          </label>
          <label>
            Service
            <select name="service" defaultValue={d?.service ?? 'test'}>
              <option value="test">Test my product</option>
              <option value="bug_discovery">Find reproducible bugs</option>
              <option value="repair">Fix this bug</option>
            </select>
          </label>
        </div>
        <label>
          Scope
          <textarea
            name="scope"
            required
            minLength={3}
            maxLength={4000}
            defaultValue={d?.scope}
            placeholder="Name the journey and the outcome you want tested."
          />
        </label>
        <div className="form-pair">
          <label>
            Permitted actions
            <textarea
              name="allowedActions"
              required
              maxLength={6000}
              defaultValue={d?.allowedActions.join('\n')}
              placeholder="One action per line"
            />
          </label>
          <label>
            Exclusions
            <textarea
              name="exclusions"
              maxLength={6000}
              defaultValue={d?.exclusions.join('\n')}
              placeholder="For example: no real email delivery"
            />
          </label>
        </div>
        <label>
          Read-only dependency origins (optional)
          <textarea
            name="readOnlyDependencyOrigins"
            maxLength={1777}
            defaultValue={d?.readOnlyDependencyOrigins?.join('\n')}
            placeholder="https://fonts.googleapis.com"
            aria-describedby="dependency-scope-help"
          />
          <small id="dependency-scope-help">
            Approve up to seven HTTPS origins, one per line, for supporting GET/HEAD resources.
            Requires witnessed isolation. Leave empty to allow only the project’s origin.
          </small>
        </label>
        <label>
          Acceptance criteria
          <textarea
            name="acceptanceCriteria"
            required
            minLength={3}
            maxLength={4000}
            defaultValue={d?.acceptanceCriteria}
            placeholder="Describe the evidence that makes the delivery acceptable."
          />
        </label>
        <label>
          Discovery reward rules
          <textarea
            name="rewardRubric"
            required
            minLength={3}
            maxLength={4000}
            defaultValue={d?.rewardRubric}
            placeholder="Define severity and rewards, or state that no discovery reward is offered."
          />
        </label>
        <div className="form-pair">
          <label>
            Execution price (USDC)
            <input
              name="price"
              inputMode="decimal"
              required
              defaultValue={d ? formatUnits(d.priceUnits) : ''}
              placeholder="0.00"
            />
          </label>
          <label>
            Discovery reward cap (USDC)
            <input
              name="discoveryReward"
              inputMode="decimal"
              required
              defaultValue={d ? formatUnits(d.discoveryRewardCapUnits) : '0'}
            />
          </label>
          <label>
            Resource allowance (USDC)
            <input
              name="resourceAllowance"
              inputMode="decimal"
              required
              defaultValue={d ? formatUnits(d.resourceAllowanceUnits) : '0'}
            />
          </label>
          <label>
            Platform fee (%)
            <input
              name="platformFee"
              inputMode="decimal"
              required
              defaultValue={d ? formatUnits(String(d.platformFeeBps), 2) : '10'}
            />
          </label>
        </div>
        <small>
          Amounts are denominated in USDC on Celo. The proposed fee is editable; no funds are
          reserved or authorized when you save.
        </small>
        <div className="form-pair">
          <label>
            Delivery deadline (your local time)
            <input name="deadline" type="datetime-local" required defaultValue={localDate} />
          </label>
          <label>
            Review window (hours)
            <input
              name="reviewWindowHours"
              type="number"
              min="1"
              max="720"
              required
              defaultValue={d?.reviewWindowHours ?? 48}
            />
          </label>
        </div>
        <label>
          Execution isolation
          <select name="minimumIsolation" defaultValue={d?.minimumIsolation ?? 'attested'}>
            <option value="attested">Attested: the agent reports its own isolation</option>
            <option value="witnessed">
              Witnessed: a registered host's proxy reports its egress
            </option>
          </select>
        </label>
        <small>
          A witnessed run executes on a runner host you have admitted, whose egress proxy denies
          every origin outside this build's own and reports what it allowed and denied. Trialoom
          compares that record with what the agent claims and refuses evidence they disagree on. An
          attested run is the agent's own word, which is all an unenforced host can offer.
        </small>
        <label>
          Artifact rights
          <textarea
            name="artifactRights"
            required
            minLength={3}
            maxLength={4000}
            defaultValue={d?.artifactRights}
            placeholder="State how the builder may retain and reuse reports, patches, and tests."
          />
        </label>
        <label>
          Payment and resource terms
          <textarea
            name="paymentTerms"
            required
            minLength={3}
            maxLength={4000}
            defaultValue={d?.paymentTerms}
            placeholder="Disclose acceptance/payment timing, eligible resource costs, and gas treatment. Spending authorization is not escrow."
          />
        </label>
        <label className="check-field">
          <input name="scopeApproved" type="checkbox" required />I approve this scope and these
          delivery terms. I understand that existing versions will remain unchanged.
        </label>
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? 'Saving version…' : current ? 'Save new version' : 'Save draft brief'}
        </button>
      </form>
    </section>
  );
}
