import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRepair } from '../repair-gate.mjs';

function proof() {
  const suite = (build, status, actual, exitCode) => ({ exitCode, tests: [1, 2].map(replay => ({
    title: `plus-address regression ${replay}`, attempts: 1, status,
    expectedAssertionFailure: true,
    evidence: { build: { id: build }, steps: [{ cleanSession: true }], assertions: [{ expected: 201, actual: 201 }, { expected: 201, actual }] },
  })) });
  return { baseline: suite('base', 'failed', 400, 1), candidate: suite('fixed', 'passed', 201, 0), baselineBuildId: 'base', candidateBuildId: 'fixed', baselineChecks: 0, candidateChecks: 0 };
}
test('technical verification does not claim independent operator acceptance', () => {
  assert.deepEqual(assessRepair(proof()), { technicalVerdict: 'verified', independentOperator: false, marketplaceAcceptance: 'pending-independent-operator-review' });
});
test('a test also passing on baseline cannot establish a regression fix', () => {
  const input = proof(); input.baseline.exitCode = 0;
  assert.throws(() => assessRepair(input), /baseline failure/);
});
test('an unrelated baseline failure cannot qualify a fix', () => {
  const input = proof(); input.baseline.tests[0].expectedAssertionFailure = false;
  assert.throws(() => assessRepair(input), /unrelated reason/);
});
test('failed existing checks block technical verification', () => {
  const input = proof(); input.candidateChecks = 1;
  assert.throws(() => assessRepair(input), /existing checks/);
});
test('different build evidence and incomplete replays are rejected', () => {
  const input = proof(); input.candidate.tests[0].evidence.build.id = 'other';
  assert.throws(() => assessRepair(input), /build/);
  const incomplete = proof(); incomplete.baseline.tests.pop();
  assert.throws(() => assessRepair(incomplete), /Two clean/);
});
