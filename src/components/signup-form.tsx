'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { LoomMark } from './icons';
import { api } from './live-types';

export function SignupForm({
  complete = false,
  enabled,
}: {
  complete?: boolean;
  enabled: boolean;
}) {
  const tokenRef = useRef<string | null>(null);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(complete && enabled);
  useEffect(() => {
    if (!complete) return;
    tokenRef.current ??= new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
    window.history.replaceState(null, '', '/sign-up/complete');
    if (!enabled) return;
    if (!tokenRef.current) {
      setError('Open the signup link from your email, or request a new one.');
      setLoading(false);
      return;
    }
    let active = true;
    api<{ email: string }>('/api/signup/inspect', 'POST', { token: tokenRef.current })
      .then((data) => {
        if (active) setEmail(data.email);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [complete, enabled]);

  async function submit(form: FormData) {
    setBusy(true);
    setError('');
    try {
      if (!complete) {
        await api('/api/signup/request', 'POST', { email: String(form.get('email')) });
        setSent(true);
      } else {
        const password = String(form.get('password'));
        const result = await api<{ email: string }>('/api/signup/complete', 'POST', {
          token: tokenRef.current,
          name: String(form.get('name')),
          workspace: `${String(form.get('name')).trim().slice(0, 80)}'s workspace`,
          password,
        });
        await api('/api/auth/sign-in/email', 'POST', { email: result.email, password });
        window.location.assign('/workspace');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to continue. Please try again.');
    } finally {
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
          <h1>
            {sent
              ? 'Check your inbox'
              : complete
                ? 'Finish your account'
                : 'Create your free account'}
          </h1>
          <p>
            {!enabled
              ? 'Signup isn’t open yet. You can still explore the example report.'
              : sent
                ? 'Open the link in your email within 30 minutes to continue.'
                : complete
                  ? 'A couple of details and you’re ready.'
                  : 'We’ll email you a link to get started. No payment details.'}
          </p>
        </section>
        <section className="auth-form-panel" aria-label="Create account">
          {loading && <p role="status">Checking your signup link…</p>}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {enabled && !sent && !loading && (!complete || email) && (
            <form
              className="app-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submit(new FormData(event.currentTarget));
              }}
            >
              <label>
                Email address
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  readOnly={complete}
                  defaultValue={email}
                />
              </label>
              {complete && (
                <>
                  <label>
                    Your name
                    <input name="name" autoComplete="name" required maxLength={100} />
                  </label>
                  <label>
                    Choose a password
                    <input
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={128}
                    />
                  </label>
                  <small>Use at least 12 characters.</small>
                </>
              )}
              <button type="submit" className="button primary" disabled={busy}>
                {busy ? 'Please wait…' : complete ? 'Create account' : 'Send signup link'}
              </button>
            </form>
          )}
          {!enabled && (
            <Link href="/demo" className="button primary">
              See an example report
            </Link>
          )}
          <p className="auth-footnote">
            <Link className="text-link" href="/sign-in">
              Already have an account? Sign in
            </Link>
          </p>
          {complete && (
            <p className="auth-footnote">
              <Link className="text-link" href="/sign-up">
                Request a new signup link
              </Link>
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
