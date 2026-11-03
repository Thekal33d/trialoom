'use client';
import {
  activeFreeTest,
  type FreeTestExplanation,
  type FreeTestSummary,
} from '@/domain/free-tests';
import type { ProjectSummary } from './live-types';

const phases = {
  queued: 'Queued',
  running: 'Browser running',
  captured: 'Saving results',
  completed: 'Checks completed',
  blocked: 'Test blocked',
  interrupted: 'Test interrupted',
  cancelled: 'Cancelled',
};
const checks: Record<string, string> = {
  homepage: 'Page returned a successful response and rendered visible content',
  navigation: 'Sample next-page navigation rendered',
  scope: 'Requests stayed within the approved scope',
  infrastructure: 'Required resources stayed within the runner limits',
};
const actionNames: Record<string, string> = {
  goto: 'Open page',
  cookies: 'Inspect cookies',
  waitForFunction: 'Wait for page state',
  evaluateExpression: 'Inspect page',
  click: 'Follow link',
  waitForSelector: 'Wait for element',
};
/**
 * What was bought to explain this test, beside the observations it was bought
 * against. The explanation is advisory text from a service Trialoom pays for;
 * it is never a result, and the panel is built so that it cannot be mistaken
 * for one — the observed checks stay above it, every claim it makes points at
 * one of them by reference, and the states where nothing useful arrived say so
 * rather than showing an empty space.
 */
function Explanation({ explanation }: { explanation: FreeTestExplanation }) {
  if (explanation.state === 'skipped') return null;
  const named = (ref: string) => explanation.observations.find((item) => item.ref === ref) ?? null;
  return (
    <section className="free-explanation" aria-label="Explanation of this result">
      <div className="section-heading">
        <h4>What this looks like</h4>
        <span className="neutral-label">Not a test result</span>
      </div>
      {explanation.state === 'pending' && (
        <p className="section-description">
          Trialoom is buying an explanation of these observations. It will appear here; the checks
          above are the result either way.
        </p>
      )}
      {explanation.state === 'unavailable' && (
        <p className="section-description">
          No explanation was obtained for this test. The checks above are unaffected, and nothing
          was charged to you.
        </p>
      )}
      {explanation.state === 'unusable' && (
        <p className="section-description">
          Trialoom paid for an explanation of these observations and the answer could not be used,
          so it is not shown. The checks above are unaffected, and nothing was charged to you.
        </p>
      )}
      {explanation.state === 'ready' && explanation.body && (
        <>
          <p className="free-explanation-title">{explanation.body.title}</p>
          <p>{explanation.body.summary}</p>
          <p>
            <strong>Try next.</strong> {explanation.body.nextStep}
          </p>
          <h5>Derived only from</h5>
          <ul className="free-checks">
            {explanation.body.evidenceRefs.map((ref) => {
              const observation = named(ref);
              return (
                <li key={ref}>
                  <strong>{observation?.passed ? 'Passed' : 'Blocked'}</strong>
                  <span>{observation ? checks[observation.name] : ref}</span>
                </li>
              );
            })}
          </ul>
          <p className="replay-privacy">
            Written by an external service Trialoom paid for, from the checks listed above and
            nothing else. No URL, page content, trace or account detail left this product. It is a
            suggestion, not a finding, and it cannot change a result.
          </p>
        </>
      )}
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
    <section className="free-test-history" aria-labelledby="test-history">
      <div className="section-heading">
        <h2 id="test-history">Your tests</h2>
        <span className="neutral-label">Free beta</span>
      </div>
      {tests.length === 0 ? (
        <p className="section-description">
          Your first test will appear here with its results and replay.
        </p>
      ) : (
        <ul className="free-project-list">
          {tests.map((test) => (
            <li key={test.id}>
              <div className="section-heading">
                <h3>
                  {test.kind === 'sample'
                    ? 'Prepared sample'
                    : (projects.find((p) => p.id === test.project_id)?.name ?? 'Preview page')}
                </h3>
                <span className="neutral-label" role="status">
                  {test.cancel_requested && activeFreeTest(test.phase)
                    ? 'Stopping and cleaning up'
                    : phases[test.phase]}
                </span>
              </div>
              <p className="section-description">
                {new Date(test.created_at).toLocaleString()} · Read-only Chromium test
              </p>
              {activeFreeTest(test.phase) && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || test.cancel_requested}
                  onClick={() => onCancel(test.id)}
                >
                  Cancel test
                </button>
              )}
              {test.phase === 'interrupted' && (
                <p>
                  The run stopped before results were safely captured. It was not automatically
                  repeated. You can request another test when the runner is available.
                </p>
              )}
              {test.phase === 'blocked' && (
                <p>
                  The page could not be fully checked within the approved scope and limits. This
                  does not establish a product defect.
                </p>
              )}
              {test.result && !activeFreeTest(test.phase) && test.phase !== 'cancelled' && (
                <>
                  <ul className="free-checks">
                    {test.result.checks.map((item) => (
                      <li key={item.check}>
                        <strong>{item.passed ? 'Passed' : 'Blocked'}</strong>
                        <span>{checks[item.check]}</span>
                      </li>
                    ))}
                  </ul>
                  {explanations[test.id] && <Explanation explanation={explanations[test.id]} />}
                  <details className="replay-details free-replay">
                    <summary>View replay</summary>
                    <p className="section-description">
                      {test.result.browser} · Observed page at test time; build revision not
                      independently confirmed.
                    </p>
                    {test.result.replay ? (
                      <>
                        <h4>Recorded browser actions</h4>
                        <ol>
                          {test.result.replay.actions.map((action) => (
                            <li key={action.index}>
                              <span>{(action.startMs / 1000).toFixed(2)}s</span>
                              <strong>
                                {actionNames[action.method] ?? 'Other browser action'}
                              </strong>
                              <span>{action.status}</span>
                            </li>
                          ))}
                        </ol>
                        <details className="replay-details">
                          <summary>
                            HTTP responses · {test.result.replay.requests.length} recorded
                          </summary>
                          <ol>
                            {test.result.replay.requests.map((request) => (
                              <li key={request.index}>
                                <span>{(request.startMs / 1000).toFixed(2)}s</span>
                                <strong>{request.method}</strong>
                                <span>
                                  {request.status > 0 ? `HTTP ${request.status}` : 'No response'}
                                </span>
                              </li>
                            ))}
                          </ol>
                        </details>
                        <p className="replay-privacy">
                          This replay shows actions and request timing. Page snapshots, addresses,
                          typed values and private content are omitted.
                        </p>
                      </>
                    ) : (
                      <p>
                        Replay is unavailable because the trace could not be safely processed. The
                        checks above remain the observed result.
                      </p>
                    )}
                  </details>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
