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
    status: number;
    startMs: number;
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
