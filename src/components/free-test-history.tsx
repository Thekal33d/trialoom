'use client';
import {
  activeFreeTest,
  type FreeTestExplanation,
  type FreeTestSummary,
} from '@/domain/free-tests';
import type { ProjectSummary } from './live-types';

const phases = {
  queued: 'Waiting to start',
  running: 'Testing your page',
  captured: 'Saving results',
  completed: 'Checks completed',
  blocked: 'Test incomplete',
  interrupted: 'Test interrupted',
  cancelled: 'Cancelled',
};
const checks: Record<string, string> = {
  homepage: 'Page loading',
  navigation: 'Next-page link',
  scope: 'Allowed pages and files',
  infrastructure: 'Browser resources',
};
const actionNames: Record<string, string> = {
  goto: 'Opened the page',
  cookies: 'Checked browser cookies',
  waitForFunction: 'Waited for the page',
  evaluateExpression: 'Checked page content',
  click: 'Followed a link',
  waitForSelector: 'Waited for an element',
};
function Explanation({ explanation }: { explanation: FreeTestExplanation }) {
  if (explanation.state === 'skipped') return null;
  if (explanation.state === 'pending')
    return (
      <p className="product-note" role="status">
        Preparing a suggestion…
      </p>
    );
  if (explanation.state !== 'ready' || !explanation.body)
    return (
      <details className="product-disclosure">
        <summary>AI suggestion unavailable</summary>
        <p>Your test results are still available. No charge was made to you.</p>
      </details>
    );
  return (
    <section className="result-suggestion" aria-label="AI suggestion">
      <span className="product-kicker">AI suggestion</span>
      <h4>What to try next</h4>
      <p>{explanation.body.nextStep}</p>
      <details className="product-disclosure">
        <summary>Why this was suggested</summary>
        <p>{explanation.body.summary}</p>
        <p>
          Based on:{' '}
          {explanation.body.evidenceRefs
            .map((ref) => {
              const observation = explanation.observations.find((item) => item.ref === ref);
              return observation ? checks[observation.name] : ref;
            })
            .join(', ')}
          .
        </p>
        <p>
          This is advice, not a test result. Only test observations are shared with the suggestion
          service, at Trialoom’s expense.
        </p>
      </details>
    </section>
  );
}

export function FreeTestHistory({
  tests,
  explanations,
  projects,
  busy,
  onCancel,
}: {
  tests: FreeTestSummary[];
  explanations: Record<string, FreeTestExplanation>;
  projects: ProjectSummary[];
  busy: boolean;
  onCancel: (id: string) => void;
}) {
  return (
    <section className="test-history" aria-labelledby="test-history">
      <div className="section-heading">
        <h2 id="test-history" tabIndex={-1}>
          Recent tests
        </h2>
        <span className="subtle">{tests.length > 0 ? `${tests.length} saved` : ''}</span>
      </div>
      {tests.length === 0 ? (
        <p className="product-note">Your results will appear here after your first test.</p>
      ) : (
        <ul className="test-list">
          {tests.map((test, index) => {
            const active = activeFreeTest(test.phase);
            const complete =
              test.phase === 'completed' &&
              test.result &&
              test.result.checks.length > 0 &&
              test.result.checks.every((item) => item.passed);
            const label =
              test.cancel_requested && active
                ? 'Stopping test'
                : complete
                  ? 'All checks passed'
                  : phases[test.phase];
            return (
              <li key={test.id}>
                <details className="test-record" open={index === 0}>
                  <summary>
                    <span>
                      <strong>
                        {test.kind === 'sample'
                          ? 'Sample website'
                          : (projects.find((project) => project.id === test.project_id)?.name ??
                            'Website test')}
                      </strong>
                      <time dateTime={test.created_at}>
                        {new Date(test.created_at).toLocaleString(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </time>
                    </span>
                    <span
                      className={`result-label ${complete ? '' : active ? 'pending' : 'neutral'}`}
                    >
                      {label}
                    </span>
                  </summary>
                  <div className="test-record-body">
                    {active && (
                      <div className="test-progress" role="status">
                        <p>
                          {test.cancel_requested
                            ? 'Stopping safely. This can take a moment.'
                            : test.phase === 'queued'
                              ? 'Your test is in line. You can leave this page and return later.'
                              : 'The browser is checking your page. Results will appear here.'}
                        </p>
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy || test.cancel_requested}
                          onClick={() => onCancel(test.id)}
                        >
                          Cancel test
                        </button>
                      </div>
                    )}
                    {test.phase === 'interrupted' && (
                      <p className="product-note">
                        The test stopped before results were saved. Start another test when testing
                        is available.
                      </p>
                    )}
                    {test.phase === 'blocked' && (
                      <p className="product-note">
                        Some checks couldn’t finish within the allowed test limits. This doesn’t
                        mean your website is broken.
                      </p>
                    )}
                    {test.phase === 'cancelled' && (
                      <p className="product-note">
                        You cancelled this test. It counts toward today’s limit.
                      </p>
                    )}
                    {test.result && !active && test.phase !== 'cancelled' && (
                      <>
                        <ul className="result-check-list">
                          {test.result.checks.map((item) => (
                            <li key={item.check}>
                              <span
                                className={`check-symbol ${item.passed ? '' : 'issue'}`}
                                aria-hidden="true"
                              >
                                {item.passed ? '✓' : '–'}
                              </span>
                              <span>{checks[item.check]}</span>
                              <strong>{item.passed ? 'Passed' : 'Incomplete'}</strong>
                            </li>
                          ))}
                        </ul>
                        <details className="result-replay">
                          <summary>
                            View replay <span>Recorded steps</span>
                          </summary>
                          {test.result.replay ? (
                            <>
                              <p className="product-note">
                                A log of browser actions, not a video. Private page content is
                                hidden.
                              </p>
                              <ol className="action-timeline">
                                {test.result.replay.actions.map((action) => (
                                  <li key={action.index}>
                                    <span>{(action.startMs / 1000).toFixed(1)}s</span>
                                    <strong>
                                      {actionNames[action.method] ?? 'Browser action'}
                                    </strong>
                                    <span>
                                      {action.status === 'completed' ? 'Done' : action.status}
                                    </span>
                                  </li>
                                ))}
                              </ol>
                              <details className="product-disclosure">
                                <summary>Technical details</summary>
                                <p>
                                  {test.result.browser}. The exact website version was not
                                  independently confirmed.
                                </p>
                                <h4>Network responses</h4>
                                <ul className="network-responses">
                                  {test.result.replay.requests.map((request) => (
                                    <li key={request.index}>
                                      {request.method} ·{' '}
                                      {request.status > 0
                                        ? `HTTP ${request.status}`
                                        : 'No response'}{' '}
                                      · {(request.startMs / 1000).toFixed(1)}s
                                    </li>
                                  ))}
                                </ul>
                                <p>
                                  Website addresses, typed values and screenshots are omitted for
                                  privacy.
                                </p>
                              </details>
                            </>
                          ) : (
                            <p className="product-note">
                              A replay couldn’t be prepared safely. Your checks are still shown
                              above.
                            </p>
                          )}
                        </details>
                        {explanations[test.id] && (
                          <Explanation explanation={explanations[test.id]} />
                        )}
                      </>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
