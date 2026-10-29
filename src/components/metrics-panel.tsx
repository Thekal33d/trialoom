'use client';
import { useCallback, useEffect, useState } from 'react';
import { formatUnits } from '@/domain/values';
import { api } from './live-types';

type Metric = {
  id: string;
  name: string;
  definition: string;
  target: string;
  value: number | null;
  unit: 'ratio' | 'count' | 'minutes' | 'units';
  numerator: number | null;
  denominator: number | null;
  meetsTarget: boolean | null;
  complete: boolean;
  missing: string[];
  detail?: Record<string, unknown>;
};
type Readiness = {
  metrics: Metric[];
  coverage: { topic: string; n: number; latest: string }[];
  summary: {
    targets: number;
    measurable: number;
    meeting: number;
    failing: number;
    unmeasurable: number;
  };
  note: string;
};

function reading(metric: Metric) {
  if (metric.value === null) return 'no reading';
  if (metric.unit === 'ratio') return `${Math.round(metric.value * 1000) / 10}%`;
  if (metric.unit === 'minutes') return `${Math.round(metric.value * 10) / 10} min`;
  if (metric.unit === 'units') return `${formatUnits(String(metric.value))} USDC`;
  return String(metric.value);
}

/**
 * Pilot readiness: every target the PRD sets, what it was computed from, and
 * what is missing where it could not be computed at all.
 */
export function MetricsPanel({ base }: { base: string }) {
  const [readiness, setReadiness] = useState<Readiness>();
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setReadiness(await api<Readiness>(`${base}/metrics`));
  }, [base]);
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : 'Metrics unavailable.'));
  }, [load]);
  if (error)
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  if (!readiness) return <p className="section-description">Loading pilot readiness…</p>;
  const { summary } = readiness;
  return (
    <section className="attention-panel">
      <div className="section-heading">
        <h3>Pilot readiness</h3>
        <span className="neutral-label">
          {summary.measurable} of {summary.targets} targets measurable
        </span>
      </div>
      <p className="section-description">{readiness.note}</p>
      <div className="project-context">
        <span>
          Meeting target<strong>{summary.meeting}</strong>
        </span>
        <span>
          Below target<strong>{summary.failing}</strong>
        </span>
        <span>
          Not yet measurable<strong>{summary.unmeasurable}</strong>
        </span>
        <span>
          Events seen<strong>{readiness.coverage.length} of 14</strong>
        </span>
      </div>
      <div className="record-list">
        {readiness.metrics.map((metric) => (
          <div className="member-row" key={metric.id}>
            <div>
              <strong>
                {metric.name} · {reading(metric)}
              </strong>
              <p>
                {metric.definition} Target: {metric.target.toLowerCase()}.
                {metric.numerator !== null && metric.denominator !== null
                  ? ` Computed from ${metric.numerator} of ${metric.denominator}.`
                  : ''}
              </p>
              {metric.missing.length > 0 && (
                <ul className="waiting-list">
                  {metric.missing.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
            </div>
            <span className="neutral-label">
              {!metric.complete
                ? 'no input'
                : metric.meetsTarget === true
                  ? 'meets target'
                  : metric.meetsTarget === false
                    ? 'below target'
                    : 'no reading'}
            </span>
          </div>
        ))}
      </div>
      <h4>Instrumented events</h4>
      <p className="section-description">
        A target resting on an event that has never fired is not measuring anything, so the stream's
        own coverage is shown rather than assumed.
      </p>
      <div className="record-list">
        {readiness.coverage.map((topic) => (
          <div className="member-row" key={topic.topic}>
            <div>
              <strong>{topic.topic}</strong>
              <p>Last seen {new Date(topic.latest).toLocaleString()}</p>
            </div>
            <span className="neutral-label">{topic.n}</span>
          </div>
        ))}
        {!readiness.coverage.length && (
          <p className="section-description">No event has been recorded in this workspace yet.</p>
        )}
      </div>
    </section>
  );
}
