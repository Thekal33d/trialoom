import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { AppError } from '../src/domain/errors.ts';
import { canonicalJson } from '../src/domain/values.ts';
import type { Actor } from '../src/server/access.ts';
import { type AgentSession, authenticateAgent } from '../src/server/agents.ts';
import { claim, publishCampaign } from '../src/server/assignments.ts';
import { reviewTargetHours, workspaceAttention } from '../src/server/attention.ts';
import { decideExecution } from '../src/server/decisions.ts';
import { storeArtifact, submitEvidence } from '../src/server/evidence.ts';
import { campaignExport } from '../src/server/exports.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { migrate } from '../src/server/migrations.ts';
import { createCredential, registerOperator } from '../src/server/operators.ts';
import { addBuild, createCampaign, createProject } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import { authenticateRun, isolationProfile, startRun } from '../src/server/runner.ts';
import { digestOf } from '../src/server/storage.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let owner: Actor, member: Actor, reviewer: Actor;
let workspaceId: string, projectId: string, buildId: string, evidenceDir: string;
const password = randomBytes(24).toString('base64url');
const code = (name: string) => (error: unknown) => error instanceof AppError && error.code === name;
const target = 'https://preview.example.com/';
const publicDns = async () => ['93.184.215.14'];
const settledProbe = async () => ({ status: 200, location: null, revision: 'baseline-1' });
const archiveBytes = () =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0xff, 0xfe]), randomBytes(24)]);
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
// A secret shape in operator-supplied prose, which must not leave in a file.
const leaked = 'authorization: Bearer abcdefghijklmnopqrstuvwxyz012345';

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
async function newCampaign(name: string) {
  const assertion = `invitation.${name.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  const campaign = await createCampaign(db.pool, owner, workspaceId, projectId, {
    name,
    terms: termsInput(),
  });
  await publishCampaign(db.pool, owner, workspaceId, projectId, campaign.campaignId, {
    termsVersionId: campaign.id,
    slots: 2,
    maxConcurrent: 2,
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
    scopes: ['work:read', 'assignments:read', 'assignments:claim', 'runs:execute'],
    expiresInDays: 7,
  });
  return { actor, operator, session: await authenticateAgent(db.pool, credential.secret) };
}
/** One complete report, with a text artifact and a secret shape in its prose. */
async function reportFrom(
  session: AgentSession,
  campaign: { campaignId: string; contentHash: string; assertion: string },
) {
  const assignment = await claim(db.pool, session, { campaignId: campaign.campaignId });
  const run = await startRun(
    db.pool,
    session,
    assignment.assignmentId,
    { attemptToken: assignment.attemptToken },
    { resolver: publicDns, probe: settledProbe },
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
  const report = Buffer.from(`{"note":"${leaked}"}`, 'utf8');
  await storeArtifact(
    db.pool,
    grant,
    { name: 'report.json', kind: 'report', sha256: digestOf(report) },
    'application/json',
    report,
  );
  const assertions = Buffer.from('{"invitationAccepted":false}', 'utf8');
  await storeArtifact(
    db.pool,
    grant,
    { name: 'assertions.json', kind: 'assertions', sha256: digestOf(assertions) },
    'application/json',
    assertions,
  );
  const now = new Date().toISOString();
  const result = await submitEvidence(db.pool, grant, {
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
        // Operator-supplied prose, carrying a secret shape.
        actual: `Rejected with 400 while sending ${leaked}`,
        status: 'failed',
      },
    ],
    assertions: [{ name: campaign.assertion, passed: false, detail: 'Expected 201, observed 400' }],
    outcome: 'product_failed',
    summary: 'The seeded validator rejects a plus alias on the pinned build.',
    artifacts: [
      { name: 'replay.trace.zip', sha256: digestOf(archive) },
      { name: 'report.json', sha256: digestOf(report) },
      { name: 'assertions.json', sha256: digestOf(assertions) },
    ],
  });
  return { assignment, result };
}
const read = (files: Record<string, Uint8Array>, name: string) =>
  JSON.parse(strFromU8(files[name]));

before(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), 'trialoom-exports-'));
  process.env.TRIALOOM_EVIDENCE_DIR = evidenceDir;
  db = await disposableDatabase();
  await migrate(db.pool);
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Exports workspace',
  });
  workspaceId = bootstrap.workspaceId;
  await acceptInvitation(db.pool, { token: bootstrap.token, name: 'Owner', password }, null);
  for (const [role, email] of [
    ['member', 'member@example.test'],
    ['reviewer', 'reviewer@example.test'],
  ]) {
    const invite = await createInvitation(db.pool, owner ?? (await firstOwner()), workspaceId, {
      email,
      role,
    });
    await acceptInvitation(db.pool, { token: invite.token, name: role, password }, null);
  }
  async function firstOwner(): Promise<Actor> {
    return (
      await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [
        'owner@example.test',
      ])
    ).rows[0];
  }
  owner = await firstOwner();
  member = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [
      'member@example.test',
    ])
  ).rows[0];
  reviewer = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [
      'reviewer@example.test',
    ])
  ).rows[0];
  const project = await createProject(
    db.pool,
    owner,
    workspaceId,
    {
      name: 'Exports preview project',
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

test('an export carries the record, the replay instructions, and no raw bytes', async () => {
  const campaign = await newCampaign('Exported');
  const operator = await qualifiedOperator('export-one');
  const reported = await reportFrom(operator.session, campaign);
  await decideExecution(db.pool, owner, workspaceId, projectId, reported.assignment.assignmentId, {
    outcome: 'accepted',
    reason: 'Every assigned step ran and the trace replays.',
    evidenceRefs: [],
  });
  const archive = await campaignExport(db.pool, owner, workspaceId, projectId, campaign.campaignId);
  assert.match(archive.filename, /^trialoom-exported-export\.zip$/);
  const files = unzipSync(archive.bytes);
  const names = Object.keys(files).sort();
  for (const expected of [
    'manifest.json',
    'findings.json',
    'replay.json',
    'decisions.json',
    'repairs.json',
    'payments.json',
    'withheld.json',
  ])
    assert.ok(names.includes(expected), `${expected} is missing from the export`);

  // The manifest states what it is and can be checked against its own body.
  const manifest = read(files, 'manifest.json');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.campaign.name, 'Exported');
  assert.equal(manifest.redaction.rawBytesIncluded, false);
  assert.equal(manifest.counts.submissions, 1);
  // The hash is over what the file holds, so whoever has the export can check
  // it exactly as the manifest says to.
  const { contentHash, ...body } = manifest;
  assert.equal(contentHash, createHash('sha256').update(canonicalJson(body)).digest('hex'));
  // Every terms version travels with it, because an assignment is judged by
  // the one it pinned.
  assert.equal(manifest.terms.length, 1);
  assert.equal(manifest.terms[0].contentHash, campaign.contentHash);

  // Replay instructions: what was pinned, attested and observed.
  const replay = read(files, 'replay.json').replays[0];
  assert.equal(replay.build.revision, 'baseline-1');
  assert.equal(replay.build.fixtureVersion, 'invitation-1');
  assert.deepEqual(replay.isolation, isolationProfile);
  assert.deepEqual(replay.permitted, ['Create sandbox invitations']);
  assert.equal(replay.steps.length, 1);
  assert.equal(replay.operator, 'export-one');

  // The decision keeps the criteria the claim pinned, with its actor's role.
  const decision = read(files, 'decisions.json').decisions[0];
  assert.equal(decision.matter, 'execution');
  assert.equal(decision.criteria, 'Reports must replay from the exported trace');
  assert.equal(decision.actor_role, 'owner');

  // The payment ledger, and what is owed rather than paid.
  const payments = read(files, 'payments.json');
  assert.equal(payments.accounting.reconciled, true);
  assert.ok(payments.payables.some((payable: { state: string }) => payable.state === 'blocked'));
});

test('an export redacts operator prose and withholds what it cannot clean', async () => {
  const campaign = await newCampaign('Redacted');
  const operator = await qualifiedOperator('export-two');
  await reportFrom(operator.session, campaign);
  const archive = await campaignExport(db.pool, owner, workspaceId, projectId, campaign.campaignId);
  const files = unzipSync(archive.bytes);
  const everything = Object.values(files)
    .map((bytes) => strFromU8(bytes))
    .join('\n');
  // Nothing in the whole file carries the secret the operator wrote into both
  // an artifact and a step's prose.
  assert.ok(!everything.includes('abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(everything.includes('[REDACTED:'));
  const replay = read(files, 'replay.json').replays[0];
  // The policy keeps the field name and removes the value, so the prose stays
  // readable and the secret does not travel.
  assert.match(replay.steps[0].actual, /sending authorization: \[REDACTED:authorization_header\]/);

  // The archive has no redacted copy, so it is named rather than included.
  const withheld = read(files, 'withheld.json');
  assert.equal(withheld.artifacts.length, 1);
  assert.equal(withheld.artifacts[0].name, 'replay.trace.zip');
  assert.match(withheld.artifacts[0].reason, /original stays private/i);
  const included = Object.keys(files).filter((name) => name.startsWith('artifacts/'));
  assert.deepEqual(included.sort(), ['artifacts/assertions.json', 'artifacts/report.json']);
  // What is included is the verified redacted copy, not the stored bytes.
  assert.ok(strFromU8(files['artifacts/report.json']).includes('[REDACTED:'));
});

test('exporting is a builder capability and a reviewer cannot take a copy', async () => {
  const campaign = await newCampaign('Permitted');
  const operator = await qualifiedOperator('export-three');
  await reportFrom(operator.session, campaign);
  // A project member exports their own work.
  const byMember = await campaignExport(
    db.pool,
    member,
    workspaceId,
    projectId,
    campaign.campaignId,
  );
  assert.ok(byMember.bytes.length > 0);
  // A reviewer reads the screens; taking a copy of the whole record is the
  // builder's decision, so FR16 stops at the builder side.
  await assert.rejects(
    campaignExport(db.pool, reviewer, workspaceId, projectId, campaign.campaignId),
    code('ACCESS_DENIED'),
  );
  const outsider = await qualifiedOperator('export-outsider');
  await assert.rejects(
    campaignExport(db.pool, outsider.actor, workspaceId, projectId, campaign.campaignId),
    code('ACCESS_DENIED'),
  );
  // Every export is recorded, because it takes the record out of the platform.
  const audited = await db.pool.query(
    "SELECT count(*)::int AS n FROM audit_events WHERE action='campaign.exported' AND subject_id=$1",
    [campaign.campaignId],
  );
  assert.equal(audited.rows[0].n, 1);
});

test('the queue names what is waiting and on whom, and decides nothing', async () => {
  const campaign = await newCampaign('Queued');
  const operator = await qualifiedOperator('queue-one');
  const reported = await reportFrom(operator.session, campaign);
  const queue = await workspaceAttention(db.pool, owner, workspaceId);
  const row = queue.campaigns.find((entry) => entry.id === campaign.campaignId);
  assert.equal(row?.attention?.awaiting_decision, 1);
  assert.equal(row?.attention?.pastReviewTarget, false);
  assert.equal(queue.policy.reviewTargetHours, reviewTargetHours);
  assert.ok(queue.totals.awaitingDecision >= 1);
  // Nothing here accepts or refuses anything, and the state is derived: once a
  // decision exists the submission leaves the queue on its own.
  await decideExecution(db.pool, owner, workspaceId, projectId, reported.assignment.assignmentId, {
    outcome: 'rejected',
    reason: 'The trace does not replay.',
    evidenceRefs: [],
  });
  const after = await workspaceAttention(db.pool, owner, workspaceId);
  const decided = after.campaigns.find((entry) => entry.id === campaign.campaignId);
  assert.equal(decided?.attention?.awaiting_decision, 0);
  // A refusal is owed nothing and still shows what the operator may appeal.
  assert.equal(decided?.attention?.open_appeals, 0);
  assert.equal(after.policy.appealWindowHours, 168);
});

/**
 * A submission is immutable, so a long wait cannot be simulated by editing one.
 * This writes the record a submission made that many hours ago would be.
 */
async function waitedFor(session: AgentSession, campaign: { campaignId: string }, hours: number) {
  const assignment = await claim(db.pool, session, { campaignId: campaign.campaignId });
  const run = await startRun(
    db.pool,
    session,
    assignment.assignmentId,
    { attemptToken: assignment.attemptToken },
    { resolver: publicDns, probe: settledProbe },
  );
  await db.pool.query(
    `INSERT INTO evidence_submissions (run_id,assignment_id,campaign_id,terms_version_id,build_id,
    operator_id,outcome,document,content_hash,artifact_count,total_bytes,started_at,finished_at,
    submitted_at)
    SELECT $1,$2,$3,$4,$5,r.operator_id,'executed','{}'::jsonb,$6,2,64,
      clock_timestamp()-make_interval(hours=>$7),clock_timestamp()-make_interval(hours=>$7),
      clock_timestamp()-make_interval(hours=>$7)
    FROM runs r WHERE r.id=$1`,
    [
      run.runId,
      assignment.assignmentId,
      assignment.campaignId,
      assignment.termsVersionId,
      assignment.buildId,
      'b'.repeat(64),
      hours,
    ],
  );
  await db.pool.query("UPDATE assignments SET state='submitted' WHERE id=$1", [
    assignment.assignmentId,
  ]);
  return assignment;
}

test('a submission past the review target is late, and past escalation is escalated', async () => {
  const late = await newCampaign('Late');
  const escalated = await newCampaign('Escalated');
  const first = await qualifiedOperator('queue-late');
  const second = await qualifiedOperator('queue-escalated');
  const waiting = await waitedFor(first.session, late, 30);
  await waitedFor(second.session, escalated, 72);
  const queue = await workspaceAttention(db.pool, owner, workspaceId);
  const overTarget = queue.campaigns.find((entry) => entry.id === late.campaignId);
  assert.equal(overTarget?.attention?.awaiting_decision, 1);
  assert.equal(overTarget?.attention?.pastReviewTarget, true);
  assert.equal(overTarget?.attention?.pastEscalation, false);
  assert.ok((overTarget?.attention?.waitingHours ?? 0) >= 30);
  const overEscalation = queue.campaigns.find((entry) => entry.id === escalated.campaignId);
  assert.equal(overEscalation?.attention?.pastEscalation, true);
  assert.ok(queue.totals.pastReviewTarget >= 2);
  assert.ok(queue.totals.pastEscalation >= 1);
  assert.ok((queue.totals.longestWaitHours ?? 0) >= 72);
  // Escalation is a fact about the clock. It decides nothing: the assignment is
  // still submitted and no decision exists.
  const state = (
    await db.pool.query('SELECT state FROM assignments WHERE id=$1', [waiting.assignmentId])
  ).rows[0];
  assert.equal(state.state, 'submitted');
  assert.equal(
    (
      await db.pool.query('SELECT count(*)::int AS n FROM decisions WHERE assignment_id=$1', [
        waiting.assignmentId,
      ])
    ).rows[0].n,
    0,
  );
});

test('a reviewer reads the same queue and the read is recorded', async () => {
  const queue = await workspaceAttention(db.pool, reviewer, workspaceId);
  assert.ok(queue.campaigns.length > 0);
  const audited = await db.pool.query(
    "SELECT count(*)::int AS n FROM audit_events WHERE action='reviewer.attention_read'",
  );
  assert.ok(audited.rows[0].n >= 1);
  // An operator is not a reader of the builder's queue at all.
  const outsider = await qualifiedOperator('queue-outsider');
  await assert.rejects(
    workspaceAttention(db.pool, outsider.actor, workspaceId),
    code('ACCESS_DENIED'),
  );
});
