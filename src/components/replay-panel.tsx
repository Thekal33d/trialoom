'use client';
import { useEffect, useRef, useState } from 'react';
import type { ReplayRecord } from '@/domain/replay';
import { api } from './live-types';

const actionNames: Record<string, string> = {
  goto: 'Open page',
  fill: 'Fill field',
  click: 'Click',
  dblclick: 'Double click',
  press: 'Press key',
  textContent: 'Read text',
  getAttribute: 'Read attribute',
  evaluateExpression: 'Inspect page',
  evaluateExpressionHandle: 'Inspect page',
  waitForFunction: 'Wait for page state',
  waitForSelector: 'Wait for element',
  cookies: 'Inspect cookies',
  unknown: 'Other browser action',
};

/** Text and metadata only. Recorded HTML, scripts and URLs are never mounted. */
export function ReplayPanel({
  campaignBase,
  submissionId,
}: {
  campaignBase: string;
  submissionId: string;
}) {
  const [record, setRecord] = useState<ReplayRecord>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries a failed request without changing its identity.
  useEffect(() => {
    let active = true;
    setError('');
    api<ReplayRecord>(`${campaignBase}/submissions/${submissionId}/replay`)
      .then((value) => {
        if (!active) return;
        setRecord(value);
        const failure = value.steps.findIndex(
          (step) => step.status === 'failed' || step.status === 'blocked',
        );
        setSelected(Math.max(0, failure));
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Replay could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [campaignBase, submissionId, attempt]);
  useEffect(() => {
    if (record || error) heading.current?.focus({ preventScroll: true });
  }, [record, error]);
  const step = record?.steps[selected];
  const firstFailure =
    record?.steps.findIndex((item) => item.status === 'failed' || item.status === 'blocked') ?? -1;
  return (
    <section className="replay-panel" aria-label="Recorded replay">
      <div className="replay-heading">
        <div>
          <p className="eyebrow">Evidence / recorded run</p>
          <h3 ref={heading} tabIndex={-1}>
            Recorded replay
          </h3>
        </div>
        {record?.trace && (
          <a
            className="button secondary"
            href={`${campaignBase}/artifacts/${record.trace.artifactId}`}
          >
            Download sanitized trace
          </a>
        )}
      </div>
      {!record && !error && <p role="status">Loading the recorded run…</p>}
      {error && (
        <div role="alert">
          <p className="form-error">{error}</p>
          <button
            type="button"
            className="text-button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try loading replay again
          </button>
        </div>
      )}
      {record && step && (
        <>
          <p className="section-description">
            Inspect the recorded steps and results. This does not run the test again or accept the
            finding.
          </p>
          <p>{record.summary}</p>
          <div className="replay-layout">
            <nav aria-label="Recorded steps">
              <ol className="replay-steps">
                {record.steps.map((item, position) => (
                  <li key={item.index}>
                    <button
                      type="button"
                      aria-current={selected === position ? 'step' : undefined}
                      onClick={() => setSelected(position)}
                    >
                      <span className="replay-number">{position + 1}</span>
                      <span>
                        <strong>{item.action}</strong>
                        <small data-status={item.status}>
                          {item.status}
                          {position === firstFailure ? ' · first issue' : ''}
                        </small>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            <div className="replay-result" aria-live="polite" aria-atomic="true">
              <p className="eyebrow">
                Step {selected + 1} of {record.steps.length}{' '}
                <span data-status={step.status}>/ {step.status}</span>
              </p>
              <h4>{step.action}</h4>
              <dl>
                <dt>Expected</dt>
                <dd>{step.expected}</dd>
                <dt>Observed</dt>
                <dd className={step.status === 'failed' ? 'replay-failure' : undefined}>
                  {step.actual}
                </dd>
              </dl>
              <div className="replay-controls">
                <button
                  type="button"
                  className="button secondary"
                  disabled={selected === 0}
                  onClick={() => setSelected((value) => value - 1)}
                >
                  Previous step
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={selected === record.steps.length - 1}
                  onClick={() => setSelected((value) => value + 1)}
                >
                  Next step
                </button>
              </div>
            </div>
          </div>
          <details className="replay-details">
            <summary>
              Assertions · {record.assertions.filter((item) => item.passed).length} of{' '}
              {record.assertions.length} passed
            </summary>
            <ul>
              {record.assertions.map((item) => (
                <li key={item.name}>
                  <strong data-status={item.passed ? 'passed' : 'failed'}>
                    {item.passed ? 'Passed' : 'Failed'}
                  </strong>
                  <div>
                    <strong>{item.name}</strong>
                    <p>{item.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </details>
          {record.trace ? (
            <>
              <details className="replay-details">
                <summary>Browser actions · {record.trace.actions.length} recorded</summary>
                <p className="section-description">
                  Elapsed time from the trace. “Completed” means the browser action finished; the
                  assertions above judge the product result.
                </p>
                <ol>
                  {record.trace.actions.map((action) => (
                    <li key={action.index}>
                      <span>{(action.startMs / 1000).toFixed(2)}s</span>
                      <strong>{actionNames[action.method] ?? action.method}</strong>
                      <span>{action.status}</span>
                    </li>
                  ))}
                </ol>
              </details>
              <details className="replay-details">
                <summary>HTTP responses · {record.trace.requests.length} recorded</summary>
                <p className="section-description">
                  Requests keep their method, response status and timing. Addresses and contents are
                  withheld.
                </p>
                <ol>
                  {record.trace.requests.map((request) => (
                    <li key={request.index}>
                      <span>{(request.startMs / 1000).toFixed(2)}s</span>
                      <strong>{request.method}</strong>
                      <span
                        data-status={
                          request.status <= 0 || request.status >= 400 ? 'failed' : undefined
                        }
                      >
                        {request.status > 0 ? `HTTP ${request.status}` : 'No HTTP response'}
                      </span>
                    </li>
                  ))}
                </ol>
              </details>
              <p className="replay-privacy">
                This replay omits page snapshots, screenshots, typed values and private request
                details. The downloaded ZIP contains the same sanitized action and request metadata.
              </p>
            </>
          ) : (
            <p className="replay-privacy" role="status">
              {record.traceReason}
            </p>
          )}
          <details className="replay-details">
            <summary>Build and evidence identity</summary>
            <p>
              Build <code>{record.build.revision}</code>
            </p>
            {record.build.fixtureVersion && (
              <p>
                Fixture <code>{record.build.fixtureVersion}</code>
              </p>
            )}
            {record.trace && (
              <>
                <p>
                  Sanitized trace SHA-256 <code>{record.trace.sha256}</code>
                </p>
                <p>
                  Policy <code>{record.trace.policy}</code>
                </p>
              </>
            )}
          </details>
        </>
      )}
    </section>
  );
}
