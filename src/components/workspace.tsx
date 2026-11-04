'use client';
import Link from 'next/link';
import { useState } from 'react';
import { journeys, report } from '@/demo/data';
import { ProductFooter, ProductHeader } from './product-shell';

type View = 'overview' | 'evidence' | 'payments' | 'guide';
export function Workspace({ view }: { view: View }) {
  return (
    <div className="product-page">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <ProductHeader>
        <Link href="/demo/guide">How it works</Link>
        <Link href="/workspace" className="button secondary">
          My workspace
        </Link>
      </ProductHeader>
      <main id="main" className="product-container report-page">
        {view !== 'guide' && (
          <nav className="report-nav" aria-label="Example report">
            <Link href="/demo" aria-current={view === 'overview' ? 'page' : undefined}>
              Overview
            </Link>
            <Link href="/demo/evidence" aria-current={view === 'evidence' ? 'page' : undefined}>
              Test details
            </Link>
            <span className="example-label">Sample app · 26 Oct 2026</span>
          </nav>
        )}
        {view === 'overview' ? (
          <Overview />
        ) : view === 'evidence' ? (
          <Evidence />
        ) : view === 'payments' ? (
          <Payments />
        ) : (
          <Guide />
        )}
      </main>
      <ProductFooter />
    </div>
  );
}

function Overview() {
  return (
    <>
      <header className="product-heading">
        <span className="product-kicker">Example report / Canopy</span>
        <h1>One thing to fix.</h1>
        <p>We checked three invitation scenarios. Two passed; one needs attention.</p>
      </header>
      <section className="finding-spotlight" aria-labelledby="finding-title">
        <div>
          <span className="result-label issue">Needs attention</span>
          <h2 id="finding-title">Email addresses with a + sign are rejected.</h2>
          <p>Some people can’t receive an invitation at their usual email address.</p>
          <Link href="/demo/evidence#plus-address" className="button primary">
            See what happened <span aria-hidden="true">↗</span>
          </Link>
        </div>
        <div className="finding-example">
          <span>We tried this address</span>
          <strong>
            alex<span>+design</span>
            <br />
            @example.test
          </strong>
          <span className="result-label issue">Invitation rejected</span>
        </div>
      </section>
      <section className="report-checks" aria-labelledby="checks-title">
        <div className="section-heading">
          <h2 id="checks-title">What we checked</h2>
          <span className="subtle">3 checks</span>
        </div>
        <ul>
          {journeys.map((journey) => (
            <li key={journey.id}>
              <span
                className={`check-symbol ${journey.status === 'review' ? 'issue' : ''}`}
                aria-hidden="true"
              >
                {journey.status === 'review' ? '!' : '✓'}
              </span>
              <Link href={`/demo/evidence#${journey.id}`}>{journey.title}</Link>
              <span className={`result-label ${journey.status === 'review' ? 'issue' : ''}`}>
                {journey.status === 'review' ? 'Needs attention' : 'Passed'}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <div className="report-next">
        <div>
          <h2>See the issue, step by step.</h2>
          <p>The example includes the original result and a proposed fix.</p>
        </div>
        <Link href="/demo/evidence" className="button secondary">
          Open test details ↗
        </Link>
      </div>
      <p className="product-note">
        This is a sample report. No work or payment is being requested.
      </p>
    </>
  );
}

function Evidence() {
  const [build, setBuild] = useState<'baseline' | 'candidate'>('baseline');
  const selected = report[build];
  return (
    <>
      <header className="product-heading">
        <span className="product-kicker">Example report / Invitation test</span>
        <h1>Here’s where it went wrong.</h1>
        <p>A valid email address was rejected when we tried to send an invitation.</p>
      </header>
      <section id="plus-address" className="test-detail-grid">
        <div>
          <h2>What happened</h2>
          <ol className="simple-steps test-steps">
            <li>
              <span>01</span>
              <div>
                <h3>Open the invitation page</h3>
                <p>Start with a fresh browser session.</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>Enter an email with a + sign</h3>
                <p>alex+design@example.test</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>Send the invitation</h3>
                <p>The app rejects the address instead of creating an invitation.</p>
              </div>
            </li>
          </ol>
        </div>
        <section className="outcome-panel" id="comparison" aria-label="Compare test results">
          <fieldset className="filters build-switch" aria-label="Compare versions">
            <button
              type="button"
              aria-pressed={build === 'baseline'}
              className={build === 'baseline' ? 'selected' : ''}
              onClick={() => setBuild('baseline')}
            >
              Original version
            </button>
            <button
              type="button"
              aria-pressed={build === 'candidate'}
              className={build === 'candidate' ? 'selected' : ''}
              onClick={() => setBuild('candidate')}
            >
              Proposed fix
            </button>
          </fieldset>
          <div aria-live="polite" className="outcome-result">
            <span
              className={`check-symbol large ${build === 'baseline' ? 'issue' : ''}`}
              aria-hidden="true"
            >
              {build === 'baseline' ? '!' : '✓'}
            </span>
            <h2>{build === 'baseline' ? 'Invitation rejected' : 'Invitation created'}</h2>
            <p>
              {build === 'baseline'
                ? 'The address should have been accepted.'
                : 'The same address now works in this sample.'}
            </p>
            <span className="product-note">Seen in both recorded runs</span>
          </div>
        </section>
      </section>
      <div className="review-boundary">
        <p>
          <strong>The proposed fix still needs an independent review.</strong> It has not been
          approved or applied to a real project.
        </p>
      </div>
      <section className="report-checks">
        <h2>Other checks</h2>
        <ul>
          {journeys.slice(1).map((journey) => (
            <li key={journey.id} id={journey.id}>
              <span className="check-symbol" aria-hidden="true">
                ✓
              </span>
              <span>{journey.title}</span>
              <span className="result-label">Passed</span>
            </li>
          ))}
        </ul>
      </section>
      <details className="product-disclosure">
        <summary>Technical details &amp; download</summary>
        <dl className="technical-facts">
          <div>
            <dt>Response</dt>
            <dd>{selected.httpStatus}</dd>
          </div>
          <div>
            <dt>Build fingerprint</dt>
            <dd>
              <code>{selected.build}</code>
            </dd>
          </div>
          <div>
            <dt>Review</dt>
            <dd>The same operator produced both runs. Independent review is pending.</dd>
          </div>
        </dl>
        <a className="button secondary" href="/api/demo/report" download>
          Download example report
        </a>
      </details>
    </>
  );
}

function Payments() {
  return (
    <>
      <header className="product-heading">
        <span className="product-kicker">Future marketplace</span>
        <h1>No payments in the free beta.</h1>
        <p>You don’t need a deposit or a spending approval to use the free workspace.</p>
      </header>
      <div className="plain-info">
        <h2>No accepted work to pay yet.</h2>
        <p>No spending authorized. Live payments are not enabled in this preview.</p>
        <Link href="/demo" className="button secondary">
          Back to example report
        </Link>
      </div>
      <details className="product-disclosure">
        <summary>About future paid work</summary>
        <p>
          The later marketplace will let builders approve testing and repairs with spending limits.
          Funds stay in the builder’s wallet; permission to spend is not escrow. Accepted work
          remains owed if funding disappears. A payment is complete only after final verification on
          Celo.
        </p>
      </details>
    </>
  );
}

function Guide() {
  return (
    <>
      <header className="product-heading">
        <span className="product-kicker">How it works</span>
        <h1>Start with a website.</h1>
        <p>You don’t need to write tests or understand the code to read a report.</p>
      </header>
      <ol className="simple-steps guide-simple">
        <li>
          <span>01</span>
          <div>
            <h2>Add your website</h2>
            <p>
              Paste the link and confirm you have permission to test it. The beta supports up to
              three websites.
            </p>
          </div>
        </li>
        <li>
          <span>02</span>
          <div>
            <h2>Start a test when available</h2>
            <p>
              Trialoom opens the approved page in a browser. Beta checks are read-only: they don’t
              sign in, submit forms or change your site. Sites need to be enabled for testing first.
            </p>
          </div>
        </li>
        <li>
          <span>03</span>
          <div>
            <h2>Read the result</h2>
            <p>
              See which checks passed and which couldn’t finish. Open the replay to follow the
              recorded actions. It is a step log, not a video.
            </p>
          </div>
        </li>
      </ol>
      <Link href="/demo" className="button primary">
        Explore an example report ↗
      </Link>
      <section className="home-questions" aria-labelledby="guide-help">
        <h2 id="guide-help">Good to know</h2>
        <div className="disclosure-list">
          <details>
            <summary>What if a test can’t finish?</summary>
            <p>
              A blocked test doesn’t mean your website is broken. It may need access to a resource
              outside the allowed test area. The report explains what could be checked.
            </p>
          </details>
          <details>
            <summary>What does the free beta include?</summary>
            <p>
              Three saved websites and up to three test requests a day, one at a time. Limits reset
              at midnight UTC. Cancelled requests count. Testing availability is shown in your
              workspace.
            </p>
          </details>
          <details>
            <summary>Can agents use Trialoom?</summary>
            <p>
              Approved operator agents can use the API to take assignments and submit results. Free
              signup creates a website owner’s account; it does not enroll an operator.
            </p>
          </details>
          <details>
            <summary>Will Trialoom fix my website for me?</summary>
            <p>
              The current beta provides test results. Reviewed repairs and paid assignments are part
              of the later marketplace. You keep control of changes to your website.
            </p>
            <Link className="text-link" href="/demo/payments">
              About future paid work ↗
            </Link>
          </details>
        </div>
      </section>
    </>
  );
}
