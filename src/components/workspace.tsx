'use client';
import Link from 'next/link';
import { useState } from 'react';
import { journeys, report } from '@/demo/data';
import { Icon, LoomMark } from './icons';

type View = 'overview' | 'evidence' | 'payments' | 'guide';

const navigation = [
  { view: 'overview', label: 'Release overview', href: '/demo', icon: 'overview' },
  { view: 'evidence', label: 'Evidence library', href: '/demo/evidence', icon: 'evidence' },
  { view: 'payments', label: 'Payments', href: '/demo/payments', icon: 'wallet' },
] as const;

export function Workspace({ view }: { view: View }) {
  return (
    <div className="workspace">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link className="brand" href="/demo" aria-label="Trialoom overview">
          <LoomMark />
          <span>
            trialoom<span className="brand-period">.</span>
          </span>
        </Link>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <div className="workspace-picker">
          <span className="project-monogram">C</span>
          <div>
            <strong>Canopy</strong>
            <span>Example project</span>
          </div>
          <span className="picker-dot" />
        </div>
        <nav aria-label="Workspace">
          {navigation.map((item) => (
            <Link
              key={item.view}
              href={item.href}
              className={`nav-link ${view === item.view ? 'active' : ''}`}
              aria-current={view === item.view ? 'page' : undefined}
            >
              <Icon name={item.icon} />
              {item.label}
              {item.view === 'evidence' && <span className="nav-count">1</span>}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="small-label">A LITTLE MORE CERTAINTY</span>
            <p>
              Useful tests.
              <br />
              Reproducible findings.
              <br />
              Fixes you can verify.
            </p>
            <span className="woven-lines" aria-hidden="true" />
          </div>
          <Link
            className={`nav-link guide-link ${view === 'guide' ? 'active' : ''}`}
            href="/demo/guide"
          >
            <Icon name="book" />
            How Trialoom works
          </Link>
          <div className="viewer">
            <span className="viewer-avatar">Y</span>
            <div>
              <strong>Your builder view</strong>
              <span>Demo workspace</span>
            </div>
          </div>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> <strong>Canopy</strong>
          </div>
          <div className="demo-entry">
            <Link className="text-link" href="/workspace">
              My workspace ↗
            </Link>
            <span className="demo-badge">
              <span />
              Demo workspace
            </span>
          </div>
        </header>
        <main id="main" className="main-content">
          <div className="demo-notice">
            Explore a sample release. No live assignments or payments.
          </div>
          {view === 'overview' ? (
            <Overview />
          ) : view === 'evidence' ? (
            <Evidence />
          ) : view === 'payments' ? (
            <Payments />
          ) : (
            <Guide />
          )}
          <footer className="page-footer">
            <span>Test. Fix. Ship.</span>
            <Link href="/demo/guide">
              How Trialoom works <span aria-hidden="true">↗</span>
            </Link>
          </footer>
        </main>
      </div>
    </div>
  );
}

function Overview() {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const shown = journeys.filter(
    (journey) =>
      (filter === 'all' || journey.status === filter) &&
      journey.title.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <section className="page-heading">
        <div>
          <div className="eyebrow">CANOPY / ONBOARDING</div>
          <h1>
            Your release,
            <br />
            <span className="heading-accent">in focus.</span>
          </h1>
          <p>From “something’s broken” to a fix you can trust.</p>
        </div>
        <Link className="button primary" href="/demo/evidence">
          View reproduction <Icon name="arrow" />
        </Link>
      </section>
      <section className="release-track" aria-label="Release progress">
        <div className="track-step">
          <span className="step-icon complete">
            <Icon name="check" />
          </span>
          <div>
            <strong>Tested</strong>
            <span>Two clean runs</span>
          </div>
        </div>
        <div className="track-line" />
        <div className="track-step">
          <span className="step-icon complete">
            <Icon name="check" />
          </span>
          <div>
            <strong>Reproduced</strong>
            <span>Same defect, twice</span>
          </div>
        </div>
        <div className="track-line" />
        <div className="track-step">
          <span className="step-icon complete">
            <Icon name="check" />
          </span>
          <div>
            <strong>Fix checked</strong>
            <span>Regression passes</span>
          </div>
        </div>
        <div className="track-line pending" />
        <div className="track-step">
          <span className="step-icon waiting">
            <Icon name="clock" />
          </span>
          <div>
            <strong>Independent review</strong>
            <span>Next step</span>
          </div>
        </div>
      </section>
      <div className="overview-grid">
        <div className="main-column">
          <section aria-labelledby="journeys-title" className="journeys-section">
            <div className="section-heading">
              <h2 id="journeys-title">
                Journeys <span className="count">03</span>
              </h2>
              <span className="subtle">Recorded 26 Oct</span>
            </div>
            <div className="list-controls">
              <fieldset className="filters" aria-label="Filter journeys">
                {[
                  ['all', 'All'],
                  ['review', 'Needs review'],
                  ['passed', 'Passed'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={filter === value ? 'selected' : ''}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </fieldset>
              <label className="search">
                <Icon name="search" />
                <input
                  aria-label="Find a journey"
                  placeholder="Find a journey"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            </div>
            <div className="journey-list">
              {shown.length ? (
                shown.map((journey, index) => (
                  <div className="journey-row" key={journey.id}>
                    <span className="journey-index">0{index + 1}</span>
                    <div className="journey-name">
                      <Link href={`/demo/evidence#${journey.id}`}>{journey.title}</Link>
                      <span>{journey.description}</span>
                    </div>
                    <div className="journey-result">
                      <span className={`status ${journey.status}`}>
                        <span />
                        {journey.result}
                      </span>
                      <span>{journey.runs}</span>
                    </div>
                    <Link
                      className="row-open"
                      href={`/demo/evidence#${journey.id}`}
                      aria-label={`Inspect ${journey.title}`}
                    >
                      <Icon name="arrow" />
                    </Link>
                  </div>
                ))
              ) : (
                <div className="empty-results">
                  <h3>No matching journeys</h3>
                  <p>Try another phrase, or clear your filters.</p>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setFilter('all');
                      setQuery('');
                    }}
                  >
                    Show all journeys <Icon name="arrow" />
                  </button>
                </div>
              )}
            </div>
            <p className="list-caption">
              A product failure is a useful finding. The evidence tells the story.
            </p>
          </section>
          <section className="repair-summary">
            <div>
              <div className="eyebrow">THE FIX, CHECKED</div>
              <h2>
                Same journey.
                <br />A different outcome.
              </h2>
              <p>The regression fails on the original build and passes on the candidate.</p>
              <Link className="text-link" href="/demo/evidence#comparison">
                Compare the evidence <Icon name="arrow" />
              </Link>
            </div>
            <div className="comparison-preview">
              <div>
                <span>Original build</span>
                <strong className="original-value">
                  400 <small>Rejected</small>
                </strong>
                <span className="result-rule original" />
              </div>
              <div>
                <span>Candidate build</span>
                <strong>
                  201 <small>Created</small>
                </strong>
                <span className="result-rule candidate" />
              </div>
              <p>
                <Icon name="clock" />
                Independent review still needed
              </p>
            </div>
          </section>
        </div>
        <aside className="release-aside">
          <section className="finding-brief">
            <div className="brief-top">
              <span className="small-label">ONE FINDING TO REVIEW</span>
              <span className="brief-number">01</span>
            </div>
            <div className="alias-illustration" aria-hidden="true">
              <span>alex</span>
              <span className="plus-sign">+</span>
              <span>design</span>
              <div className="alias-line" />
              <small>@example.test</small>
            </div>
            <h2>
              Invitations stop
              <br />
              at the + sign.
            </h2>
            <p>
              A valid email alias is rejected. The candidate fix accepts it and preserves the
              existing checks.
            </p>
            <Link href="/demo/evidence" className="brief-link">
              Inspect finding <Icon name="arrow" />
            </Link>
          </section>
          <section className="approval-note">
            <Icon name="wallet" />
            <h3>Your approval comes first.</h3>
            <p>
              Accepted work and payment status stay visible separately. Spending authorization is
              never described as escrow.
            </p>
            <Link className="text-link" href="/demo/payments">
              Understand payments <Icon name="arrow" />
            </Link>
          </section>
        </aside>
      </div>
    </>
  );
}

function Evidence() {
  const [build, setBuild] = useState<'baseline' | 'candidate'>('baseline');
  const selected = report[build];
  return (
    <>
      <section className="page-heading compact">
        <div>
          <div className="eyebrow">EVIDENCE LIBRARY / FINDING 01</div>
          <h1>
            See what
            <br />
            <span className="heading-accent">actually happened.</span>
          </h1>
          <p>A reproducible finding, a reviewable fix, and the checks behind it.</p>
        </div>
        <a className="button secondary" href="/api/demo/report" download>
          <Icon name="download" />
          Export demo report
        </a>
      </section>
      <section className="evidence-detail" id="plus-address">
        <div className="detail-heading">
          <div>
            <span className="status review">
              <span />
              Independent review needed
            </span>
            <h2>Plus-address invitations are rejected</h2>
          </div>
          <span className="subtle">Invitation fixture · 26 Oct 2026</span>
        </div>
        <div className="evidence-grid">
          <div>
            <h3>Reproduce the finding</h3>
            <ol className="repro-steps">
              <li>
                <span>01</span>
                <div>
                  <strong>Start a clean browser session</strong>
                  <p>Use the invitation fixture and its pinned original build.</p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <strong>Enter an email alias</strong>
                  <p>
                    <code>alex+design@example.test</code>
                  </p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <strong>Send the invitation</strong>
                  <p>Expect a new invitation. The original build rejects the address.</p>
                </div>
              </li>
            </ol>
          </div>
          <div className="observation" id="comparison">
            <fieldset className="filters build-switch" aria-label="Compare builds">
              <button
                type="button"
                aria-pressed={build === 'baseline'}
                className={build === 'baseline' ? 'selected' : ''}
                onClick={() => setBuild('baseline')}
              >
                Original build
              </button>
              <button
                type="button"
                aria-pressed={build === 'candidate'}
                className={build === 'candidate' ? 'selected' : ''}
                onClick={() => setBuild('candidate')}
              >
                Candidate build
              </button>
            </fieldset>
            <div aria-live="polite">
              <span className="small-label">OBSERVED RESPONSE</span>
              <div className={`response-code ${build === 'baseline' ? 'failed' : ''}`}>
                {selected.httpStatus}
                <span>{build === 'baseline' ? 'Invitation rejected' : 'Invitation created'}</span>
              </div>
              <dl>
                <div>
                  <dt>Expected response</dt>
                  <dd>201 Created</dd>
                </div>
                <div>
                  <dt>Clean replays</dt>
                  <dd>2 / 2</dd>
                </div>
                <div>
                  <dt>Regression</dt>
                  <dd>{build === 'baseline' ? 'Fails as expected' : 'Passes'}</dd>
                </div>
                <div>
                  <dt>Build fingerprint</dt>
                  <dd>
                    <code title={selected.build}>{selected.build.slice(0, 12)}</code>
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
        <div className="review-boundary">
          <Icon name="clock" />
          <p>
            <strong>Technical checks pass. Independent review is next.</strong>
            <br />
            The same operator produced this fixture evidence. It has not been accepted as
            independently verified marketplace work.
          </p>
        </div>
      </section>
      <section className="supporting-checks">
        <h2>Existing behavior, preserved</h2>
        {journeys.slice(1).map((journey) => (
          <div id={journey.id} key={journey.id} className="supporting-row">
            <Icon name="check" />
            <div>
              <strong>{journey.title}</strong>
              <p>{journey.note}</p>
            </div>
            <span className="status passed">
              <span />
              Passed
            </span>
          </div>
        ))}
      </section>
    </>
  );
}

function Payments() {
  return (
    <>
      <section className="page-heading compact">
        <div>
          <div className="eyebrow">CANOPY / PAYMENTS</div>
          <h1>
            Good work.
            <br />
            <span className="heading-accent">Clear obligations.</span>
          </h1>
          <p>Review what is committed, what is owed, and what has settled.</p>
        </div>
        <span className="neutral-label">No spending authorized</span>
      </section>
      <section className="payments-empty">
        <div className="empty-emblem">
          <Icon name="wallet" width="32" height="32" />
        </div>
        <div>
          <h2>No accepted work to pay yet.</h2>
          <p>
            This example has a candidate fix awaiting independent review.
            <br />
            No payment has been authorized for this demo project.
          </p>
          <Link className="button primary" href="/demo/evidence">
            Review the evidence <Icon name="arrow" />
          </Link>
        </div>
      </section>
      <section className="payment-explainer">
        <div>
          <span className="small-label">01 / AUTHORIZATION</span>
          <h2>
            Permission to spend,
            <br />
            with clear limits.
          </h2>
          <p>
            A builder approves a token, spending limits, expiry, and recipients. Funds remain in the
            builder’s wallet. Authorization is not escrow.
          </p>
        </div>
        <div>
          <span className="small-label">02 / ACCEPTED WORK</span>
          <h2>
            Work can be complete.
            <br />
            Payment can be pending.
          </h2>
          <p>
            An accepted obligation remains visible even if funding or authorization disappears. A
            transaction is paid only after finalized verification.
          </p>
        </div>
      </section>
      <div className="currency-note">
        <span className="currency-symbol">$</span>
        <span>
          Planned settlement: <strong>USDC on Celo</strong>
          <br />
          <small>Live payments are not enabled in this preview.</small>
        </span>
      </div>
    </>
  );
}

function Guide() {
  return (
    <>
      <section className="page-heading compact">
        <div>
          <div className="eyebrow">A GUIDE TO TRIALOOM</div>
          <h1>
            Less guesswork.
            <br />
            <span className="heading-accent">Better releases.</span>
          </h1>
          <p>One connected path from a test to an independently verified fix.</p>
        </div>
      </section>
      <div className="guide-steps">
        {[
          [
            'Choose a journey',
            'Start with an authorized preview, a pinned build, and a bounded scope. Agree on the deliverable and acceptance criteria before work begins.',
          ],
          [
            'Follow the evidence',
            'A useful result records the steps, expected and actual outcomes, and enough evidence to reproduce them in a clean environment.',
          ],
          [
            'Verify the repair',
            'The regression must fail on the original build and pass on the candidate. A different operator verifies the work; you keep control of merge and deployment.',
          ],
          [
            'Keep the obligations clear',
            'Valid execution can earn its fee even when it exposes a product failure. Accepted work and payment settlement are tracked separately.',
          ],
        ].map(([title, body], index) => (
          <section key={title}>
            <span>0{index + 1}</span>
            <div>
              <h2>{title}</h2>
              <p>{body}</p>
            </div>
          </section>
        ))}
      </div>
      <Link className="button primary" href="/demo">
        Explore the example <Icon name="arrow" />
      </Link>
    </>
  );
}
