export function assessRepair({ baseline, candidate, baselineBuildId, candidateBuildId, baselineChecks, candidateChecks }) {
  if (baselineBuildId === candidateBuildId) throw new Error('Candidate must change the pinned baseline.');
  if (baseline.exitCode !== 1 || candidate.exitCode !== 0) throw new Error('Expected baseline failure and candidate success.');
  if (baselineChecks !== 0 || candidateChecks !== 0) throw new Error('Required existing checks must pass on both builds.');
  for (const [label, suite, buildId, outcome, plusStatus] of [
    ['baseline', baseline, baselineBuildId, 'failed', 400],
    ['candidate', candidate, candidateBuildId, 'passed', 201],
  ]) {
    if (suite.tests.length !== 2) throw new Error('Two clean regression replays are required per build.');
    for (const [index, test] of suite.tests.entries()) {
      if (test.title !== `plus-address regression ${index + 1}` || test.attempts !== 1 || test.status !== outcome) throw new Error('Unexpected regression outcome or retry.');
      const e = test.evidence;
      if (e.build.id !== buildId || e.steps[0]?.cleanSession !== true) throw new Error('Regression build or clean-session evidence is missing.');
      if (e.assertions.length !== 2 || e.assertions[0].expected !== 201 || e.assertions[0].actual !== 201 || e.assertions[1].expected !== 201 || e.assertions[1].actual !== plusStatus) {
        throw new Error('The regression did not demonstrate the specified defect and repair.');
      }
      if (label === 'baseline' && !test.expectedAssertionFailure) throw new Error('Baseline failed for an unrelated reason.');
    }
  }
  return {
    technicalVerdict: 'verified',
    independentOperator: false,
    marketplaceAcceptance: 'pending-independent-operator-review',
  };
}
