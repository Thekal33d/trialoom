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
          workspace: String(form.get('workspace')),
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
    <main className="auth-page">
      <Link href="/" className="brand">
        <LoomMark />
        <span>trialoom.</span>
      </Link>
      <div className="auth-layout">
        <section className="auth-intro">
          <div className="eyebrow">THE FREE TESTING BETA</div>
          <h1>
            A clearer path
            <br />
            <span className="heading-accent">to your next release.</span>
          </h1>
          <p>
            A workspace for your previews, test evidence, and the findings worth fixing. No wallet
            or payment setup.
          </p>
          <Link href="/demo" className="text-link">
            Explore an example report ↗
          </Link>
        </section>
        <section className="auth-form-panel">
          <h2>
            {sent
              ? 'Check your inbox.'
              : complete
                ? 'Make it your workspace.'
                : 'Start with your email.'}
          </h2>
          <p>
            {!enabled
              ? 'Public signup is being prepared. You can explore the example workspace while we finish setup.'
              : sent
                ? 'Use the link in your email within 30 minutes to choose a password and create your workspace. Already registered? Sign in below.'
                : complete
                  ? 'Choose your details to finish creating your free account.'
                  : 'We’ll send a link to confirm your email before you choose a password.'}
          </p>
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
                    Workspace name
                    <input
                      name="workspace"
                      autoComplete="organization"
                      required
                      maxLength={100}
                      placeholder="Your project or team"
                    />
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
                  <small>
                    Use at least 12 characters. Your workspace is free; testing is subject to beta
                    availability and limits.
                  </small>
                </>
              )}
              <button type="submit" className="button primary" disabled={busy}>
                {busy ? 'Please wait…' : complete ? 'Create free workspace' : 'Send signup link'}
              </button>
            </form>
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
