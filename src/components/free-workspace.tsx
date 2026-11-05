'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { activeFreeTest, type FreeTestsView } from '@/domain/free-tests';
import { FreeTestHistory } from './free-test-history';
import { api, type ProjectSummary } from './live-types';
import { ProductFooter, ProductHeader } from './product-shell';
import { TargetVerification } from './target-verification';

export function FreeWorkspace({
  workspace,
  initialProjects,
  initialTests,
}: {
  workspace: { id: string; name: string };
  initialProjects: ProjectSummary[];
  initialTests: FreeTestsView;
}) {
  const [projects, setProjects] = useState(initialProjects);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [notice, setNotice] = useState('');
  const addressInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const wasCreating = useRef(false);
  useEffect(() => {
    if (creating) addressInput.current?.focus();
    else if (wasCreating.current) addButton.current?.focus();
    wasCreating.current = creating;
  }, [creating]);
  const [tests, setTests] = useState(initialTests);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const base = `/api/v1/workspaces/${workspace.id}/free-tests`;
  const active = tests.tests.some((item) => activeFreeTest(item.phase));
  useEffect(() => {
    let alive = true;
    const timer = setInterval(
      () => {
        void api<FreeTestsView>(base)
          .then((value) => {
            if (alive) {
              setTests(value);
              setRefreshError('');
            }
          })
          .catch(() => {
            if (alive)
              setRefreshError(
                'Updates paused. Your last saved results are shown. Refresh this page to try again.',
              );
          });
      },
      active ? 3000 : 10000,
    );
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [base, active]);
  async function start(projectId?: string) {
    setBusy(true);
    setError('');
    setNotice('');
    const key = projectId ?? 'sample';
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    try {
      await api(
        base,
        'POST',
        projectId
          ? {
              kind: 'homepage',
              requestId: pending.current.id,
              projectId,
              authorizationConfirmed: true,
            }
          : { kind: 'sample', requestId: pending.current.id },
      );
      setTests(await api<FreeTestsView>(base));
      pending.current = null;
      setNotice('Test requested. Follow its progress below.');
      document.getElementById('test-history')?.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to request test.');
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    setBusy(true);
    setError('');
    try {
      await api(`${base}/${id}`, 'DELETE');
      setTests(await api<FreeTestsView>(base));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to cancel test.');
    } finally {
      setBusy(false);
    }
  }
  async function create(form: FormData) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/v1/workspaces/${workspace.id}/projects`, 'POST', {
        name:
          String(form.get('name') || '').trim() ||
          new URL(String(form.get('targetUrl'))).hostname.slice(0, 100),
        targetUrl: String(form.get('targetUrl')),
        environment: String(form.get('environment')),
        authorizationConfirmed: form.get('authorized') === 'on',
      });
      const result = await api<{ projects: ProjectSummary[] }>(
        `/api/v1/workspaces/${workspace.id}/projects`,
      );
      setProjects(result.projects);
      setCreating(false);
      setNotice('Website added.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to create project.');
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    try {
      await api('/api/auth/sign-out', 'POST', {});
      window.location.assign('/sign-in');
    } catch {
      setError('Unable to sign out. Please try again.');
    }
  }
  return (
    <div className="product-page">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <ProductHeader>
        <Link href="/jobs">Paid testing</Link>
        <Link href="/operator">Earn with an agent</Link>
        <Link href="/account">Account settings</Link>
        <button type="button" className="text-button" onClick={() => void signOut()}>
          Sign out
        </button>
      </ProductHeader>
      <main id="main" className="product-container dashboard">
        <header className="dashboard-heading">
          <div>
            <span className="product-kicker">Your workspace</span>
            <h1>My websites</h1>
            <p>Add a website, run a check, and review the result.</p>
          </div>
          {!creating && projects.length < 3 && (
            <button
              ref={addButton}
              type="button"
              className="button primary"
              onClick={() => {
                setCreating(true);
                setError('');
                setNotice('');
              }}
            >
              Add website <span aria-hidden="true">+</span>
            </button>
          )}
        </header>
        {!tests.available && (
          <div className="availability-note">
            <div>
              <strong>Live testing isn’t available right now.</strong>
              <p>You can still save websites and explore a sample result.</p>
            </div>
            <Link href="/demo" className="text-link">
              See example report ↗
            </Link>
          </div>
        )}
        <div className="workspace-meta">
          <span>{projects.length} of 3 websites</span>
          <span>
            {tests.remaining} {tests.remaining === 1 ? 'test' : 'tests'} left today
          </span>
          <details>
            <summary>Beta limits</summary>
            <p>
              Three requests per day, one at a time. Resets at midnight UTC. Cancelled requests
              count.
            </p>
          </details>
        </div>
        {refreshError && (
          <p className="form-error" role="status">
            {refreshError}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="success-note" role="status">
            {notice}
          </p>
        )}
        <section aria-label="Your websites">
          {creating && (
            <form
              className="app-form website-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void create(new FormData(event.currentTarget));
              }}
            >
              <h2>Add a website</h2>
              <label>
                Website address
                <input
                  ref={addressInput}
                  name="targetUrl"
                  type="url"
                  placeholder="https://your-website.com"
                  required
                  maxLength={2048}
                  autoComplete="url"
                />
              </label>
              <label>
                Website name <span className="field-optional">Optional</span>
                <input name="name" maxLength={100} placeholder="My website" />
              </label>
              <details className="form-options">
                <summary>More options</summary>
                <label>
                  Website environment
                  <select name="environment" defaultValue="preview">
                    <option value="preview">Preview</option>
                    <option value="staging">Staging</option>
                  </select>
                </label>
              </details>
              <label className="check-field">
                <input name="authorized" type="checkbox" required />I own this website or have
                permission to test it.
              </label>
              <div className="product-actions">
                <button className="button primary" type="submit" disabled={busy}>
                  {busy ? 'Saving…' : 'Save website'}
                </button>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setCreating(false);
                  }}
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
          {projects.length > 0 ? (
            <ul className="website-list">
              {projects.map((project) => (
                <li key={project.id}>
                  <div className="website-identity">
                    <span className="website-initial" aria-hidden="true">
                      {project.name.charAt(0).toUpperCase()}
                    </span>
                    <div>
                      <h2>{project.name}</h2>
                      <p>{project.target_url}</p>
                    </div>
                  </div>
                  {tests.allowedOrigins.includes(new URL(project.target_url).origin) ? (
                    <details className="website-test">
                      <summary>Test this website</summary>
                      <form
                        className="app-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void start(project.id);
                        }}
                      >
                        <p>Opens this page and its own files. No signing in or submitting forms.</p>
                        <label className="check-field">
                          <input type="checkbox" required disabled={busy || active} />I allow this
                          read-only test.
                        </label>
                        <button
                          type="submit"
                          className="button primary"
                          disabled={busy || active || !tests.available || tests.remaining === 0}
                        >
                          {busy ? 'Please wait…' : 'Start test'}
                        </button>
                        {(!tests.available || active || tests.remaining === 0) && (
                          <small>
                            {!tests.available
                              ? 'Testing is unavailable right now.'
                              : active
                                ? 'Wait for your current test to finish.'
                                : 'You’ve used today’s three tests.'}
                          </small>
                        )}
                      </form>
                    </details>
                  ) : (
                    <TargetVerification
                      base={`/api/v1/workspaces/${workspace.id}/projects/${project.id}`}
                      onVerified={async () => setTests(await api<FreeTestsView>(base))}
                    />
                  )}
                </li>
              ))}
            </ul>
          ) : (
            !creating && (
              <div className="website-empty">
                <span className="empty-site-mark" aria-hidden="true">
                  ↗
                </span>
                <h2>Add your first website</h2>
                <p>Start with a link. Your tests and results will stay together here.</p>
              </div>
            )
          )}
        </section>
        <FreeTestHistory
          tests={tests.tests}
          explanations={tests.explanations}
          projects={projects}
          busy={busy}
          onCancel={(id) => void cancel(id)}
        />
        <section className="sample-shortcut" aria-labelledby="sample-heading">
          <div>
            <h2 id="sample-heading">Just looking around?</h2>
            <p>
              {tests.available
                ? 'Run a test on our sample website to see how it works.'
                : 'Explore a finished report from our sample website.'}
            </p>
          </div>
          {tests.available ? (
            <button
              type="button"
              className="button secondary"
              disabled={busy || active || tests.remaining === 0}
              onClick={() => void start()}
            >
              Run sample test
            </button>
          ) : (
            <Link href="/demo" className="button secondary">
              Explore the example
            </Link>
          )}
        </section>
      </main>
      <ProductFooter />
    </div>
  );
}
