import type { TraceReplay } from './replay.ts';

export type FreeTestResult = {
  schemaVersion: 1;
  outcome: 'completed' | 'blocked';
  startedAt: string;
  finishedAt: string;
  browser: string;
  revisionConfirmed: false;
  checks: { check: 'homepage' | 'navigation' | 'scope' | 'infrastructure'; passed: boolean }[];
  replay: TraceReplay | null;
};
export type FreeTestSummary = {
  id: string;
  project_id: string | null;
  kind: 'sample' | 'homepage';
  phase: 'queued' | 'running' | 'captured' | 'completed' | 'blocked' | 'interrupted' | 'cancelled';
  cancel_requested: boolean;
  created_at: string;
  result: FreeTestResult | null;
};
export type FreeTestsView = {
  available: boolean;
  allowedOrigins: string[];
  remaining: number;
  tests: FreeTestSummary[];
};
export const activeFreeTest = (phase: FreeTestSummary['phase']) =>
  ['queued', 'running', 'captured'].includes(phase);
