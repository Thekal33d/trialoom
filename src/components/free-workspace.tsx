'use client';
import Link from 'next/link';
import { useState } from 'react';
import { LoomMark } from './icons';
import { api, type ProjectSummary } from './live-types';

export function FreeWorkspace({
  workspace,
  initialProjects,
}: {
  workspace: { id: string; name: string };
  initialProjects: ProjectSummary[];
}) {
  const [projects, setProjects] = useState(initialProjects);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
          You can set up projects now. Automatic testing is being connected; no test starts or
          charges are made when you add a project.
        </p>
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
                <span className="neutral-label">{project.environment} · Ready for test setup</span>
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
      <p className="section-description">
        <Link href="/demo" className="text-link">
          See an example test and report ↗
        </Link>
      </p>
    </main>
  );
}
