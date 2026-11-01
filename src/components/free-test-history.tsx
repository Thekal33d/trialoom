'use client';
import { activeFreeTest, type FreeTestSummary } from '@/domain/free-tests';
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
const checks = {
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
export function FreeTestHistory({
  tests,
  projects,
  busy,
  onCancel,
}: {
  tests: FreeTestSummary[];
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
