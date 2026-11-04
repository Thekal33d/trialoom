'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { LoomMark } from './icons';

type Invitation = { email: string; role: string; workspace: string; existingAccount: boolean };
async function post(url: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error?.message ?? data.message ?? 'Unable to continue. Please try again.');
  return data;
}
export function AuthForm({ join = false }: { join?: boolean }) {
  const [invitation, setInvitation] = useState<Invitation | null>(null),
    [token, setToken] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(join);
  const invitationToken = useRef<string | null>(null);
  useEffect(() => {
    if (!join) return;
    invitationToken.current ??=
      new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
    const value = invitationToken.current;
    window.history.replaceState(null, '', '/join');
    setToken(value);
    if (!value) {
      setError('Open the private invitation link your workspace owner shared with you.');
      setLoading(false);
      return;
    }
    let active = true;
    post('/api/v1/invitations/inspect', { token: value })
      .then((data) => {
        if (active) setInvitation(data);
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [join]);
  async function submit(form: FormData) {
    setBusy(true);
    setError('');
    const email = invitation?.email ?? String(form.get('email')),
      password = String(form.get('password'));
    try {
      if (join && invitation) {
        if (invitation.existingAccount) await post('/api/auth/sign-in/email', { email, password });
        await post('/api/v1/invitations/accept', {
          token,
          name: String(form.get('name') || 'Workspace member'),
          ...(invitation.existingAccount ? {} : { password }),
        });
      }
      if (!join || !invitation?.existingAccount)
        await post('/api/auth/sign-in/email', { email, password });
      window.location.assign('/workspace');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to continue.');
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <Link href="/" className="brand">
        <LoomMark />
        <span>trialoom.</span>
      </Link>
      <div className="auth-layout">
        <section className="auth-intro">
          <h1>{join ? 'Join your team' : 'Access your existing account'}</h1>
          <p>
            {invitation
              ? `Join ${invitation.workspace} as ${invitation.role}.`
              : join
                ? 'Use your invitation to get started.'
                : 'Sign in, then link your wallet in Account settings.'}
          </p>
        </section>
        <section className="auth-form-panel" aria-label="Sign in">
          {loading && <p role="status">Checking your invitation…</p>}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {(!join || invitation) && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit(new FormData(event.currentTarget));
              }}
              className="app-form"
            >
              {join && !invitation?.existingAccount && (
                <label>
                  Your name
                  <input name="name" autoComplete="name" required maxLength={100} />
                </label>
              )}
              <label>
                Email address
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  defaultValue={invitation?.email}
                  readOnly={join}
                />
              </label>
              <label>
                {join && !invitation?.existingAccount ? 'Choose a password' : 'Password'}
                <input
                  name="password"
                  type="password"
                  autoComplete={
                    join && !invitation?.existingAccount ? 'new-password' : 'current-password'
                  }
                  required
                  minLength={join ? 12 : 1}
                  maxLength={128}
                />
              </label>
              {join && !invitation?.existingAccount && (
                <small>Use at least 12 characters. Your invitation can be used once.</small>
              )}
              <button type="submit" className="button primary" disabled={busy}>
                {busy
                  ? 'Please wait…'
                  : join
                    ? invitation?.existingAccount
                      ? 'Sign in and accept'
                      : 'Create account and join'
                    : 'Sign in'}
              </button>
            </form>
          )}
          <p className="auth-footnote">
            {join ? (
              'Contact your workspace owner if you need a new invitation or account help.'
            ) : (
              <Link className="text-link" href="/sign-up">
                Continue with a wallet
              </Link>
            )}
          </p>
        </section>
      </div>
    </main>
  );
}
