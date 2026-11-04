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
export type FreeTestExplanation = {
  state: 'skipped' | 'pending' | 'unavailable' | 'unusable' | 'ready';
  observations: { ref: string; name: string; passed: boolean }[];
  body: { title: string; summary: string; nextStep: string; evidenceRefs: string[] } | null;
  purchase?: {
    service: string;
    settlement: 'pending' | 'verified' | 'unpaid';
    token: string;
    amountUnits: string;
    transactionHash: string | null;
    requestHash: string;
  } | null;
};
export type FreeTestsView = {
  available: boolean;
  allowedOrigins: string[];
  remaining: number;
  tests: FreeTestSummary[];
  /** Keyed by test id; absent until a report has been prepared for that test. */
  explanations: Record<string, FreeTestExplanation>;
};
export const activeFreeTest = (phase: FreeTestSummary['phase']) =>
  ['queued', 'running', 'captured'].includes(phase);
