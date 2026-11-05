'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AccessPanel } from './access-panel';
import { AttentionPanel } from './attention-panel';
import { Icon, LoomMark } from './icons';
import {
  api,
  field,
  type ProjectDetail,
  type ProjectSummary,
  type WorkspaceSummary,
} from './live-types';
import { MetricsPanel } from './metrics-panel';
import { ProjectPanel } from './project-panel';
export function LiveWorkspace({
  user,
  workspaces,
}: {
  user: { id: string; name: string; email: string };
  workspaces: WorkspaceSummary[];
}) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? ''),
    [view, setView] = useState<'projects' | 'access' | 'attention' | 'metrics'>('projects');
  const workspace = workspaces.find((item) => item.id === workspaceId),
    base = `/api/v1/workspaces/${workspaceId}`;
  const [projects, setProjects] = useState<ProjectSummary[]>([]),
    [detail, setDetail] = useState<ProjectDetail>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false);
  const canWrite = workspace?.role === 'owner' || workspace?.role === 'member';
  const selectedWorkspace = useRef(workspaceId);
  useEffect(() => {
    setDetail(undefined);
    setCreating(false);
    setError('');
    setProjects([]);
    setView('projects');
    if (!workspace || workspace.role === 'operator') {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    api<{ projects: ProjectSummary[] }>(`${base}/projects`)
      .then((data) => {
        if (active) setProjects(data.projects);
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
  }, [base, workspace]);
  async function open(id: string) {
    if (selectedWorkspace.current !== workspaceId) return;
    setLoading(true);
    setError('');
    try {
      const next = await api<ProjectDetail>(`${base}/projects/${id}`);
      if (selectedWorkspace.current === workspaceId) setDetail(next);
    } catch (e) {
      if (selectedWorkspace.current !== workspaceId) return;
      setDetail(undefined);
      setError(e instanceof Error ? e.message : 'Project could not be loaded.');
    } finally {
      if (selectedWorkspace.current === workspaceId) setLoading(false);
    }
  }
  async function create(form: FormData) {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ id: string }>(`${base}/projects`, 'POST', {
        name: field(form, 'name'),
        targetUrl: field(form, 'targetUrl'),
        environment: field(form, 'environment'),
        ...(field(form, 'repositoryUrl') ? { repositoryUrl: field(form, 'repositoryUrl') } : {}),
        authorizationConfirmed: form.get('authorizationConfirmed') === 'on',
      });
      setCreating(false);
      setProjects((await api<{ projects: ProjectSummary[] }>(`${base}/projects`)).projects);
      await open(result.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Project could not be created.');
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setError('');
    try {
      await api('/api/auth/sign-out', 'POST', {});
      window.location.assign('/sign-in');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign out failed.');
    }
  }
  return (
    <div className="workspace live-workspace">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link className="brand" href="/workspace">
          <LoomMark />
          <span>trialoom.</span>
        </Link>
        <label className="live-workspace-select">
          WORKSPACE
          <select
            aria-label="Workspace"
            value={workspaceId}
            disabled={busy || loading}
            onChange={(e) => {
              selectedWorkspace.current = e.target.value;
              setWorkspaceId(e.target.value);
            }}
          >
            {workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="Workspace">
          <Link className="nav-link" href="/workspace">
            My websites &amp; free checks
          </Link>
          <button
            className={`nav-link ${view === 'projects' ? 'active' : ''}`}
            type="button"
            onClick={() => {
              setView('projects');
              setDetail(undefined);
              setCreating(false);
            }}
          >
            <Icon name="overview" />
            Projects
          </button>
          <button
            className={`nav-link ${view === 'attention' ? 'active' : ''}`}
            type="button"
            onClick={() => {
              setView('attention');
              setDetail(undefined);
              setCreating(false);
              setError('');
            }}
          >
            <Icon name="overview" />
            {workspace?.role === 'reviewer' ? 'Review queue' : "What's waiting"}
          </button>
          <button
            className={`nav-link ${view === 'metrics' ? 'active' : ''}`}
            type="button"
            onClick={() => {
              setView('metrics');
              setDetail(undefined);
              setCreating(false);
              setError('');
            }}
          >
            <Icon name="book" />
            Service health
          </button>
          {workspace?.role === 'owner' && (
            <button
              className={`nav-link ${view === 'access' ? 'active' : ''}`}
              type="button"
              onClick={() => {
                setView('access');
                setError('');
              }}
            >
              <Icon name="book" />
              Workspace access
            </button>
          )}
          <Link className="nav-link" href="/operator">
            <Icon name="evidence" />
            Operator
          </Link>
          <Link className="nav-link" href="/demo">
            <Icon name="evidence" />
            Explore the demo
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <div className="viewer">
            <span className="viewer-avatar">{user.name.charAt(0)}</span>
            <div>
              <strong>{user.name}</strong>
              <span>{workspace?.role ?? 'Invited account'}</span>
            </div>
          </div>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="topbar">
          <div className="breadcrumb">
            <strong>{workspace?.name ?? 'Your workspace'}</strong>
            <span>/</span>
            {view === 'metrics'
              ? 'Pilot readiness'
              : view === 'access'
                ? 'Access'
                : view === 'attention'
                  ? workspace?.role === 'reviewer'
                    ? 'Review queue'
                    : "What's waiting"
                  : 'Projects'}
          </div>
          <Link href="/account" className="text-link">
            Account settings
          </Link>
          <button type="button" className="text-button sign-out" onClick={() => void signOut()}>
            Sign out
          </button>
        </header>
        <main id="main" className="main-content live-main">
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {!workspace ? (
            <div className="empty-work">
              <h1>No workspace access yet.</h1>
              <p>Ask a workspace owner for an invitation. Your account is signed in.</p>
            </div>
          ) : view === 'access' && workspace.role === 'owner' ? (
            <AccessPanel key={workspaceId} base={base} userId={user.id} />
          ) : view === 'attention' && workspace.role !== 'operator' ? (
            <AttentionPanel key={workspaceId} base={base} role={workspace.role} />
          ) : view === 'metrics' && workspace.role !== 'operator' ? (
            <MetricsPanel key={workspaceId} base={base} />
          ) : workspace.role === 'operator' ? (
            <div className="empty-work">
              <div className="eyebrow">OPERATOR ACCOUNT</div>
              <h1>
                Your work starts
                <br />
                with an assignment.
              </h1>
              <p>
                Project-wide materials are private. Register an operator profile, prove a payout
                wallet, and pass the seeded qualification tasks in the operator console. No work is
                claimable yet.
              </p>
              <p>
                <Link className="button primary" href="/operator">
                  Open the operator console
                </Link>
              </p>
            </div>
          ) : loading ? (
            <p role="status" className="loading-work">
              Loading your workspace…
            </p>
          ) : detail ? (
            <ProjectPanel
              key={detail.project.id}
              data={detail}
              base={`${base}/projects/${detail.project.id}`}
              canWrite={canWrite}
              isOwner={workspace?.role === 'owner'}
              canDecide={['owner', 'reviewer'].includes(workspace?.role ?? '')}
              reload={() => open(detail.project.id)}
              onBack={() => setDetail(undefined)}
            />
          ) : (
            <>
              <section className="page-heading">
                <div>
                  <div className="eyebrow">{workspace.role.toUpperCase()} / PROJECTS</div>
                  <h1>
                    A clear start
                    <br />
                    <span className="heading-accent">for every release.</span>
                  </h1>
                  <p>Your authorized previews, pinned builds, and agreed work.</p>
                </div>
                {canWrite && (
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => {
                      setCreating(!creating);
                      setError('');
                    }}
                  >
                    {creating ? 'Cancel' : 'New project'}
                  </button>
                )}
              </section>
              {creating && (
                <section className="editor-panel">
                  <h2>Connect an authorized preview</h2>
                  <p className="editor-description">
                    Use a public HTTPS preview or staging environment that you have permission to
                    test. Private and internal network targets are rejected.
                  </p>
                  <form
                    className="app-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void create(new FormData(e.currentTarget));
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
                        required
                        maxLength={2048}
                        placeholder="https://preview.your-app.com"
                      />
                    </label>
                    <label>
                      Environment
                      <select name="environment">
                        <option value="preview">Preview</option>
                        <option value="staging">Staging</option>
                      </select>
                    </label>
                    <label>
                      Repository URL (optional)
                      <input
                        name="repositoryUrl"
                        type="url"
                        maxLength={2048}
                        placeholder="https://github.com/your-team/your-app"
                      />
                    </label>
                    <small>
                      Do not include passwords, access tokens, or session links. No repository
                      access is granted by adding its URL.
                    </small>
                    <label className="check-field">
                      <input name="authorizationConfirmed" type="checkbox" required />I own this
                      target or have permission to authorize testing in this environment.
                    </label>
                    <button type="submit" className="button primary" disabled={busy}>
                      {busy ? 'Checking preview…' : 'Create project'}
                    </button>
                  </form>
                </section>
              )}
              <section className="live-section">
                <div className="section-heading">
                  <h2>
                    Projects <span className="count">{projects.length}</span>
                  </h2>
                  <span className="subtle">Private to your workspace</span>
                </div>
                {projects.length ? (
                  <div className="record-list">
                    {projects.map((project) => (
                      <button
                        type="button"
                        className="project-row"
                        key={project.id}
                        onClick={() => void open(project.id)}
                      >
                        <div>
                          <strong>{project.name}</strong>
                          <span>{project.target_url}</span>
                        </div>
                        <span className="neutral-label">{project.environment}</span>
                        <Icon name="arrow" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="empty-work">
                    <h2>
                      {canWrite ? 'Make room for your next release.' : 'No projects to review yet.'}
                    </h2>
                    <p>
                      {canWrite
                        ? 'Connect a preview you can authorize. Then pin its build and define a bounded work brief.'
                        : 'A workspace owner or member can add a project.'}
                    </p>
                  </div>
                )}
              </section>
            </>
          )}
          <footer className="page-footer">
            <span>Test. Fix. Ship.</span>
            <span>Private workspace · Accepted work is owed; no funded payment authority</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
