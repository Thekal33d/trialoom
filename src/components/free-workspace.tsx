'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { activeFreeTest, type FreeTestsView } from '@/domain/free-tests';
import { FreeTestHistory } from './free-test-history';
import { LoomMark } from './icons';
import { api, type ProjectSummary } from './live-types';

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
  const [tests, setTests] = useState(initialTests);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const base = `/api/v1/workspaces/${workspace.id}/free-tests`;
  const active = tests.tests.some((item) => activeFreeTest(item.phase));
  useEffect(() => {
    let alive = true;
    const timer = setInterval(() => {
      void api<FreeTestsView>(base)
        .then((value) => {
          if (alive) setTests(value);
        })
        .catch(() => {
          if (alive) setError('Test status could not be refreshed. Reload to check again.');
        });
    }, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [base]);
  async function start(projectId?: string) {
    setBusy(true);
    setError('');
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
        name: String(form.get('name')),
        targetUrl: String(form.get('targetUrl')),
        environment: String(form.get('environment')),
        authorizationConfirmed: form.get('authorized') === 'on',
      });
      const result = await api<{ projects: ProjectSummary[] }>(
        `/api/v1/workspaces/${workspace.id}/projects`,
      );
      setProjects(result.projects);
      setCreating(false);
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
    <main className="auth-page free-workspace">
      <header className="free-header">
        <Link href="/workspace" className="brand">
          <LoomMark />
          <span>trialoom.</span>
        </Link>
        <button type="button" className="text-button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <section className="free-intro">
        <div className="eyebrow">YOUR FREE WORKSPACE</div>
        <h1>{workspace.name}</h1>
        <p className="section-description">
          Add the preview you want to check. Keep the results and evidence together as your product
          evolves.
        </p>
        <p className="beta-availability">
          {tests.available
            ? 'The test runner is available. Start with the prepared sample or an enabled preview.'
            : 'The test runner is offline. Your projects are saved, and you can return when testing is available.'}{' '}
          Free testing includes three requests per UTC day, one at a time. No payment setup.
        </p>
      </section>
      <section className="free-sample" aria-labelledby="sample-heading">
        <div>
          <div className="eyebrow">TRY THE FULL FLOW</div>
          <h2 id="sample-heading">See a real browser test.</h2>
          <p>
            Open our prepared sample, follow its next-page link, then inspect the results and
            recorded actions.
          </p>
          <p className="section-description">
            {tests.remaining} of 3 requests left today. Cancelled requests count toward this limit.
          </p>
        </div>
        <button
          type="button"
          className="button primary"
          disabled={busy || active || !tests.available || tests.remaining === 0}
          onClick={() => void start()}
        >
          Run sample test
        </button>
      </section>
      <section aria-labelledby="free-projects">
        <div className="section-heading">
          <h2 id="free-projects">
            Your projects <span className="neutral-label">{projects.length} / 3</span>
          </h2>
          {!creating && projects.length < 3 && (
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setCreating(true);
                setError('');
              }}
            >
              Add a project
            </button>
          )}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {creating && (
          <form
            className="app-form editor-panel"
            onSubmit={(event) => {
              event.preventDefault();
              void create(new FormData(event.currentTarget));
            }}
          >
            <label>
              Project name
              <input name="name" required maxLength={100} />
            </label>
            <label>
              Preview URL
              <input
                name="targetUrl"
                type="url"
                placeholder="https://preview.example.com"
                required
                maxLength={2048}
              />
            </label>
            <label>
              Environment
              <select name="environment" defaultValue="preview">
                <option value="preview">Preview</option>
                <option value="staging">Staging</option>
              </select>
            </label>
            <label className="check-field">
              <input name="authorized" type="checkbox" required />I own this website or have
              permission to test it.
            </label>
            <div className="status-actions">
              <button className="button primary" type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save project'}
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => setCreating(false)}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {projects.length ? (
          <ul className="free-project-list">
            {projects.map((project) => (
              <li key={project.id}>
                <h3>{project.name}</h3>
                <p>{project.target_url}</p>
                <span className="neutral-label">{project.environment}</span>
                {tests.allowedOrigins.includes(new URL(project.target_url).origin) ? (
                  <form
                    className="free-test-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void start(project.id);
                    }}
                  >
                    <label className="check-field">
                      <input type="checkbox" required disabled={busy || active} />I authorize a
                      read-only check of this page and resources on the same origin.
                    </label>
                    <p className="section-description">
                      Other origins, sign-in and form submissions stay blocked. This checks page
                      rendering; it does not certify a build.
                    </p>
                    <button
                      type="submit"
                      className="button secondary"
                      disabled={busy || active || !tests.available || tests.remaining === 0}
                    >
                      Test page
                    </button>
                  </form>
                ) : (
                  <p className="section-description">
                    Testing for this origin is awaiting enablement. You can run the prepared sample.
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          !creating && (
            <div className="empty-work">
              <h3>Your next release starts with a preview.</h3>
              <p>
                Add a project you’re authorized to test. The beta includes space for three projects.
              </p>
            </div>
          )
        )}
      </section>
      <FreeTestHistory
        tests={tests.tests}
        projects={projects}
        busy={busy}
        onCancel={(id) => void cancel(id)}
      />
      <p className="section-description">
        <Link href="/demo" className="text-link">
          See an example test and report ↗
        </Link>
      </p>
    </main>
  );
}
