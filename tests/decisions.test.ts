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
import {
  decideDiscovery,
  decideDuplicate,
  decideExecution,
  decideSeverity,
  openAppeal,
  operatorDecisions,
  releaseSettledAssignments,
  resolveAppeal,
} from '../src/server/decisions.ts';
import { campaignReview, storeArtifact, submitEvidence } from '../src/server/evidence.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { campaignAccounting, feeFor } from '../src/server/ledger.ts';
import { migrate } from '../src/server/migrations.ts';
import { createCredential, registerOperator } from '../src/server/operators.ts';
import { addBuild, createCampaign, createProject } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import { authenticateRun, isolationProfile, startRun } from '../src/server/runner.ts';
import { digestOf } from '../src/server/storage.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let owner: Actor, reviewer: Actor, member: Actor;
let workspaceId: string, projectId: string, buildId: string, evidenceDir: string;
const password = randomBytes(24).toString('base64url');
const code = (name: string) => (error: unknown) => error instanceof AppError && error.code === name;
const scopes = [
  'work:read',
  'assignments:read',
  'assignments:claim',
  'runs:execute',
  'decisions:read',
  'appeals:submit',
];
const correct = {
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
};
const target = 'https://preview.example.com/';
const publicDns = async () => ['93.184.215.14'];
const settled = async () => ({ status: 200, location: null, revision: 'baseline-1' });
const archiveBytes = () =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0xff, 0xfe]), randomBytes(24)]);

function termsInput(overrides: Record<string, unknown> = {}) {
  return {
    buildId,
    expectedVersion: 0,
    service: 'bug_discovery',
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
// Defects are keyed by project, build and failure, so each campaign here
// reports a distinct failure and cannot inherit another check's defect.
async function newCampaign(name: string, overrides: Record<string, unknown> = {}) {
  const assertion = `invitation.${name.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  const campaign = await createCampaign(db.pool, owner, workspaceId, projectId, {
    name,
    terms: termsInput(overrides),
  });
  await publishCampaign(db.pool, owner, workspaceId, projectId, campaign.campaignId, {
    termsVersionId: campaign.id,
    slots: 4,
    maxConcurrent: 4,
    authorizeUnits: '40000000',
    spendingAuthorization: 'remesso-policy-local-fixture',
    authorizationConfirmed: true,
  });
  return { ...campaign, assertion };
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
  for (const [task, report] of Object.entries(correct))
    await submitAttempt(db.pool, operator, { task, report });
  const credential = await createCredential(db.pool, actor, {
    name: 'Runner',
    scopes,
    expiresInDays: 7,
  });
  const session = await authenticateAgent(db.pool, credential.secret);
  return { actor, operator, session };
}
type Report = {
  assertion?: string;
  detail?: string;
  actual?: string;
  outcome?: 'product_failed' | 'executed';
  passed?: boolean;
  severity?: 'blocking' | 'major' | 'minor';
};
/** Claims, runs, uploads evidence, and submits one report for this operator. */
async function reportFrom(
  session: AgentSession,
  campaign: { campaignId: string; contentHash: string; assertion: string },
  report: Report = {},
) {
  const assignment = await claim(db.pool, session, { campaignId: campaign.campaignId });
  const run = await startRun(
    db.pool,
    session,
    assignment.assignmentId,
    { attemptToken: assignment.attemptToken },
    { resolver: publicDns, probe: settled },
  );
  const grant = await authenticateRun(db.pool, run.runToken);
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
  const failed = (report.outcome ?? 'product_failed') === 'product_failed';
  const now = new Date().toISOString();
  const document = {
    schemaVersion: 1,
    campaignId: assignment.campaignId,
    assignmentId: assignment.assignmentId,
    termsVersionId: assignment.termsVersionId,
    termsContentHash: campaign.contentHash,
    build: {
      id: assignment.buildId,
      revision: 'baseline-1',
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
    steps: [
      {
        index: 1,
        action: 'Invite teammate+qa@example.test',
        expected: 'Invitation created',
        actual: report.actual ?? 'Rejected with 400',
        status: failed ? 'failed' : 'passed',
      },
    ],
    assertions: [
      {
        name: report.assertion ?? campaign.assertion,
        passed: !failed,
        detail: report.detail ?? 'Expected 201, observed 400',
      },
    ],
    outcome: failed ? 'product_failed' : 'executed',
    proposedSeverity: report.severity,
    summary: 'The seeded validator rejects a plus alias on the pinned build.',
    artifacts: [
      { name: 'replay.trace.zip', sha256: digestOf(archive) },
      { name: 'assertions.json', sha256: digestOf(assertions) },
    ],
  };
  const result = await submitEvidence(db.pool, grant, document);
  return { assignment, run, result };
}
const accept = {
  outcome: 'accepted',
  reason: 'Every assigned step ran with complete evidence.',
  evidenceRefs: [],
};

before(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), 'trialoom-decisions-'));
  process.env.TRIALOOM_EVIDENCE_DIR = evidenceDir;
  db = await disposableDatabase();
  await migrate(db.pool);
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Decisions workspace',
  });
  workspaceId = bootstrap.workspaceId;
  await acceptInvitation(db.pool, { token: bootstrap.token, name: 'Owner', password }, null);
  owner = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [
      'owner@example.test',
    ])
  ).rows[0];
  for (const [role, email] of [
    ['reviewer', 'reviewer@example.test'],
    ['member', 'member@example.test'],
  ]) {
    const invite = await createInvitation(db.pool, owner, workspaceId, { email, role });
    await acceptInvitation(db.pool, { token: invite.token, name: role, password }, null);
  }
  reviewer = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [
      'reviewer@example.test',
    ])
  ).rows[0];
  member = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [
      'member@example.test',
    ])
  ).rows[0];
  const project = await createProject(
    db.pool,
    owner,
    workspaceId,
    {
      name: 'Decisions preview project',
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
      { revision: 'baseline-1', fixtureVersion: 'invitation-1', targetUrl: target },
      publicDns,
    )
  ).id;
});
after(async () => {
  await db?.close();
  if (evidenceDir) await rm(evidenceDir, { recursive: true, force: true });
});

test('the same failure on the same build clusters into one defect', async () => {
  const campaign = await newCampaign('Clustering');
  const first = await qualifiedOperator('cluster-one');
  const second = await qualifiedOperator('cluster-two');
  const a = await reportFrom(first.session, campaign);
  const b = await reportFrom(second.session, campaign);
  assert.equal(a.result.finding?.match, 'first');
  assert.equal(b.result.finding?.match, 'exact');
  assert.equal(a.result.finding?.defectId, b.result.finding?.defectId);
  // Two independent reports of the same failure confirm the defect.
  const defect = (
    await db.pool.query('SELECT state,review_flag FROM defects WHERE id=$1', [
      a.result.finding?.defectId,
    ])
  ).rows[0];
  assert.equal(defect.state, 'confirmed');
  assert.equal(defect.review_flag, null);
});

test('the same assertion with different detail is a candidate, not a duplicate', async () => {
  const campaign = await newCampaign('Uncertain');
  const first = await qualifiedOperator('uncertain-one');
  const second = await qualifiedOperator('uncertain-two');
  const a = await reportFrom(first.session, campaign);
  const b = await reportFrom(second.session, campaign, { actual: 'Rejected with 500' });
  assert.equal(b.result.finding?.match, 'uncertain');
  // Nothing is grouped on a guess; the existing defect is flagged for review.
  assert.equal(b.result.finding?.defectId, null);
  const flagged = (
    await db.pool.query('SELECT review_flag FROM defects WHERE id=$1', [a.result.finding?.defectId])
  ).rows[0];
  assert.equal(flagged.review_flag, 'uncertain_duplicate');
  const review = await campaignReview(db.pool, owner, workspaceId, projectId, campaign.campaignId);
  const pending = review.findings.find((row) => row.id === b.result.finding?.findingId);
  assert.deepEqual(pending.candidate_defect_ids, [a.result.finding?.defectId]);
  // A reviewer resolves it, and the flag stops asking.
  const decided = await decideDuplicate(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    b.result.finding?.findingId as string,
    {
      defectId: a.result.finding?.defectId as string,
      reason: 'Same validator rejection; the status code differs by environment.',
      evidenceRefs: [b.result.submissionId],
    },
  );
  assert.equal(decided.defectId, a.result.finding?.defectId);
  const cleared = (
    await db.pool.query('SELECT review_flag FROM defects WHERE id=$1', [a.result.finding?.defectId])
  ).rows[0];
  assert.equal(cleared.review_flag, null);
  await assert.rejects(
    decideDuplicate(
      db.pool,
      reviewer,
      workspaceId,
      projectId,
      a.result.finding?.findingId as string,
      {
        defectId: '00000000-0000-4000-8000-000000000000',
        reason: 'Not one of its candidates.',
        evidenceRefs: [],
      },
    ),
    code('DEFECT_NOT_CANDIDATE'),
  );
});

test('a different failure is its own defect', async () => {
  const campaign = await newCampaign('Separate');
  const first = await qualifiedOperator('separate-one');
  const second = await qualifiedOperator('separate-two');
  const a = await reportFrom(first.session, campaign);
  const b = await reportFrom(second.session, campaign, { assertion: 'invitation.resend' });
  assert.equal(b.result.finding?.match, 'first');
  assert.notEqual(a.result.finding?.defectId, b.result.finding?.defectId);
});

test('a linked operator cannot independently reproduce a finding', async () => {
  const campaign = await newCampaign('Independence');
  const first = await qualifiedOperator('linked-one');
  const second = await qualifiedOperator('linked-two');
  const a = await reportFrom(first.session, campaign);
  // The two identities proved the same payout wallet, one after the other.
  const address = `0x${randomBytes(20).toString('hex')}`;
  for (const holder of [first, second])
    await db.pool.query(
      `INSERT INTO wallet_challenges (id,operator_id,chain_id,address,nonce,message,expires_at,consumed_at)
      VALUES (gen_random_uuid(),$1,42220,$2,$3,'proof',clock_timestamp()+interval '1 hour',clock_timestamp())`,
      [holder.operator.id, address, randomBytes(16).toString('hex')],
    );
  await db.pool.query(
    `INSERT INTO operator_wallets (operator_id,chain_id,address,account_type,challenge_id,
      proof_message,signature_hash,revoked_at)
    SELECT w.operator_id,42220,$1,'eoa',w.id,'proof',$2,
      CASE WHEN w.operator_id=$3 THEN clock_timestamp() ELSE NULL END
    FROM wallet_challenges w WHERE w.address=$1`,
    [address, randomBytes(32).toString('hex'), first.operator.id],
  );
  const b = await reportFrom(second.session, campaign);
  assert.equal(b.result.finding?.match, 'exact');
  assert.equal(b.result.finding?.independent, false);
  assert.match(b.result.finding?.independenceReason ?? '', /same payout wallet/);
  const defect = (
    await db.pool.query('SELECT state,review_flag FROM defects WHERE id=$1', [
      a.result.finding?.defectId,
    ])
  ).rows[0];
  // A linked report is recorded but routed for review, not counted as proof.
  assert.equal(defect.state, 'unconfirmed');
  assert.equal(defect.review_flag, 'independence_failed');
});

test('a clean run of the same assertions marks the defect potentially flaky', async () => {
  const campaign = await newCampaign('Flaky');
  const first = await qualifiedOperator('flaky-one');
  const second = await qualifiedOperator('flaky-two');
  const a = await reportFrom(first.session, campaign);
  const clean = await reportFrom(second.session, campaign, { outcome: 'executed' });
  assert.equal(clean.result.finding, null);
  assert.equal(clean.result.contradictedDefects, 1);
  const defect = (
    await db.pool.query('SELECT state,review_flag FROM defects WHERE id=$1', [
      a.result.finding?.defectId,
    ])
  ).rows[0];
  // Inconsistency goes to review; it is not proof the first report was false.
  assert.equal(defect.state, 'flaky');
  assert.equal(defect.review_flag, 'inconsistent_result');
});

test('valid execution is payable without the discovery decision, and the fee never over-charges', async () => {
  const campaign = await newCampaign('Independent payment');
  const operator = await qualifiedOperator('payable-one');
  const report = await reportFrom(operator.session, campaign);
  const before = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(before?.committedUnits, '3800000');
  const decision = await decideExecution(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    report.assignment.assignmentId,
    accept,
  );
  // 2.00 execution plus its 10% fee, and nothing of the discovery reserve.
  assert.equal(decision.movedUnits, '2200000');
  const mid = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(mid?.acceptedUnits, '2200000');
  // The discovery reserve stays committed while that matter is open.
  assert.equal(mid?.committedUnits, '1600000');
  assert.equal(mid?.reconciled, true);
  const assignment = (
    await db.pool.query('SELECT state,accepted_units,release_after FROM assignments WHERE id=$1', [
      report.assignment.assignmentId,
    ])
  ).rows[0];
  assert.equal(assignment.state, 'accepted');
  assert.equal(assignment.accepted_units, '2200000');
  assert.equal(assignment.release_after, null);
  const awarded = await decideDiscovery(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    report.result.finding?.findingId as string,
    {
      outcome: 'awarded',
      amountUnits: '1000000',
      severity: 'major',
      reason: 'First complete report of a confirmed in-scope defect.',
      evidenceRefs: [report.result.finding?.findingId as string],
    },
  );
  assert.equal(awarded.movedUnits, '1100000');
  const after = await campaignAccounting(db.pool, campaign.campaignId);
  // The fee is charged once on the running total, never twice on the parts.
  assert.equal(after?.acceptedUnits, '3300000');
  assert.equal(after?.reconciled, true);
  const fee = after?.byCategory.find((row: { category: string }) => row.category === 'fee');
  assert.equal(fee.accepted, feeFor(3_000_000n, 1000n).toString());
});

test('separate acceptances never round past the single reserved fee', async () => {
  const campaign = await newCampaign('Rounding', {
    priceUnits: '1',
    discoveryRewardCapUnits: '1',
    resourceAllowanceUnits: '0',
    platformFeeBps: 1,
  });
  const operator = await qualifiedOperator('rounding-one');
  const report = await reportFrom(operator.session, campaign);
  // The claim reserved one base unit of fee for the whole assignment.
  const reserved = (
    await db.pool.query('SELECT max_liability_units FROM assignments WHERE id=$1', [
      report.assignment.assignmentId,
    ])
  ).rows[0];
  assert.equal(reserved.max_liability_units, '3');
  await decideExecution(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    report.assignment.assignmentId,
    accept,
  );
  const awarded = await decideDiscovery(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    report.result.finding?.findingId as string,
    {
      outcome: 'awarded',
      amountUnits: '1',
      reason: 'Confirmed defect at the smallest reward.',
      evidenceRefs: [],
    },
  );
  // Charging each award its own rounded fee would have needed two units.
  assert.equal(awarded.movedUnits, '1');
  const accounting = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(accounting?.acceptedUnits, '3');
  assert.equal(accounting?.reconciled, true);
});

test('a decision cannot exceed the pinned terms and only a builder can record one', async () => {
  const campaign = await newCampaign('Bounds');
  const operator = await qualifiedOperator('bounds-one');
  const report = await reportFrom(operator.session, campaign);
  await assert.rejects(
    decideExecution(db.pool, reviewer, workspaceId, projectId, report.assignment.assignmentId, {
      ...accept,
      amountUnits: '2000001',
    }),
    code('EXCEEDS_TERMS'),
  );
  await assert.rejects(
    decideExecution(
      db.pool,
      member,
      workspaceId,
      projectId,
      report.assignment.assignmentId,
      accept,
    ),
    code('ACCESS_DENIED'),
  );
  await assert.rejects(
    decideExecution(db.pool, reviewer, workspaceId, projectId, report.assignment.assignmentId, {
      ...accept,
      evidenceRefs: ['00000000-0000-4000-8000-000000000000'],
    }),
    code('EVIDENCE_REF_UNKNOWN'),
  );
  await decideExecution(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    report.assignment.assignmentId,
    accept,
  );
  // One settled decision per matter; a change is an appeal, not an edit.
  await assert.rejects(
    decideExecution(
      db.pool,
      reviewer,
      workspaceId,
      projectId,
      report.assignment.assignmentId,
      accept,
    ),
    code('ALREADY_DECIDED'),
  );
  await assert.rejects(
    decideDiscovery(
      db.pool,
      reviewer,
      workspaceId,
      projectId,
      report.result.finding?.findingId as string,
      {
        outcome: 'awarded',
        amountUnits: '1000001',
        reason: 'Over the published cap.',
        evidenceRefs: [],
      },
    ),
    code('EXCEEDS_TERMS'),
  );
});

test('one defect earns one discovery reward, and a later report is still paid for its work', async () => {
  const campaign = await newCampaign('Priority');
  const first = await qualifiedOperator('priority-one');
  const second = await qualifiedOperator('priority-two');
  const a = await reportFrom(first.session, campaign);
  const b = await reportFrom(second.session, campaign);
  await decideDiscovery(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    a.result.finding?.findingId as string,
    {
      outcome: 'awarded',
      amountUnits: '1000000',
      reason: 'Earliest complete valid report of this defect.',
      evidenceRefs: [],
    },
  );
  await assert.rejects(
    decideDiscovery(
      db.pool,
      reviewer,
      workspaceId,
      projectId,
      b.result.finding?.findingId as string,
      {
        outcome: 'awarded',
        amountUnits: '1000000',
        reason: 'Same defect again.',
        evidenceRefs: [],
      },
    ),
    code('DISCOVERY_ALREADY_AWARDED'),
  );
  // The later report earns its execution fee independently of that refusal.
  const paid = await decideExecution(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    b.assignment.assignmentId,
    accept,
  );
  assert.equal(paid.movedUnits, '2200000');
  await decideDiscovery(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    b.result.finding?.findingId as string,
    {
      outcome: 'declined',
      reason: 'Duplicate of an already rewarded defect.',
      evidenceRefs: [],
    },
  );
  const defect = (
    await db.pool.query('SELECT awarded_finding_id FROM defects WHERE id=$1', [
      a.result.finding?.defectId,
    ])
  ).rows[0];
  assert.equal(defect.awarded_finding_id, a.result.finding?.findingId);
});

test('an earlier report must be decided before a later one can take the reward', async () => {
  const campaign = await newCampaign('Order');
  const first = await qualifiedOperator('order-one');
  const second = await qualifiedOperator('order-two');
  await reportFrom(first.session, campaign);
  const b = await reportFrom(second.session, campaign);
  await assert.rejects(
    decideDiscovery(
      db.pool,
      reviewer,
      workspaceId,
      projectId,
      b.result.finding?.findingId as string,
      { outcome: 'awarded', amountUnits: '500000', reason: 'Jumping the queue.', evidenceRefs: [] },
    ),
    code('NOT_FIRST_REPORT'),
  );
});

test('a refused amount stays reserved until its appeal window closes', async () => {
  const campaign = await newCampaign('Appeal window');
  const operator = await qualifiedOperator('window-one');
  const report = await reportFrom(operator.session, campaign);
  await decideExecution(db.pool, reviewer, workspaceId, projectId, report.assignment.assignmentId, {
    outcome: 'rejected',
    reason: 'The recorded steps do not cover the assigned journey.',
    evidenceRefs: [report.result.submissionId],
  });
  await decideDiscovery(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    report.result.finding?.findingId as string,
    { outcome: 'declined', reason: 'Not reproduced on the pinned build.', evidenceRefs: [] },
  );
  const held = await campaignAccounting(db.pool, campaign.campaignId);
  // Nothing is accepted, and nothing is released while an appeal is possible.
  assert.equal(held?.acceptedUnits, '0');
  assert.equal(held?.committedUnits, '3800000');
  await releaseSettledAssignments(db.pool);
  const assignment = (
    await db.pool.query('SELECT state,release_after FROM assignments WHERE id=$1', [
      report.assignment.assignmentId,
    ])
  ).rows[0];
  assert.equal(assignment.state, 'rejected');
  assert.ok(new Date(assignment.release_after) > new Date());
  const stillHeld = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(stillHeld?.committedUnits, '3800000');
  await db.pool.query(
    `UPDATE assignments SET release_after=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [report.assignment.assignmentId],
  );
  await releaseSettledAssignments(db.pool);
  const released = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(released?.committedUnits, '0');
  assert.equal(released?.acceptedUnits, '0');
  assert.equal(released?.reconciled, true);
});

test('an accepted assignment releases its remainder with nothing left to appeal', async () => {
  const campaign = await newCampaign('Settled');
  const operator = await qualifiedOperator('settled-one');
  const report = await reportFrom(operator.session, campaign);
  await decideExecution(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    report.assignment.assignmentId,
    accept,
  );
  await decideDiscovery(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    report.result.finding?.findingId as string,
    {
      outcome: 'awarded',
      amountUnits: '400000',
      reason: 'A minor in-scope defect under the published rubric.',
      evidenceRefs: [],
    },
  );
  await releaseSettledAssignments(db.pool);
  const accounting = await campaignAccounting(db.pool, campaign.campaignId);
  // Execution, the reward, and one fee on their total; the rest goes back.
  assert.equal(accounting?.acceptedUnits, (2_400_000n + feeFor(2_400_000n, 1000n)).toString());
  assert.equal(accounting?.committedUnits, '0');
  assert.equal(accounting?.reconciled, true);
});

test('an operator appeals a refusal, and an overturned appeal pays it', async () => {
  const campaign = await newCampaign('Overturned');
  const operator = await qualifiedOperator('appeal-one');
  const report = await reportFrom(operator.session, campaign);
  await assert.rejects(
    openAppeal(db.pool, operator.session, report.assignment.assignmentId, {
      subject: 'execution',
      reason: 'Nothing has been decided yet.',
    }),
    code('NOT_DECIDED'),
  );
  await decideExecution(db.pool, reviewer, workspaceId, projectId, report.assignment.assignmentId, {
    outcome: 'rejected',
    reason: 'Evidence looked incomplete on a first read.',
    evidenceRefs: [],
  });
  await decideDiscovery(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    report.result.finding?.findingId as string,
    { outcome: 'declined', reason: 'Pending the execution question.', evidenceRefs: [] },
  );
  const opened = await openAppeal(db.pool, operator.session, report.assignment.assignmentId, {
    subject: 'execution',
    reason: 'The trace records every assigned step; please re-read artifact two.',
  });
  assert.equal(opened.state, 'open');
  // An open appeal holds the reservation: the sweep must not free it.
  const pending = (
    await db.pool.query('SELECT release_after FROM assignments WHERE id=$1', [
      report.assignment.assignmentId,
    ])
  ).rows[0];
  assert.equal(pending.release_after, null);
  await releaseSettledAssignments(db.pool);
  const stillReserved = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(stillReserved?.committedUnits, '3800000');
  await assert.rejects(
    openAppeal(db.pool, operator.session, report.assignment.assignmentId, {
      subject: 'execution',
      reason: 'Opening a second appeal.',
    }),
    code('APPEAL_OPEN'),
  );
  const resolved = await resolveAppeal(
    db.pool,
    owner,
    workspaceId,
    projectId,
    report.assignment.assignmentId,
    {
      outcome: 'overturned',
      amountUnits: '2000000',
      reason: 'The second artifact does record the missing steps.',
      evidenceRefs: [report.result.submissionId],
    },
  );
  assert.equal(resolved.movedUnits, '2200000');
  const assignment = (
    await db.pool.query('SELECT state,accepted_units FROM assignments WHERE id=$1', [
      report.assignment.assignmentId,
    ])
  ).rows[0];
  assert.equal(assignment.state, 'accepted');
  assert.equal(assignment.accepted_units, '2200000');
  await releaseSettledAssignments(db.pool);
  const accounting = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(accounting?.acceptedUnits, '2200000');
  assert.equal(accounting?.committedUnits, '0');
  assert.equal(accounting?.reconciled, true);
  // The original refusal is still on the record beside its correction.
  const trail = (
    await db.pool.query(
      `SELECT matter,outcome,actor_role FROM decisions WHERE assignment_id=$1 ORDER BY created_at`,
      [report.assignment.assignmentId],
    )
  ).rows;
  assert.deepEqual(
    trail.map((row) => [row.matter, row.outcome, row.actor_role]),
    [
      ['execution', 'rejected', 'reviewer'],
      ['discovery', 'declined', 'reviewer'],
      ['appeal', 'opened', 'operator'],
      ['appeal', 'overturned', 'owner'],
    ],
  );
});

test('an appeal needs a refusal and a window that is still open', async () => {
  const campaign = await newCampaign('Appeal limits');
  const operator = await qualifiedOperator('appeal-two');
  const report = await reportFrom(operator.session, campaign);
  await decideExecution(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    report.assignment.assignmentId,
    accept,
  );
  await assert.rejects(
    openAppeal(db.pool, operator.session, report.assignment.assignmentId, {
      subject: 'execution',
      reason: 'Appealing an acceptance.',
    }),
    code('NOT_REFUSED'),
  );
  // A decision row cannot be edited, so an already closed window is written as
  // the record it would be.
  await db.pool.query(
    `INSERT INTO decisions (campaign_id,assignment_id,subject_type,subject_id,matter,outcome,
    criteria,reason,evidence_refs,actor_id,actor_role,appeal_deadline)
    VALUES ($1,$2,'finding',$3,'discovery','declined',$4,$5,'[]'::jsonb,$6,'reviewer',
    clock_timestamp()-interval '1 day')`,
    [
      campaign.campaignId,
      report.assignment.assignmentId,
      report.result.finding?.findingId,
      'One reward per distinct accepted defect',
      'Out of the published scope.',
      reviewer.id,
    ],
  );
  await assert.rejects(
    openAppeal(db.pool, operator.session, report.assignment.assignmentId, {
      subject: 'discovery',
      reason: 'Too late.',
    }),
    code('APPEAL_WINDOW_CLOSED'),
  );
});

test('decisions record criteria, reason, evidence and actor, and are immutable', async () => {
  const campaign = await newCampaign('Record');
  const operator = await qualifiedOperator('record-one');
  const report = await reportFrom(operator.session, campaign, { severity: 'minor' });
  await decideExecution(db.pool, reviewer, workspaceId, projectId, report.assignment.assignmentId, {
    ...accept,
    evidenceRefs: [report.result.submissionId, report.result.finding?.findingId as string],
  });
  const severity = await decideSeverity(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    report.result.finding?.findingId as string,
    {
      severity: 'blocking',
      reason: 'A blocked core journey under the published rubric.',
      evidenceRefs: [],
    },
  );
  assert.equal(severity.severity, 'blocking');
  const stored = (
    await db.pool.query(
      `SELECT matter,outcome,criteria,reason,evidence_refs,actor_id,actor_role
      FROM decisions WHERE assignment_id=$1 AND matter='execution'`,
      [report.assignment.assignmentId],
    )
  ).rows[0];
  // The criteria recorded are the ones the claim pinned.
  assert.equal(stored.criteria, 'Reports must replay from the exported trace');
  assert.equal(stored.actor_id, reviewer.id);
  assert.equal(stored.actor_role, 'reviewer');
  assert.equal(stored.evidence_refs.length, 2);
  await assert.rejects(
    db.pool.query("UPDATE decisions SET outcome='rejected' WHERE assignment_id=$1", [
      report.assignment.assignmentId,
    ]),
    /immutable/,
  );
  const defect = (
    await db.pool.query('SELECT severity FROM defects WHERE id=$1', [
      report.result.finding?.defectId,
    ])
  ).rows[0];
  assert.equal(defect.severity, 'blocking');
  const review = await campaignReview(db.pool, owner, workspaceId, projectId, campaign.campaignId);
  assert.equal(review.decisions.length, 2);
  assert.equal(review.findings[0].proposed_severity, 'minor');
  assert.equal(review.findings[0].severity, 'blocking');
});

test('an operator reads the decisions on their own work and a reviewer read is audited', async () => {
  const campaign = await newCampaign('Operator view');
  const operator = await qualifiedOperator('view-one');
  const report = await reportFrom(operator.session, campaign);
  await decideExecution(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    report.assignment.assignmentId,
    accept,
  );
  const view = await operatorDecisions(db.pool, operator.operator.id);
  assert.equal(view.decisions.length, 1);
  assert.equal(view.decisions[0].matter, 'execution');
  assert.equal(view.decisions[0].outcome, 'accepted');
  assert.equal(view.decisions[0].amount_units, '2000000');
  assert.equal(view.appealWindowHours, 168);
  await campaignReview(db.pool, reviewer, workspaceId, projectId, campaign.campaignId);
  const audited = await db.pool.query(
    "SELECT action FROM audit_events WHERE actor_id=$1 AND action='reviewer.review_read'",
    [reviewer.id],
  );
  assert.ok((audited.rowCount ?? 0) >= 1);
});

test('an unclustered report cannot be rewarded before its grouping is decided', async () => {
  const campaign = await newCampaign('Ungrouped');
  const first = await qualifiedOperator('ungrouped-one');
  const second = await qualifiedOperator('ungrouped-two');
  await reportFrom(first.session, campaign);
  const b = await reportFrom(second.session, campaign, { actual: 'Rejected with 503' });
  assert.equal(b.result.finding?.match, 'uncertain');
  await assert.rejects(
    decideDiscovery(
      db.pool,
      reviewer,
      workspaceId,
      projectId,
      b.result.finding?.findingId as string,
      { outcome: 'awarded', amountUnits: '100000', reason: 'Before grouping.', evidenceRefs: [] },
    ),
    code('DUPLICATE_UNDECIDED'),
  );
  await assert.rejects(
    decideSeverity(
      db.pool,
      reviewer,
      workspaceId,
      projectId,
      b.result.finding?.findingId as string,
      {
        severity: 'minor',
        reason: 'Before grouping.',
        evidenceRefs: [],
      },
    ),
    code('DUPLICATE_UNDECIDED'),
  );
});
