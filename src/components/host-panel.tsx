'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, field } from './live-types';

type Host = {
  id: string;
  name: string;
  handle: string | null;
  contract_version: string;
  sandbox: string;
  egress_enforced: boolean;
  ephemeral_filesystem: boolean;
  isolation_level: 'attested' | 'witnessed';
  revoked_at: string | null;
  last_used_at: string | null;
};
type Hosts = {
  hosts: Host[];
  contract: {
    version: string;
    requirements: string[];
    verifiedByPlatform: string[];
    stillAttested: string[];
  };
};

/**
 * Runner hosts, under Workspace access because admitting one is an access
 * decision: it says where this workspace's customer code may run.
 */
export function HostPanel({ base }: { base: string }) {
  const [data, setData] = useState<Hosts>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [credential, setCredential] = useState('');
  const load = useCallback(async () => {
    setData(await api<Hosts>(`${base}/runner-hosts`));
  }, [base]);
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Runner hosts unavailable.'));
  }, [load]);
  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError('');
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return null;
  return (
    <section className="live-section">
      <div className="section-heading">
        <h2>Runner hosts</h2>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => {
            setAdding(!adding);
            setError('');
            setCredential('');
          }}
        >
          {adding ? 'Cancel' : 'Register a host'}
        </button>
      </div>
      <p className="section-description">
        A host executes runs under contract {data.contract.version}. Its credential is separate from
        any operator credential and is never given to the agent inside the sandbox, so the party
        being constrained cannot speak as the one watching it. Admitting a host is a declaration you
        are making: Trialoom does not run these hosts, so what the sandbox really is stays the host
        operator's word.
      </p>
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
            const level = field(form, 'isolationLevel');
            void run(async () => {
              const result = await api<{ credential: string }>(`${base}/runner-hosts`, 'POST', {
                name: field(form, 'name'),
                contractVersion: 'runner-host-v1',
                sandbox: field(form, 'sandbox'),
                egressEnforced: form.get('egressEnforced') === 'on',
                ephemeralFilesystem: form.get('ephemeralFilesystem') === 'on',
                isolationLevel: level,
                contractAccepted: form.get('contractAccepted') === 'on',
              });
              setCredential(result.credential);
              setAdding(false);
            }, 'The host could not be registered.');
          }}
        >
          <label>
            Host name
            <input name="name" required maxLength={80} placeholder="Sandboxed runner host" />
          </label>
          <div className="form-pair">
            <label>
              Sandbox
              <select name="sandbox" defaultValue="gvisor">
                <option value="gvisor">gVisor</option>
                <option value="firecracker">Firecracker</option>
                <option value="none">None</option>
              </select>
            </label>
            <label>
              Isolation it provides
              <select name="isolationLevel" defaultValue="witnessed">
                <option value="witnessed">Witnessed</option>
                <option value="attested">Attested</option>
              </select>
            </label>
          </div>
          <fieldset className="check-group">
            <legend>What this host implements</legend>
            <label className="check-field">
              <input name="egressEnforced" type="checkbox" defaultChecked />
              An egress proxy is the only network path, and it denies every origin outside the run
              allowlist
            </label>
            <label className="check-field">
              <input name="ephemeralFilesystem" type="checkbox" defaultChecked />
              Each run gets an ephemeral filesystem and a fresh browser profile, destroyed when it
              closes
            </label>
          </fieldset>
          <small>
            A witnessed host must implement both and run a real sandbox; registering one that does
            not is refused. Register it as attested instead, which is the honest claim.
          </small>
          <details className="terms-version">
            <summary>The contract this host accepts</summary>
            <div className="version-content">
              <h4>It must</h4>
              <ul className="waiting-list">
                {data.contract.requirements.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <h4>Trialoom verifies</h4>
              <ul className="waiting-list">
                {data.contract.verifiedByPlatform.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <h4>Still only asserted</h4>
              <ul className="waiting-list">
                {data.contract.stillAttested.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          </details>
          <label className="check-field">
            <input name="contractAccepted" type="checkbox" required />I have read the contract and
            this host implements it.
          </label>
          <button type="submit" className="button primary" disabled={busy}>
            Register host
          </button>
        </form>
      )}
      {credential && (
        <div className="invitation-result">
          <label>
            New host credential
            <input value={credential} readOnly aria-label="New host credential" />
          </label>
          <small>
            Shown once and stored only as a digest. The host holds this; no operator and no run
            grant ever sees it.
          </small>
        </div>
      )}
      <div className="record-list">
        {data.hosts.map((host) => (
          <div className="member-row" key={host.id}>
            <div>
              <strong>{host.name}</strong>
              <p>
                {host.isolation_level} · sandbox {host.sandbox} ·{' '}
                {host.egress_enforced ? 'egress enforced' : 'egress not enforced'} ·{' '}
                {host.ephemeral_filesystem ? 'ephemeral filesystem' : 'persistent filesystem'}
                {host.handle ? ` · runs for @${host.handle}` : ' · platform operated'}
                {host.last_used_at
                  ? ` · last used ${new Date(host.last_used_at).toLocaleString()}`
                  : ' · never used'}
              </p>
            </div>
            {host.revoked_at ? (
              <span className="neutral-label">revoked</span>
            ) : (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`${base}/runner-hosts/${host.id}`, 'DELETE');
                  }, 'The host could not be revoked.')
                }
              >
                Revoke
              </button>
            )}
          </div>
        ))}
        {!data.hosts.length && (
          <p className="section-description">
            No runner host is registered, so every run is attested only and a brief cannot require a
            witness.
          </p>
        )}
      </div>
    </section>
  );
}
