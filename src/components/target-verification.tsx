'use client';
import { useState } from 'react';
import { api } from './live-types';

type Challenge = {
  id: string;
  expiresAt: string;
  record: { type: string; name: string; value: string };
};
type Verification = { verified: boolean; expiresAt: string | null; challenge: Challenge | null };
export function TargetVerification({
  base,
  onVerified,
}: {
  base: string;
  onVerified?: () => Promise<void>;
}) {
  const [view, setView] = useState<Verification>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function action(kind: 'read' | 'issue' | 'check' | 'revoke') {
    setBusy(true);
    setError('');
    try {
      if (kind === 'issue') await api(`${base}/verification`, 'POST', {});
      if (kind === 'check')
        await api(`${base}/verification/check`, 'POST', { challengeId: view?.challenge?.id });
      if (kind === 'revoke') await api(`${base}/verification`, 'DELETE');
      setView(await api<Verification>(`${base}/verification`));
      if (kind !== 'read') await onVerified?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check website permission.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="website-test target-verification"
      onToggle={(event) => {
        if (event.currentTarget.open && !view && !busy) void action('read');
      }}
    >
      <summary>Verify website permission</summary>
      <div className="app-form">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {!view && !error && <p role="status">Loading verification…</p>}
        {view?.verified && (
          <p role="status">
            Website verified until {new Date(view.expiresAt ?? '').toLocaleDateString()}. You can
            offer public work and request supported tests.
          </p>
        )}
        {view && !view.verified && (
          <p>
            Add a TXT record in your domain’s DNS settings to prove you control this website.
            Verification lasts seven days. No invitation is needed.
          </p>
        )}
        {view?.challenge ? (
          <>
            <p>
              Record type: <strong>TXT</strong>. If your DNS provider adds the zone name
              automatically, enter only the part before it, such as _trialoom or _trialoom.preview.
            </p>
            <label>
              DNS record name
              <input
                readOnly
                value={view.challenge.record.name}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
            <label>
              DNS record value
              <textarea
                readOnly
                rows={3}
                value={view.challenge.record.value}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
            <small>
              This code expires {new Date(view.challenge.expiresAt).toLocaleString()}. DNS changes
              can take a little while to appear.
            </small>
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() => void action('check')}
            >
              {busy ? 'Checking…' : 'Check DNS record'}
            </button>
          </>
        ) : (
          view && (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => void action('issue')}
            >
              {view.verified ? 'Renew verification' : 'Get verification code'}
            </button>
          )
        )}
        {view?.verified && (
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => void action('revoke')}
          >
            Remove testing permission
          </button>
        )}
      </div>
    </details>
  );
}
