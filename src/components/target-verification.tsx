'use client';
import { useState } from 'react';
import { api } from './live-types';

type Challenge = {
  id: string;
  expiresAt: string;
  record: { type: string; name: string; value: string };
};
type Verification = { verified: boolean; expiresAt: string | null; challenge: Challenge | null };
/**
 * The part of the record name a provider expects when it appends the zone
 * itself, which most of them do. `_trialoom.site.com` becomes `_trialoom`,
 * and `_trialoom.preview.site.com` becomes `_trialoom.preview`.
 *
 * The zone is taken to be the last two labels. That is right for the common
 * cases and wrong for a two-part suffix like `.co.uk`, which is why the full
 * name stays on screen underneath rather than being replaced by this.
 */
function relativeName(name: string) {
  const labels = name.split('.');
  return labels.length > 2 ? labels.slice(0, -2).join('.') : name;
}

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
              Record type: <strong>TXT</strong>.
            </p>
            <label>
              DNS record name
              <input
                readOnly
                value={relativeName(view.challenge.record.name)}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
            {/*
              Most providers — Namecheap, Cloudflare, GoDaddy — append the
              domain to whatever goes in this field, so offering the full name
              as the thing to copy is what produces `_trialoom.site.com.site.com`.
              Lead with the part that is right nearly everywhere and keep the
              full name available for the few that want it.
            */}
            <p className="product-note">
              Most providers add your domain for you, so the name above is usually all you type.
              If yours wants the whole thing, use <strong>{view.challenge.record.name}</strong> —
              but do not enter both, or the record lands at{' '}
              <code>{view.challenge.record.name}.{view.challenge.record.name.split('.').slice(1).join('.')}</code>{' '}
              and never verifies.
            </p>
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
