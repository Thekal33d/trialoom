'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Icon, LoomMark } from '@/components/icons';
import { api, field } from '@/components/live-types';
import { agentScopes } from '@/domain/schemas';

type Wallet = {
  id: string;
  chain_id: number;
  address: string;
  account_type: string;
  verified_at: string;
  payout_designated_at: string | null;
  revoked_at: string | null;
};
type Credential = {
  id: string;
  name: string;
  scopes: string[];
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};
type Overview = {
  operator: { id: string; handle: string; status: string } | null;
  wallets: Wallet[];
  credentials: Credential[];
  eligibility: {
    service: string;
    state: string;
    reason: string;
    tasks_passed: number;
    tasks_total: number;
    attempts: number;
    correct: number;
    false_reports: number;
  }[];
  admissions: { id: string; name: string }[];
};
type Qualification = {
  accuracyFloor: number;
  tasks: {
    slug: string;
    version: number;
    service: string;
    brief: { instructions: string; reportFields: string[] };
    max_attempts: number;
    attempts_used: number;
    passed: boolean | null;
    false_reported: boolean | null;
  }[];
};
type Challenge = { nonce: string; message: string; expiresAt: string; chainId: number };
type Work = {
  items: {
    campaign_id: string;
    name: string;
    workspace: string;
    service: string;
    price_units: string;
    deadline: string;
    slots: number;
    slots_used: number;
    available_units: string;
    already_claimed: boolean;
    terms_version_id: string;
    version: number;
  }[];
  unavailable: { code: string; message: string }[];
};
type Assignments = {
  assignments: {
    id: string;
    campaign: string;
    service: string;
    state: string;
    terms_version: number;
    max_liability_units: string;
    lease_expires_at: string;
    deadline: string;
    closed_reason: string | null;
  }[];
};
const units = (value: string) => `${(Number(value) / 1_000_000).toFixed(2)} USDC`;
const reasons: Record<string, string> = {
  qualified: 'Every seeded task for this service is passed.',
  incomplete: 'Some seeded tasks for this service are not passed yet.',
  false_report: 'A false report was recorded. This needs a reviewer, not another attempt.',
  accuracy_below_threshold: 'Too many attempts were spent per passed task.',
};

export function OperatorConsole({ user }: { user: { name: string; email: string } }) {
  const [data, setData] = useState<Overview>();
  const [qualification, setQualification] = useState<Qualification>();
  const [challenge, setChallenge] = useState<Challenge>();
  const [work, setWork] = useState<Work>();
  const [assignments, setAssignments] = useState<Assignments>();
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const load = useCallback(async () => {
    const overview = await api<Overview>('/api/v1/operator');
    setData(overview);
    if (overview.operator) {
      setQualification(await api<Qualification>('/api/v1/operator/qualification'));
      setWork(await api<Work>('/api/v1/operator/work'));
      setAssignments(await api<Assignments>('/api/v1/operator/assignments'));
    }
  }, []);
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Console could not be loaded.'));
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
  function copy(label: string, value: string) {
    navigator.clipboard
      .writeText(value)
      .then(() => setCopied(label))
      .catch(() => setError('Select and copy the text manually.'));
  }
  const operator = data?.operator;
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
        <nav aria-label="Operator">
          <Link className="nav-link" href="/workspace">
            <Icon name="overview" />
            Workspaces
          </Link>
          <span className="nav-link active">
            <Icon name="book" />
            Operator
          </span>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="small-label">EARNING STARTS WITH PROOF</span>
            <p>
              Prove the wallet.
              <br />
              Pass the seeded tasks.
              <br />
              Keep credentials narrow.
            </p>
          </div>
          <div className="viewer">
            <span className="viewer-avatar">{user.name.charAt(0)}</span>
            <div>
              <strong>{user.name}</strong>
              <span>{operator ? `@${operator.handle}` : 'No operator profile'}</span>
            </div>
          </div>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="topbar">
          <div className="breadcrumb">
            <strong>Operator</strong>
            <span>/</span>
            {operator ? 'Connection' : 'Registration'}
          </div>
        </header>
        <main id="main" className="main-content live-main">
          <section className="page-heading compact">
            <div>
              <div className="eyebrow">OPERATOR / CONNECTION</div>
              <h1>
                Prove who you are.
                <br />
                <span className="heading-accent">Then prove the work.</span>
              </h1>
              <p>
                A wallet signature proves you control a payout address. It is attribution, not
                evidence of correct work, and it authorizes no spending.
              </p>
            </div>
          </section>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {!data ? (
            <p role="status" className="loading-work">
              Loading your operator console…
            </p>
          ) : !operator ? (
            <section className="editor-panel">
              <h2>Register an operator profile</h2>
              <p className="editor-description">
                Your handle is permanent and belongs to this account. Builders admit you to their
                work through a workspace invitation.
              </p>
              <form
                className="app-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void run(async () => {
                    await api('/api/v1/operator', 'POST', { handle: field(form, 'handle') });
                  }, 'Registration failed.');
                }}
              >
                <label>
                  Operator handle
                  <input name="handle" required maxLength={40} placeholder="your-agent-name" />
                </label>
                <small>Three to forty lowercase letters, digits, or hyphens.</small>
                <button type="submit" className="button primary" disabled={busy}>
                  Register
                </button>
              </form>
            </section>
          ) : (
            <>
              <section className="live-section">
                <div className="section-heading">
                  <h2>
                    Proven wallets{' '}
                    <span className="count">
                      {data.wallets.filter((w) => !w.revoked_at).length}
                    </span>
                  </h2>
                  <span className="subtle">Celo chain {challenge?.chainId ?? 42220}</span>
                </div>
                <div className="record-list">
                  {data.wallets.map((wallet) => (
                    <div className="member-row" key={wallet.id}>
                      <div>
                        <strong className="break-text">{wallet.address}</strong>
                        <p>
                          {wallet.account_type.toUpperCase()} · proven{' '}
                          {new Date(wallet.verified_at).toLocaleString()}
                          {wallet.revoked_at ? ' · revoked' : ''}
                        </p>
                      </div>
                      <span className="neutral-label">
                        {wallet.revoked_at
                          ? 'revoked'
                          : wallet.payout_designated_at
                            ? 'payout'
                            : 'proven'}
                      </span>
                      {!wallet.revoked_at && (
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api(`/api/v1/operator/wallets/${wallet.id}`, 'DELETE');
                            }, 'The wallet could not be revoked.')
                          }
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {!data.wallets.length && (
                  <p className="section-description">No wallet is proven for this operator yet.</p>
                )}
              </section>
              <section className="editor-panel">
                <h2>Prove a payout wallet</h2>
                <p className="editor-description">
                  Request a challenge, sign the exact message in your own wallet, and paste the
                  signature. Never paste a private key or seed phrase here, and never share one.
                </p>
                <form
                  className="app-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void run(async () => {
                      setChallenge(
                        await api<Challenge>('/api/v1/operator/wallet-challenges', 'POST', {
                          address: field(form, 'address'),
                        }),
                      );
                    }, 'The challenge could not be created.');
                  }}
                >
                  <label>
                    Wallet address
                    <input name="address" required maxLength={42} placeholder="0x…" />
                  </label>
                  <button type="submit" className="button primary" disabled={busy}>
                    Request challenge
                  </button>
                </form>
                {challenge && (
                  <form
                    className="app-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      void run(async () => {
                        await api('/api/v1/operator/wallets', 'POST', {
                          nonce: challenge.nonce,
                          signature: field(form, 'signature'),
                          designatePayout: form.get('designatePayout') === 'on',
                        });
                        setChallenge(undefined);
                      }, 'The signature was not accepted.');
                    }}
                  >
                    <label>
                      Message to sign
                      <textarea
                        readOnly
                        rows={9}
                        value={challenge.message}
                        onFocus={(event) => event.target.select()}
                      />
                    </label>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => copy('message', challenge.message)}
                    >
                      {copied === 'message' ? 'Copied' : 'Copy message'}
                    </button>
                    <small>
                      This challenge expires {new Date(challenge.expiresAt).toLocaleString()} and
                      can be used once.
                    </small>
                    <label>
                      Signature
                      <input name="signature" required maxLength={132} placeholder="0x…" />
                    </label>
                    <label className="check-field">
                      <input name="designatePayout" type="checkbox" defaultChecked />
                      Use this wallet as my payout address.
                    </label>
                    <button type="submit" className="button primary" disabled={busy}>
                      Submit proof
                    </button>
                  </form>
                )}
              </section>
              <section className="live-section">
                <div className="section-heading">
                  <h2>
                    Agent credentials{' '}
                    <span className="count">
                      {data.credentials.filter((item) => !item.revoked_at).length}
                    </span>
                  </h2>
                  <span className="subtle">Bearer tokens for the agent API</span>
                </div>
                <p className="section-description">
                  A credential reads work and submits qualification attempts. No scope can claim
                  work, move money, or sign a payout.
                </p>
                <div className="record-list">
                  {data.credentials.map((credential) => (
                    <div className="member-row" key={credential.id}>
                      <div>
                        <strong>{credential.name}</strong>
                        <p>
                          {credential.scopes.join(' · ')} · expires{' '}
                          {new Date(credential.expires_at).toLocaleDateString()}
                          {credential.last_used_at
                            ? ` · last used ${new Date(credential.last_used_at).toLocaleString()}`
                            : ' · never used'}
                        </p>
                      </div>
                      <span className="neutral-label">
                        {credential.revoked_at
                          ? 'revoked'
                          : new Date(credential.expires_at) <= new Date()
                            ? 'expired'
                            : 'active'}
                      </span>
                      {!credential.revoked_at && (
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api(`/api/v1/operator/credentials/${credential.id}`, 'DELETE');
                            }, 'The credential could not be revoked.')
                          }
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <form
                  className="app-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void run(async () => {
                      const created = await api<{ secret: string }>(
                        '/api/v1/operator/credentials',
                        'POST',
                        {
                          name: field(form, 'name'),
                          scopes: agentScopes.filter((scope) => form.get(scope) === 'on'),
                          expiresInDays: Number(field(form, 'expiresInDays')),
                        },
                      );
                      setSecret(created.secret);
                    }, 'The credential could not be created.');
                  }}
                >
                  <label>
                    Credential name
                    <input name="name" required maxLength={60} placeholder="Runner" />
                  </label>
                  <fieldset className="check-group">
                    <legend>Scopes</legend>
                    {agentScopes.map((scope) => (
                      <label className="check-field" key={scope}>
                        <input name={scope} type="checkbox" defaultChecked />
                        {scope}
                      </label>
                    ))}
                  </fieldset>
                  <label>
                    Expires in days
                    <input
                      name="expiresInDays"
                      type="number"
                      min={1}
                      max={90}
                      defaultValue={30}
                      required
                    />
                  </label>
                  <button type="submit" className="button primary" disabled={busy}>
                    Create credential
                  </button>
                </form>
                {secret && (
                  <div className="invitation-result">
                    <label>
                      New credential secret
                      <input
                        aria-label="New credential secret"
                        readOnly
                        value={secret}
                        onFocus={(event) => event.target.select()}
                      />
                    </label>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => copy('secret', secret)}
                    >
                      {copied === 'secret' ? 'Copied' : 'Copy secret'}
                    </button>
                  </div>
                )}
                {secret && (
                  <p className="section-description">
                    This secret is shown once and is stored only as a digest. Keep it out of source
                    control and logs. Revoke it if it is exposed.
                  </p>
                )}
              </section>
              <section className="live-section">
                <h2>Qualification</h2>
                <p className="section-description">
                  Seeded tasks measure execution accuracy and false reporting. Submit attempts
                  through the agent API; results are graded server-side against a fixed answer key.
                </p>
                {qualification?.tasks.map((task) => (
                  <div className="member-row" key={`${task.slug}-${task.version}`}>
                    <div>
                      <strong>
                        {task.slug} v{task.version}
                      </strong>
                      <p>
                        {task.service} · {task.attempts_used} of {task.max_attempts} attempts used ·
                        reports {task.brief.reportFields.join(', ')}
                      </p>
                    </div>
                    <span className="neutral-label">
                      {task.false_reported
                        ? 'false report'
                        : task.passed
                          ? 'passed'
                          : task.attempts_used
                            ? 'not passed'
                            : 'not started'}
                    </span>
                  </div>
                ))}
                <h3>Eligibility</h3>
                {data.eligibility.length ? (
                  <ol className="audit-list">
                    {data.eligibility.map((entry) => (
                      <li key={entry.service}>
                        <div>
                          <strong>
                            {entry.service}: {entry.state}
                          </strong>
                          <span>
                            {reasons[entry.reason] ?? entry.reason} {entry.tasks_passed}/
                            {entry.tasks_total} tasks, {entry.correct}/{entry.attempts} attempts
                            correct, {entry.false_reports} false reports.
                          </span>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="section-description">
                    No attempt has been graded yet, so no service is eligible.
                  </p>
                )}
              </section>
              <section className="live-section">
                <div className="section-heading">
                  <h2>
                    Available work <span className="count">{work?.items.length ?? 0}</span>
                  </h2>
                  <span className="subtle">Claim through the agent API</span>
                </div>
                <p className="section-description">
                  Builders who admitted you:{' '}
                  {data.admissions.length
                    ? data.admissions.map((item) => item.name).join(', ')
                    : 'none yet'}
                  . A claim pins one exact terms version and build and reserves its maximum
                  liability against the campaign budget. Acceptance decisions, evidence, and payouts
                  are not implemented yet, so no work here can be paid.
                </p>
                {work?.items.length ? (
                  <div className="record-list">
                    {work.items.map((item) => (
                      <div className="member-row" key={item.campaign_id}>
                        <div>
                          <strong>{item.name}</strong>
                          <p>
                            {item.workspace} · {item.service} · terms v{item.version} ·{' '}
                            {units(item.price_units)} · {item.slots_used} of {item.slots} slots
                            taken · {units(item.available_units)} budget left · due{' '}
                            {new Date(item.deadline).toLocaleString()}
                          </p>
                        </div>
                        <span className="neutral-label">
                          {item.already_claimed ? 'claimed by you' : 'open'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <ul className="plain-list">
                    {work?.unavailable.map((entry) => (
                      <li key={entry.code}>{entry.message}</li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="live-section">
                <div className="section-heading">
                  <h2>
                    Your assignments{' '}
                    <span className="count">{assignments?.assignments.length ?? 0}</span>
                  </h2>
                  <span className="subtle">Attempt tokens are shown once, to the agent</span>
                </div>
                {assignments?.assignments.length ? (
                  <div className="record-list">
                    {assignments.assignments.map((item) => (
                      <div className="member-row" key={item.id}>
                        <div>
                          <strong>{item.campaign}</strong>
                          <p>
                            {item.service} · terms v{item.terms_version} · reserves{' '}
                            {units(item.max_liability_units)} ·{' '}
                            {['claimed', 'running'].includes(item.state)
                              ? `lease until ${new Date(item.lease_expires_at).toLocaleString()}`
                              : (item.closed_reason ?? 'closed')}
                          </p>
                        </div>
                        <span className="neutral-label">{item.state}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="section-description">No assignment has been claimed yet.</p>
                )}
                <p className="section-description">
                  Agent API: <code>GET /api/agent/v1/work</code>,{' '}
                  <code>POST /api/agent/v1/assignments</code> with an <code>Idempotency-Key</code>{' '}
                  header, then <code>POST /api/agent/v1/assignments/:id/heartbeat</code> or{' '}
                  <code>/release</code> with the attempt token. Send your credential as{' '}
                  <code>Authorization: Bearer</code>.
                </p>
              </section>
            </>
          )}
          <footer className="page-footer">
            <span>Test. Fix. Ship.</span>
            <span>Operator connection · No acceptance decisions or payouts yet</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
