export const journeys = [
  {
    id: 'plus-address',
    title: 'Email address with a + sign',
    description: 'Invitation flow · Email aliases',
    result: 'Review needed',
    status: 'review',
    note: 'Candidate fix passes',
    runs: '2 clean replays',
  },
  {
    id: 'standard-address',
    title: 'Standard email invitation',
    description: 'Invitation flow · Happy path',
    result: 'Passed',
    status: 'passed',
    note: 'Expected response received',
    runs: '2 clean replays',
  },
  {
    id: 'duplicate-invite',
    title: 'Prevent duplicate invitations',
    description: 'Invitation flow · Existing invite',
    result: 'Passed',
    status: 'passed',
    note: 'Existing behavior preserved',
    runs: 'Supporting check',
  },
] as const;
export type Journey = (typeof journeys)[number];

export const report = {
  schemaVersion: 1,
  mode: 'synthetic-demo',
  projectName: 'Canopy (example project)',
  source: 'Trialoom invitation capability fixture',
  runId: '2026-10-26T22-38-35.897Z-18f8f599',
  journey: 'Invite a teammate with a plus address',
  baseline: {
    httpStatus: 400,
    regression: 'failed',
    replays: 2,
    build: 'e6ac712e4c02b17a6b64daa2a8e9060980fc126611fe14a9742ba864d20fecd4',
  },
  candidate: {
    httpStatus: 201,
    regression: 'passed',
    replays: 2,
    build: '4063983fd32e105d2804343ab5901f5c17cb260adeb98166f9aaffd46d89b66b',
  },
  independentOperator: false,
  marketplaceAcceptance: 'pending-independent-operator-review',
  paymentAuthorized: false,
};
