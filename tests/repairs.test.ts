import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { AppError } from '../src/domain/errors.ts';
import type { Actor } from '../src/server/access.ts';
import { type AgentSession, authenticateAgent } from '../src/server/agents.ts';
import { claim, publishCampaign } from '../src/server/assignments.ts';
import { decideExecution } from '../src/server/decisions.ts';
import { storeArtifact, submitEvidence } from '../src/server/evidence.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { migrate } from '../src/server/migrations.ts';
import { createCredential, registerOperator } from '../src/server/operators.ts';
import { addBuild, createCampaign, createProject } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import { decideQuote, proposeQuote } from '../src/server/repairs.ts';
import { authenticateRun, isolationProfile, startRun } from '../src/server/runner.ts';
import { digestOf } from '../src/server/storage.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let owner: Actor;
let workspaceId: string, projectId: string, buildId: string, evidenceDir: string;
const password = randomBytes(24).toString('base64url');
const code = (name: string) => (error: unknown) => error instanceof AppError && error.code === name;
const scopes = ['work:read', 'assignments:read', 'assignments:claim', 'runs:execute'];
// Every seeded task, so one operator can both discover and repair.
const answers: Record<string, Record<string, unknown>> = {
  'invite-alias-defect': {
    defectPresent: true,
    failingStep: 'invitation.create',
    expectedStatus: 201,
    observedStatus: 400,
  },
  'invite-alias-repaired': {
    defectPresent: false,
    failingStep: null,
    expectedStatus: 201,
    observedStatus: 201,
  },
  'regression-pins-revision': {
    defectPresent: true,
    baselineResult: 'failed',
    candidateResult: 'passed',
  },
};
const target = 'https://preview.example.com/';
const base = 'baseline-1';
const candidate = 'candidate-2';
const publicDns = async () => ['93.184.215.14'];
const settled = async () => ({ status: 200, location: null, revision: base });
const archiveBytes = () =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0xff, 0xfe]), randomBytes(24)]);
const replays = (assertion: string, baselinePasses = false, candidateAssertion = assertion) => ({
  baseline: [
    { assertion, passed: baselinePasses, cleanSession: true as const },
    { assertion, passed: baselinePasses, cleanSession: true as const },
  ],
  candidate: [
    { assertion: candidateAssertion, passed: true, cleanSession: true as const },
    { assertion: candidateAssertion, passed: true, cleanSession: true as const },
  ],
});

function termsInput(service: string, overrides: Record<string, unknown> = {}) {
  return {
    buildId,
    expectedVersion: 0,
    service,
    scope: 'Exercise the seeded invitation journey',
    allowedActions: ['Create sandbox invitations'],
    exclusions: ['No real emails'],
    acceptanceCriteria: 'Reports must replay from the exported trace',
    rewardRubric: 'One reward per distinct accepted defect',
    artifactRights: 'Builder retains reports and regression tests',
    deadline: new Date(Date.now() + 86_400_000).toISOString(),
    reviewWindowHours: 48,
    priceUnits: '2000000',
    discoveryRewardCapUnits: '1000000',
    resourceAllowanceUnits: '500000',
    platformFeeBps: 1000,
    paymentTerms: 'Authorized spending is not escrow; accepted work remains owed.',
    scopeApproved: true,
    ...overrides,
  };
}
async function newCampaign(name: string, service: string, overrides: Record<string, unknown> = {}) {
  const assertion = `invitation.${name.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  const campaign = await createCampaign(db.pool, owner, workspaceId, projectId, {
    name,
    terms: termsInput(service, overrides),
  });
  return { ...campaign, assertion };
}
async function publish(campaignId: string, termsVersionId: string, slots = 4) {
  return publishCampaign(db.pool, owner, workspaceId, projectId, campaignId, {
    termsVersionId,
    slots,
    maxConcurrent: slots,
    authorizeUnits: '80000000',
    spendingAuthorization: 'remesso-policy-local-fixture',
    authorizationConfirmed: true,
  });
}
async function qualifiedOperator(handle: string) {
  const email = `${handle}@example.test`;
  const invitation = await createInvitation(db.pool, owner, workspaceId, {
    email,
    role: 'operator',
  });
  await acceptInvitation(db.pool, { token: invitation.token, name: handle, password }, null);
  const actor: Actor = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [email])
  ).rows[0];
  const operator = await registerOperator(db.pool, actor, { handle });
  for (const [task, report] of Object.entries(answers))
    await submitAttempt(db.pool, operator, { task, report });
  const credential = await createCredential(db.pool, actor, {
    name: 'Runner',
    scopes,
    expiresInDays: 7,
  });
  return { actor, operator, session: await authenticateAgent(db.pool, credential.secret) };
}

type Claimed = Awaited<ReturnType<typeof claim>>;
/** Claims a slot and opens a run grant against the pinned target. */
async function startFor(session: AgentSession, campaignId: string) {
  const assignment = await claim(db.pool, session, { campaignId });
  const run = await startRun(
    db.pool,
    session,
    assignment.assignmentId,
    { attemptToken: assignment.attemptToken },
    { resolver: publicDns, probe: settled },
  );
  return { assignment, grant: await authenticateRun(db.pool, run.runToken) };
}
function envelope(assignment: Claimed, contentHash: string, extra: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    campaignId: assignment.campaignId,
    assignmentId: assignment.assignmentId,
    termsVersionId: assignment.termsVersionId,
    termsContentHash: contentHash,
    build: {
      id: assignment.buildId,
      revision: base,
      fixtureVersion: 'invitation-1',
      targetUrl: target,
    },
    environment: 'preview',
    agent: {
      runtime: 'node 24',
      browser: 'chromium 141',
      viewport: '1280x800',
      configurationHash: 'a'.repeat(64),
    },
    isolation: isolationProfile,
    startedAt: now,
    finishedAt: now,
    observedOrigins: ['https://preview.example.com'],
    ...extra,
  };
}

/** One discovery report, so a defect exists for a repair to be quoted against. */
async function reportDefect(
  session: AgentSession,
  campaign: { campaignId: string; contentHash: string; assertion: string },
) {
  const { assignment, grant } = await startFor(session, campaign.campaignId);
  const archive = archiveBytes();
  await storeArtifact(
    db.pool,
    grant,
    { name: 'replay.trace.zip', kind: 'trace', sha256: digestOf(archive) },
    'application/zip',
    archive,
  );
  const assertions = Buffer.from(`{"run":"${assignment.assignmentId}"}`);
  await storeArtifact(
    db.pool,
    grant,
    { name: 'assertions.json', kind: 'assertions', sha256: digestOf(assertions) },
    'application/json',
    assertions,
  );
  return submitEvidence(
    db.pool,
    grant,
    envelope(assignment, campaign.contentHash, {
      steps: [
        {
          index: 1,
          action: 'Invite teammate+qa@example.test',
          expected: 'Invitation created',
          actual: 'Rejected with 400',
          status: 'failed',
        },
      ],
      assertions: [
        { name: campaign.assertion, passed: false, detail: 'Expected 201, observed 400' },
      ],
      outcome: 'product_failed',
      summary: 'The seeded validator rejects a plus alias on the pinned build.',
      artifacts: [
        { name: 'replay.trace.zip', sha256: digestOf(archive) },
        { name: 'assertions.json', sha256: digestOf(assertions) },
      ],
    }),
  );
}

/** Delivers a repair: a patch, its regression test, and the replays on both. */
async function deliverRepair(
  session: AgentSession,
  campaign: { campaignId: string; contentHash: string },
  repair: Record<string, unknown>,
) {
  const { assignment, grant } = await startFor(session, campaign.campaignId);
  const patch = Buffer.from(`--- a/src/invite.ts\n+++ b/src/invite.ts\n@@\n-bad\n+good\n`);
  await storeArtifact(
    db.pool,
    grant,
    { name: 'fix.patch', kind: 'patch', sha256: digestOf(patch) },
    'text/x-diff',
    patch,
  );
  const regression = Buffer.from('test("plus alias is accepted", () => {})\n');
  await storeArtifact(
    db.pool,
    grant,
    { name: 'regression.test.txt', kind: 'test', sha256: digestOf(regression) },
    'text/plain',
    regression,
  );
  const assertions = Buffer.from(`{"candidate":"${candidate}"}`);
  await storeArtifact(
    db.pool,
    grant,
    { name: 'assertions.json', kind: 'assertions', sha256: digestOf(assertions) },
    'application/json',
    assertions,
  );
  return {
    assignment,
    result: await submitEvidence(
      db.pool,
      grant,
      envelope(assignment, campaign.contentHash, {
        steps: [
          {
            index: 1,
            action: 'Run the regression test on both revisions',
            expected: 'Fails on the original, passes on the candidate',
            actual: 'Fails on the original, passes on the candidate',
            status: 'passed',
          },
        ],
        assertions: [
          { name: 'regression.replayed', passed: true, detail: 'Both revisions replayed cleanly' },
        ],
        outcome: 'executed',
        summary: 'Repairs the plus-alias validator and pins the failure with a regression test.',
        repair: {
          patchSha256: digestOf(patch),
          testSha256: digestOf(regression),
          ...repair,
        },
        artifacts: [
          { name: 'fix.patch', sha256: digestOf(patch) },
          { name: 'regression.test.txt', sha256: digestOf(regression) },
          { name: 'assertions.json', sha256: digestOf(assertions) },
        ],
      }),
    ),
  };
}

/** Verifies a delivered repair with the verifier's own replays. */
async function verifyRepair(
  session: AgentSession,
  campaign: { campaignId: string; contentHash: string },
  verification: Record<string, unknown>,
) {
  const { assignment, grant } = await startFor(session, campaign.campaignId);
  const archive = archiveBytes();
  await storeArtifact(
    db.pool,
    grant,
    { name: 'verify.trace.zip', kind: 'trace', sha256: digestOf(archive) },
    'application/zip',
    archive,
  );
  const assertions = Buffer.from(`{"verified":"${assignment.assignmentId}"}`);
  await storeArtifact(
    db.pool,
    grant,
    { name: 'assertions.json', kind: 'assertions', sha256: digestOf(assertions) },
    'application/json',
    assertions,
  );
  return {
    assignment,
    result: await submitEvidence(
      db.pool,
      grant,
      envelope(assignment, campaign.contentHash, {
        steps: [
          {
            index: 1,
            action: 'Replay the delivered regression test on both revisions',
            expected: 'Fails on the original, passes on the candidate',
            actual: 'Fails on the original, passes on the candidate',
            status: 'passed',
          },
        ],
        assertions: [
          { name: 'regression.replayed', passed: true, detail: 'Reproduced independently' },
        ],
        outcome: 'executed',
        summary: 'Independently replayed the delivered regression test on both revisions.',
        repairVerification: {
          baseRevision: base,
          candidateRevision: candidate,
          // The verifier replays the delivered test themselves, so by default
          // they exercise the same assertion the repair was measured against.
          regression: replays(defectAssertion),
          detail: 'Replayed the delivered test twice on each revision from a clean session.',
          ...verification,
        },
        artifacts: [
          { name: 'verify.trace.zip', sha256: digestOf(archive) },
          { name: 'assertions.json', sha256: digestOf(assertions) },
        ],
      }),
    ),
  };
}

let discoverer: Awaited<ReturnType<typeof qualifiedOperator>>;
let witness: Awaited<ReturnType<typeof qualifiedOperator>>;
let defectId: string;
let defectAssertion: string;

before(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), 'trialoom-repairs-'));
  process.env.TRIALOOM_EVIDENCE_DIR = evidenceDir;
  db = await disposableDatabase();
  await migrate(db.pool);
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Repairs workspace',
  });
  workspaceId = bootstrap.workspaceId;
  await acceptInvitation(db.pool, { token: bootstrap.token, name: 'Owner', password }, null);
  owner = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [
      'owner@example.test',
    ])
  ).rows[0];
  const project = await createProject(
    db.pool,
    owner,
    workspaceId,
    {
      name: 'Repairs preview project',
      targetUrl: target,
      environment: 'preview',
      authorizationConfirmed: true,
    },
    publicDns,
  );
  projectId = project.id;
  buildId = (
    await addBuild(
      db.pool,
      owner,
      workspaceId,
      projectId,
      { revision: base, fixtureVersion: 'invitation-1', targetUrl: target },
      publicDns,
    )
  ).id;
  // A repair is bought for a confirmed defect, so two independent operators
  // report the same failure before anything here can be quoted.
  const discovery = await newCampaign('Discovery', 'bug_discovery');
  await publish(discovery.campaignId, discovery.id);
  discoverer = await qualifiedOperator('repair-discoverer');
  witness = await qualifiedOperator('repair-witness');
  const first = await reportDefect(discoverer.session, discovery);
  await reportDefect(witness.session, discovery);
  defectId = first.finding?.defectId as string;
  defectAssertion = discovery.assertion;
  const defect = (await db.pool.query('SELECT state FROM defects WHERE id=$1', [defectId])).rows[0];
  assert.equal(defect.state, 'confirmed');
});
after(async () => {
  await db?.close();
  if (evidenceDir) await rm(evidenceDir, { recursive: true, force: true });
});

/** A quoted, approved and published repair brief with its author's session. */
async function repairBrief(
  name: string,
  options: { amountUnits?: string; priceUnits?: string; scopePaths?: string[] } = {},
) {
  const campaign = await newCampaign(name, 'repair', {
    priceUnits: options.priceUnits ?? '2000000',
  });
  const author = await qualifiedOperator(`${name.toLowerCase()}-author`);
  const quote = await proposeQuote(db.pool, owner, workspaceId, projectId, {
    campaignId: campaign.campaignId,
    defectId,
    operatorId: author.operator.id,
    baseBuildId: buildId,
    amountUnits: options.amountUnits ?? '2000000',
    scopePaths: options.scopePaths ?? ['src/'],
  });
  await decideQuote(db.pool, owner, workspaceId, projectId, quote.quoteId, {
    outcome: 'approved',
    reason: 'The defect is confirmed and the scope is the validator alone.',
  });
  return { campaign, author, quote };
}
const changed = [
  {
    path: 'src/invite.ts',
    beforeSha256: 'a'.repeat(64),
    afterSha256: 'b'.repeat(64),
  },
];
const checks = [{ label: 'unit', baselinePassed: true, candidatePassed: true }];
const delivery = () => ({
  baseRevision: base,
  candidateRevision: candidate,
  changedFiles: changed,
  regression: replays(defectAssertion),
  requiredChecks: checks,
});

test('a repair brief cannot be published without an approved quote', async () => {
  const campaign = await newCampaign('Unquoted', 'repair');
  await assert.rejects(
    publish(campaign.campaignId, campaign.id),
    code('REPAIR_QUOTE_MISSING'),
    'an unquoted repair brief must not reach operators',
  );
});

test('a published repair brief must offer the price the owner approved', async () => {
  const campaign = await newCampaign('Mispriced', 'repair', { priceUnits: '2000000' });
  const author = await qualifiedOperator('mispriced-author');
  const quote = await proposeQuote(db.pool, owner, workspaceId, projectId, {
    campaignId: campaign.campaignId,
    defectId,
    operatorId: author.operator.id,
    baseBuildId: buildId,
    amountUnits: '9000000',
    scopePaths: ['src/'],
  });
  await decideQuote(db.pool, owner, workspaceId, projectId, quote.quoteId, {
    outcome: 'approved',
    reason: 'Approved at the quoted amount.',
  });
  // The approval is what authorizes the spend, so an offer that differs from it
  // would make the quote decorative.
  await assert.rejects(publish(campaign.campaignId, campaign.id), code('QUOTE_PRICE_MISMATCH'));
});

test('the quoted operator holds the first slot of a repair brief', async () => {
  const brief = await repairBrief('Authorfirst');
  await publish(brief.campaign.campaignId, brief.campaign.id);
  const other = await qualifiedOperator('authorfirst-other');
  await assert.rejects(
    claim(db.pool, other.session, { campaignId: brief.campaign.campaignId }),
    code('REPAIR_AUTHOR_FIRST'),
    'verification cannot start before a delivery exists',
  );
  const held = await claim(db.pool, brief.author.session, {
    campaignId: brief.campaign.campaignId,
  });
  assert.equal(held.state, 'claimed');
});

test('a regression test that also passes on the original revision is refused', async () => {
  const brief = await repairBrief('Unproven');
  await publish(brief.campaign.campaignId, brief.campaign.id);
  await assert.rejects(
    deliverRepair(brief.author.session, brief.campaign, {
      ...delivery(),
      // The same test passes on both revisions, so it demonstrates no fix.
      regression: replays(defectAssertion, true),
    }),
    code('REGRESSION_UNPROVEN'),
  );
  // The refusal rolls the whole submission back, so nothing is recorded against
  // the operator and the delivery can be corrected.
  const submissions = await db.pool.query(
    'SELECT count(*)::int AS n FROM evidence_submissions WHERE campaign_id=$1',
    [brief.campaign.campaignId],
  );
  assert.equal(submissions.rows[0].n, 0);
  assert.equal(
    (
      await db.pool.query('SELECT count(*)::int AS n FROM repairs WHERE campaign_id=$1', [
        brief.campaign.campaignId,
      ])
    ).rows[0].n,
    0,
  );
});

test('a repair that fixes a different failure than the defect records is refused', async () => {
  const brief = await repairBrief('Unrelated');
  await publish(brief.campaign.campaignId, brief.campaign.id);
  await assert.rejects(
    deliverRepair(brief.author.session, brief.campaign, {
      ...delivery(),
      regression: replays('invitation.some-other-failure'),
    }),
    code('UNRELATED_FAILURE'),
  );
});

test('a repair cannot change files the approved quote does not cover', async () => {
  const brief = await repairBrief('Strayscope', { scopePaths: ['src/invite.ts'] });
  await publish(brief.campaign.campaignId, brief.campaign.id);
  await assert.rejects(
    deliverRepair(brief.author.session, brief.campaign, {
      ...delivery(),
      changedFiles: [
        ...changed,
        { path: 'infra/deploy.yaml', beforeSha256: 'c'.repeat(64), afterSha256: 'd'.repeat(64) },
      ],
    }),
    code('SCOPE_EXCEEDED'),
  );
});

test('a delivered repair is recorded for builder review, not merged', async () => {
  const brief = await repairBrief('Delivered');
  await publish(brief.campaign.campaignId, brief.campaign.id);
  const delivered = await deliverRepair(brief.author.session, brief.campaign, delivery());
  assert.equal(delivered.result.repairRole, 'author');
  const recorded = delivered.result.repair;
  if (!recorded || !('gate' in recorded)) throw new Error('No repair was recorded.');
  assert.equal(recorded.gate, 'passed');
  assert.equal(recorded.delivery, 'for_builder_review');
  assert.equal(recorded.verifiedAssertion, defectAssertion);
  assert.equal(delivered.result.decision, 'pending_review');
  const row = (
    await db.pool.query('SELECT gate_state,candidate_revision FROM repairs WHERE campaign_id=$1', [
      brief.campaign.campaignId,
    ])
  ).rows[0];
  // The gate column admits only 'passed', so a repair row cannot exist for
  // evidence that failed it.
  assert.equal(row.gate_state, 'passed');
  assert.equal(row.candidate_revision, candidate);
  assert.equal(
    (await db.pool.query('SELECT repair_state FROM defects WHERE id=$1', [defectId])).rows[0]
      .repair_state,
    'delivered',
  );
});

test('neither the author nor a discoverer can verify the repair', async () => {
  const brief = await repairBrief('Independence');
  await publish(brief.campaign.campaignId, brief.campaign.id);
  await deliverRepair(brief.author.session, brief.campaign, delivery());
  await assert.rejects(
    verifyRepair(brief.author.session, brief.campaign, { outcome: 'confirmed' }),
    code('ALREADY_CLAIMED'),
    'the author already holds this brief’s assignment',
  );
  await assert.rejects(
    verifyRepair(discoverer.session, brief.campaign, { outcome: 'confirmed' }),
    code('INDEPENDENCE_FAILED'),
    'whoever reported the defect cannot confirm its repair',
  );
});

test('a confirmation must exercise the failure the repair fixed', async () => {
  const brief = await repairBrief('Wrongtest');
  await publish(brief.campaign.campaignId, brief.campaign.id);
  await deliverRepair(brief.author.session, brief.campaign, delivery());
  const verifier = await qualifiedOperator('wrongtest-verifier');
  await assert.rejects(
    verifyRepair(verifier.session, brief.campaign, {
      outcome: 'confirmed',
      regression: replays('invitation.a-different-assertion'),
    }),
    code('UNRELATED_FAILURE'),
  );
});

test('a repair is payable only after an independent confirmation', async () => {
  const brief = await repairBrief('Payable');
  await publish(brief.campaign.campaignId, brief.campaign.id);
  const delivered = await deliverRepair(brief.author.session, brief.campaign, delivery());
  const accept = {
    outcome: 'accepted',
    reason: 'The patch is scoped to the validator and the regression replays cleanly.',
    evidenceRefs: [],
  };
  await assert.rejects(
    decideExecution(
      db.pool,
      owner,
      workspaceId,
      projectId,
      delivered.assignment.assignmentId,
      accept,
    ),
    code('VERIFICATION_PENDING'),
    'a builder cannot accept a repair on their own say-so',
  );
  const verifier = await qualifiedOperator('payable-verifier');
  const verified = await verifyRepair(verifier.session, brief.campaign, { outcome: 'confirmed' });
  assert.equal(verified.result.repairRole, 'verifier');
  const confirmation = verified.result.repair;
  if (!confirmation || !('outcome' in confirmation))
    throw new Error('No verification was recorded.');
  assert.equal(confirmation.outcome, 'confirmed');
  assert.equal(confirmation.independent, true);
  assert.equal(
    (await db.pool.query('SELECT repair_state FROM defects WHERE id=$1', [defectId])).rows[0]
      .repair_state,
    'verified',
  );
  // The verification is a different, smaller job than the repair, so what it is
  // worth has to be stated rather than defaulting to the repair's price.
  await assert.rejects(
    decideExecution(
      db.pool,
      owner,
      workspaceId,
      projectId,
      verified.assignment.assignmentId,
      accept,
    ),
    code('VERIFICATION_PRICE_REQUIRED'),
  );
  const paidVerifier = await decideExecution(
    db.pool,
    owner,
    workspaceId,
    projectId,
    verified.assignment.assignmentId,
    { ...accept, amountUnits: '400000' },
  );
  assert.equal(paidVerifier.repairPosition, 'verifier');
  const paidAuthor = await decideExecution(
    db.pool,
    owner,
    workspaceId,
    projectId,
    delivered.assignment.assignmentId,
    accept,
  );
  assert.equal(paidAuthor.repairPosition, 'author');
  assert.equal(paidAuthor.movedUnits, '2200000');
  assert.equal(
    (await db.pool.query('SELECT repair_state FROM defects WHERE id=$1', [defectId])).rows[0]
      .repair_state,
    'accepted',
  );
  // Accepted work is owed, never paid here: no payment authority is configured.
  const payable = (
    await db.pool.query(
      "SELECT state,blocked_reason FROM payables WHERE assignment_id=$1 AND kind='operator'",
      [delivered.assignment.assignmentId],
    )
  ).rows[0];
  assert.equal(payable.state, 'blocked');
  assert.equal(payable.blocked_reason, 'no_payout_wallet');
});
