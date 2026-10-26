'use client';
import { useState } from 'react';
import { formatUnits } from '@/domain/values';
import type { ProjectDetail, TermsRecord } from './live-types';
import { api, field } from './live-types';
import { TermsForm } from './terms-form';
export function ProjectPanel({
  data,
  base,
  canWrite,
  reload,
  onBack,
}: {
  data: ProjectDetail;
  base: string;
  canWrite: boolean;
  reload: () => Promise<void>;
  onBack: () => void;
}) {
  const [editor, setEditor] = useState<'build' | 'terms' | null>(null),
    [current, setCurrent] = useState<TermsRecord>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function pin(form: FormData) {
    setBusy(true);
    setError('');
    try {
      await api(`${base}/builds`, 'POST', {
        revision: field(form, 'revision'),
        fixtureVersion: field(form, 'fixtureVersion'),
        targetUrl: field(form, 'targetUrl'),
      });
      await reload();
      setEditor(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not pin the build.');
    } finally {
      setBusy(false);
    }
  }
  async function save(name: string, terms: unknown) {
    await api(
      current ? `${base}/campaigns/${current.campaign_id}/terms` : `${base}/campaigns`,
      'POST',
      current ? terms : { name, terms },
    );
    await reload();
    setEditor(null);
  }
  return (
    <>
      <button type="button" className="text-button back-button" onClick={onBack}>
        ← All projects
      </button>
      <section className="page-heading compact">
        <div>
          <div className="eyebrow">{data.project.environment.toUpperCase()} / PRIVATE PROJECT</div>
          <h1>{data.project.name}</h1>
          <p className="break-text">{data.project.target_url}</p>
        </div>
        <span className="neutral-label">Testing permission recorded</span>
      </section>
      <div className="project-context">
        <span>
          Approved origin <strong>{data.project.authorized_origin}</strong>
        </span>
        <span>
          Permission recorded{' '}
          <strong>{new Date(data.project.authorized_at).toLocaleDateString()}</strong>
        </span>
      </div>
      {editor === 'terms' ? (
        <TermsForm
          builds={data.builds}
          current={current}
          onSave={save}
          onCancel={() => setEditor(null)}
        />
      ) : (
        <>
          <section className="live-section">
            <div className="section-heading">
              <h2>
                Pinned builds <span className="count">{data.builds.length}</span>
              </h2>
              {canWrite && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setEditor(editor === 'build' ? null : 'build');
                    setError('');
                  }}
                >
                  {editor === 'build' ? 'Cancel' : 'Pin a build'}
                </button>
              )}
            </div>
            {editor === 'build' && (
              <form
                className="app-form editor-panel"
                onSubmit={(event) => {
                  event.preventDefault();
                  void pin(new FormData(event.currentTarget));
                }}
              >
                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="form-pair">
                  <label>
                    Revision or deployment ID
                    <input
                      name="revision"
                      required
                      maxLength={200}
                      placeholder="Commit SHA or immutable deployment ID"
                    />
                  </label>
                  <label>
                    Fixture version
                    <input
                      name="fixtureVersion"
                      required
                      maxLength={200}
                      placeholder="invitation-fixture-v1"
                    />
                  </label>
                </div>
                <label>
                  Build preview URL
                  <input
                    name="targetUrl"
                    type="url"
                    required
                    maxLength={2048}
                    defaultValue={data.project.target_url}
                  />
                </label>
                <small>
                  Use this project’s approved origin. Each build record is permanent; pin a new
                  record when the deployment or fixture changes.
                </small>
                <button type="submit" className="button primary" disabled={busy}>
                  {busy ? 'Checking target…' : 'Save pinned build'}
                </button>
              </form>
            )}
            {data.builds.length ? (
              <div className="record-list">
                {data.builds.map((build) => (
                  <div className="build-row" key={build.id}>
                    <div>
                      <strong>{build.revision}</strong>
                      <p>{build.fixture_version}</p>
                    </div>
                    <span className="break-text">{build.target_url}</span>
                    <small>{new Date(build.created_at).toLocaleDateString()}</small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-work">
                <h3>Give the work a known starting point.</h3>
                <p>Pin a build and fixture version before preparing a work brief.</p>
              </div>
            )}
          </section>
          <section className="live-section">
            <div className="section-heading">
              <h2>Work briefs</h2>
              {canWrite && data.builds.length > 0 && (
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    setCurrent(undefined);
                    setEditor('terms');
                  }}
                >
                  New work brief
                </button>
              )}
            </div>
            <p className="section-description">
              Drafts record scope and delivery terms. They are not published, funded, or available
              to claim.
            </p>
            {data.campaigns.length ? (
              data.campaigns.map((campaign) => {
                const versions = data.terms.filter((term) => term.campaign_id === campaign.id);
                return (
                  <article className="brief-record" key={campaign.id}>
                    <div className="section-heading">
                      <div>
                        <span className="status review">Draft · v{campaign.latest_version}</span>
                        <h3>{campaign.name}</h3>
                      </div>
                      {canWrite && (
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => {
                            setCurrent(versions[0]);
                            setEditor('terms');
                          }}
                        >
                          Revise terms
                        </button>
                      )}
                    </div>
                    <div className="version-list">
                      {versions.map((term) => (
                        <TermVersion
                          key={term.id}
                          term={term}
                          builds={data.builds}
                          latest={term.version === campaign.latest_version}
                        />
                      ))}
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="empty-work">
                <h3>Clear terms come before a claim.</h3>
                <p>
                  Define the journey, permitted actions, price, acceptance criteria, deadline, and
                  artifact rights.
                </p>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
function TermVersion({
  term,
  builds,
  latest,
}: {
  term: TermsRecord;
  builds: ProjectDetail['builds'];
  latest: boolean;
}) {
  const d = term.document,
    build = builds.find((b) => b.id === term.build_id);
  return (
    <details className="terms-version" open={latest}>
      <summary>
        Version {term.version}{' '}
        <span>
          {latest ? 'Current draft' : 'Preserved version'} ·{' '}
          {new Date(term.created_at).toLocaleDateString()}
        </span>
      </summary>
      <div className="version-content">
        <div className="terms-facts">
          <span>
            Service
            <strong>
              {
                { test: 'Journey test', bug_discovery: 'Bug discovery', repair: 'Repair' }[
                  d.service
                ]
              }
            </strong>
          </span>
          <span>
            Build<strong>{build?.revision}</strong>
          </span>
          <span>
            Fixture<strong>{build?.fixture_version}</strong>
          </span>
          <span>
            Price<strong>{formatUnits(d.priceUnits)} USDC</strong>
          </span>
          <span>
            Delivery deadline<strong>{new Date(d.deadline).toLocaleString()}</strong>
          </span>
        </div>
        <h4>Scope</h4>
        <p>{d.scope}</p>
        <div className="form-pair">
          <div>
            <h4>Permitted actions</h4>
            <ul>
              {d.allowedActions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4>Exclusions</h4>
            <p>{d.exclusions.join('; ') || 'None specified'}</p>
          </div>
        </div>
        <h4>Acceptance criteria</h4>
        <p>{d.acceptanceCriteria}</p>
        <h4>Discovery reward rules</h4>
        <p>{d.rewardRubric}</p>
        <p>
          Discovery cap: {formatUnits(d.discoveryRewardCapUnits)} USDC · Resource allowance:{' '}
          {formatUnits(d.resourceAllowanceUnits)} USDC · Fee:{' '}
          {formatUnits(String(d.platformFeeBps), 2)}% · Review: {d.reviewWindowHours} hours
        </p>
        <h4>Artifact rights</h4>
        <p>{d.artifactRights}</p>
        <h4>Payment and resource terms</h4>
        <p>{d.paymentTerms}</p>
        <details className="fingerprint">
          <summary>Version identity</summary>
          <p>
            Terms ID: <code>{term.id}</code>
          </p>
          <p>
            Content SHA-256: <code>{term.content_hash}</code>
          </p>
          <p>
            USDC · Celo {d.currency.chainId} · <code>{d.currency.address}</code>
          </p>
        </details>
      </div>
    </details>
  );
}
