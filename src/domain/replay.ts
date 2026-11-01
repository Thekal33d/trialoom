export type TraceReplay = {
  schemaVersion: 1;
  actions: {
    index: number;
    method: string;
    startMs: number;
    endMs: number | null;
    status: 'completed' | 'error' | 'incomplete';
  }[];
  requests: {
    index: number;
    method: string;
    /** -1 is Playwright's no-response marker; 0 also means no HTTP response. */
    status: number;
    startMs: number;
    /** -1 means the request duration was not available when recording ended. */
    durationMs: number;
  }[];
};

export type ReplayRecord = {
  submissionId: string;
  outcome: string;
  summary: string;
  build: { revision: string; fixtureVersion: string | null };
  steps: { index: number; action: string; expected: string; actual: string; status: string }[];
  assertions: { name: string; passed: boolean; detail: string }[];
  trace: (TraceReplay & { artifactId: string; sha256: string; policy: string }) | null;
  traceReason: string | null;
};
