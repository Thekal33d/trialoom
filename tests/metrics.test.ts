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
import { transaction } from '../src/server/database.ts';
import { decideDiscovery, decideExecution } from '../src/server/decisions.ts';
import { eventTopics, noteReviewOpened, sanitize } from '../src/server/events.ts';
import { storeArtifact, submitEvidence } from '../src/server/evidence.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { pilotMetrics, pilotReadiness } from '../src/server/metrics.ts';
import { migrate } from '../src/server/migrations.ts';
import { createCredential, registerOperator } from '../src/server/operators.ts';
import { addBuild, createCampaign, createProject } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import { authenticateRun, isolationProfile, startRun } from '../src/server/runner.ts';
import { digestOf } from '../src/server/storage.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let owner: Actor, reviewer: Actor;
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
async function draft(name: string, overrides: Record<string, unknown> = {}) {
  return createCampaign(db.pool, owner, workspaceId, projectId, {
    name,
    terms: termsInput(overrides),
  });
}
async function newCampaign(name: string, authorizeUnits = '40000000') {
  const campaign = await draft(name);
  await publishCampaign(db.pool, owner, workspaceId, projectId, campaign.campaignId, {
    termsVersionId: campaign.id,
    slots: 2,
    maxConcurrent: 2,
    authorizeUnits,
    spendingAuthorization: 'remesso-policy-local-fixture',
    authorizationConfirmed: true,
  });
  return campaign;
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
async function reportFrom(
  session: AgentSession,
  campaign: { campaignId: string; contentHash: string },
  assertion = 'invitation.create',
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
  const assertions = Buffer.from('{"invitationAccepted":false}', 'utf8');
  for (const [name, kind, mediaType, bytes] of [
    ['replay.trace.zip', 'trace', 'application/zip', archive],
    ['assertions.json', 'assertions', 'application/json', assertions],
  ] as const)
    await storeArtifact(db.pool, grant, { name, kind, sha256: digestOf(bytes) }, mediaType, bytes);
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
        actual: 'Rejected with 400',
        status: 'failed',
      },
    ],
    assertions: [{ name: assertion, passed: false, detail: 'Expected 201, observed 400' }],
    outcome: 'product_failed',
    summary: 'The seeded validator rejects a plus alias on the pinned build.',
    artifacts: [
      { name: 'replay.trace.zip', sha256: digestOf(archive) },
      { name: 'assertions.json', sha256: digestOf(assertions) },
    ],
  });
  return { assignment, result };
}
const topicsFor = async (campaignId: string) =>
  (
    await db.pool.query<{ topic: string }>(
      'SELECT topic FROM events WHERE campaign_id=$1 ORDER BY occurred_at',
      [campaignId],
    )
  ).rows.map((row) => row.topic);
const metric = async (id: string) => {
  const metrics = await transaction(db.pool, (client) => pilotMetrics(client, workspaceId));
  const found = metrics.find((entry) => entry.id === id);
  if (!found) throw new Error(`No metric ${id}`);
  return found;
};

before(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), 'trialoom-metrics-'));
  process.env.TRIALOOM_EVIDENCE_DIR = evidenceDir;
  db = await disposableDatabase();
  await migrate(db.pool);
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Metrics workspace',
  });
  workspaceId = bootstrap.workspaceId;
  await acceptInvitation(db.pool, { token: bootstrap.token, name: 'Owner', password }, null);
  owner = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [
      'owner@example.test',
    ])
  ).rows[0];
  const invite = await createInvitation(db.pool, owner, workspaceId, {
    email: 'reviewer@example.test',
    role: 'reviewer',
  });
  await acceptInvitation(db.pool, { token: invite.token, name: 'reviewer', password }, null);
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
      name: 'Metrics preview project',
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

test('the work a campaign does arrives as events, in order', async () => {
  const campaign = await newCampaign('Instrumented');
  const operator = await qualifiedOperator('metric-one');
  const reported = await reportFrom(operator.session, campaign);
  await decideExecution(db.pool, owner, workspaceId, projectId, reported.assignment.assignmentId, {
    outcome: 'accepted',
    reason: 'Every assigned step ran and the trace replays.',
    evidenceRefs: [],
  });
  assert.deepEqual(await topicsFor(campaign.campaignId), [
    'campaign.published',
    'assignment.claimed',
    'run.started',
    'evidence.submitted',
    'reproduction.outcome',
    'decision.accepted',
  ]);
  // Every event carries the identifiers the PRD asks them to share.
  const rows = (
    await db.pool.query(
      `SELECT topic,workspace_id,project_id,campaign_id,assignment_id FROM events
      WHERE campaign_id=$1 AND topic<>'campaign.published'`,
      [campaign.campaignId],
    )
  ).rows;
  for (const row of rows) {
    assert.equal(row.campaign_id, campaign.campaignId);
    assert.equal(row.assignment_id, reported.assignment.assignmentId);
    assert.equal(row.project_id, projectId);
  }
});

test('a refused publication is recorded, not lost with its rollback', async () => {
  const campaign = await draft('Underfunded');
  // The terms reserve 3.8 USDC per assignment, so two slots need 7.6.
  await assert.rejects(
    publishCampaign(db.pool, owner, workspaceId, projectId, campaign.campaignId, {
      termsVersionId: campaign.id,
      slots: 2,
      maxConcurrent: 2,
      authorizeUnits: '1000000',
      spendingAuthorization: 'remesso-policy-local-fixture',
      authorizationConfirmed: true,
    }),
    code('INSUFFICIENT_BUDGET'),
  );
  // The campaign is still a draft, and the funding failure survived the
  // rollback that undid everything else.
  const state = (
    await db.pool.query('SELECT status FROM campaigns WHERE id=$1', [campaign.campaignId])
  ).rows[0];
  assert.equal(state.status, 'draft');
  const events = (
    await db.pool.query(
      "SELECT topic,payload FROM events WHERE campaign_id=$1 AND topic='campaign.funding_failed'",
      [campaign.campaignId],
    )
  ).rows;
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.reason, 'INSUFFICIENT_BUDGET');
  assert.equal(events[0].payload.slots, 2);
});

test('events carry no credentials, by policy and by table check', async () => {
  // The application drops a forbidden key and redacts what is left.
  const cleaned = sanitize({
    runToken: 'trun_abcdefghijklmnopqrstuvwxyz',
    note: 'authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    nested: { password: 'hunter2', kept: 7 },
    count: 3,
  });
  assert.equal('runToken' in cleaned, false);
  assert.equal((cleaned.nested as Record<string, unknown>).password, undefined);
  assert.equal((cleaned.nested as Record<string, unknown>).kept, 7);
  assert.equal(cleaned.count, 3);
  assert.match(String(cleaned.note), /\[REDACTED/);
  assert.ok(!String(cleaned.note).includes('abcdefghijklmnopqrstuvwxyz012345'));
  // And the table refuses the key outright, so a careless caller cannot put a
  // secret into a stream that is read in bulk.
  await assert.rejects(
    db.pool.query(
      `INSERT INTO events (topic,payload) VALUES ('run.started','{"secret":"x"}'::jsonb)`,
    ),
    /events_check|violates check/i,
  );
  await assert.rejects(
    db.pool
      .query(
        `INSERT INTO events (topic,payload) VALUES ('run.started','{"ok":1}'::jsonb)
      RETURNING id`,
      )
      .then(async (inserted) =>
        db.pool.query('UPDATE events SET topic=$2 WHERE id=$1', [
          inserted.rows[0].id,
          'run.started',
        ]),
      ),
    /immutable/i,
  );
  // The topic list is closed: a metric cannot rest on an unlisted event.
  await assert.rejects(
    db.pool.query(`INSERT INTO events (topic) VALUES ('something.invented')`),
    /violates check/i,
  );
  assert.equal(eventTopics.length, 14);
});

test('the payload guard refuses a forbidden key at any depth', async () => {
  // The first version of this guard read only the top-level keys, so a secret
  // one level down passed a check that was described as refusing it.
  for (const [label, payload] of [
    ['at the top level', '{"secret":"x"}'],
    ['one level down', '{"outer":{"secret":"x"}}'],
    ['inside an array', '{"items":[{"token":"trh_abc"}]}'],
    ['three levels down', '{"a":{"b":{"password":"x"}}}'],
    ['beside clean keys', '{"ok":1,"meta":{"note":"fine","cookie":"c"}}'],
  ] as const)
    await assert.rejects(
      db.pool.query('INSERT INTO events (topic,payload) VALUES ($1,$2::jsonb)', [
        'run.started',
        payload,
      ]),
      /violates check/i,
      `a forbidden key ${label} must be refused`,
    );
  // A nested payload with no forbidden key is still allowed: the guard is
  // about the keys, not about shape.
  const clean = await db.pool.query(
    `INSERT INTO events (topic,payload) VALUES ('run.started','{"ok":1,"nested":{"fine":2}}'::jsonb)
    RETURNING id`,
  );
  assert.ok(clean.rows[0].id);
});

test('useful delivery counts decided submissions and names each rejection class', async () => {
  const campaign = await newCampaign('Delivery');
  const first = await qualifiedOperator('metric-accept');
  const second = await qualifiedOperator('metric-reject');
  const accepted = await reportFrom(first.session, campaign, 'invitation.delivery-a');
  const rejected = await reportFrom(second.session, campaign, 'invitation.delivery-b');
  await decideExecution(db.pool, owner, workspaceId, projectId, accepted.assignment.assignmentId, {
    outcome: 'accepted',
    reason: 'The trace replays on the pinned build.',
    evidenceRefs: [],
  });
  await decideExecution(db.pool, owner, workspaceId, projectId, rejected.assignment.assignmentId, {
    outcome: 'rejected',
    reason: 'The trace does not replay.',
    evidenceRefs: [],
  });
  const delivery = await metric('useful-delivery');
  assert.equal(delivery.complete, true);
  assert.ok((delivery.denominator ?? 0) >= 2);
  assert.equal(delivery.value, (delivery.numerator ?? 0) / (delivery.denominator ?? 1));
  // The PRD asks for each rejection class to be inspected, not just a rate.
  const classes = (delivery.detail?.rejectionClasses ?? []) as { outcome: string; n: number }[];
  assert.ok(classes.some((entry) => entry.outcome === 'product_failed'));
});

test('discovery precision measures the submissions that were adjudicated', async () => {
  const campaign = await newCampaign('Precision');
  const first = await qualifiedOperator('metric-precise-one');
  const second = await qualifiedOperator('metric-precise-two');
  // Two independent reports of the same failure confirm one defect.
  const a = await reportFrom(first.session, campaign, 'invitation.precision');
  const b = await reportFrom(second.session, campaign, 'invitation.precision');
  assert.equal(a.result.finding?.defectId, b.result.finding?.defectId);
  const before = await metric('discovery-precision');
  const adjudicatedBefore = before.denominator ?? 0;
  await decideDiscovery(
    db.pool,
    owner,
    workspaceId,
    projectId,
    a.result.finding?.findingId as string,
    {
      outcome: 'awarded',
      amountUnits: '1000000',
      reason: 'First complete report of a confirmed in-scope defect.',
      evidenceRefs: [],
    },
  );
  const after = await metric('discovery-precision');
  // The denominator counts the adjudicated discovery submission, and the
  // numerator the confirmed defect it was about. An earlier version of this
  // query joined on the wrong column and could only ever answer zero.
  assert.equal(after.denominator, adjudicatedBefore + 1);
  assert.ok((after.numerator ?? 0) >= 1);
  assert.equal(after.complete, true);
  assert.equal(after.value, (after.numerator ?? 0) / (after.denominator ?? 1));
  assert.equal(after.meetsTarget, (after.value ?? 0) >= 0.7);
});

test('review burden is measured only where a reviewer opened the screen', async () => {
  const campaign = await newCampaign('Burden');
  const operator = await qualifiedOperator('metric-burden');
  const reported = await reportFrom(operator.session, campaign, 'invitation.burden');
  // Opening the review surface is what starts the clock.
  const opened = await noteReviewOpened(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    campaign.campaignId,
    reported.assignment.assignmentId,
  );
  assert.equal(opened.recorded, true);
  // One open per person per assignment: a second look does not stretch the span.
  assert.equal(
    (
      await noteReviewOpened(
        db.pool,
        reviewer,
        workspaceId,
        projectId,
        campaign.campaignId,
        reported.assignment.assignmentId,
      )
    ).recorded,
    false,
  );
  await decideExecution(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    reported.assignment.assignmentId,
    {
      outcome: 'accepted',
      reason: 'Reviewed against the pinned criteria.',
      evidenceRefs: [],
    },
  );
  const burden = await metric('review-burden');
  assert.ok((burden.value ?? -1) >= 0, 'a median exists once one review is timed');
  // Earlier decisions in this suite were recorded without the review screen, so
  // the metric says it is incomplete rather than reporting a partial median.
  assert.equal(burden.complete, false);
  assert.match(burden.missing[0], /without the review screen being opened/);
  assert.match(burden.missing[0], /upper bound/);
});

test('a target with no input reports what is missing instead of a number', async () => {
  const metrics = await transaction(db.pool, (client) => pilotMetrics(client, workspaceId));
  assert.equal(metrics.length, 8);
  const value = metrics.find((entry) => entry.id === 'additional-value');
  // Whether the builder's own checks missed a defect is a judgement nobody
  // records, so the metric has no input rather than a misleading zero.
  assert.equal(value?.value, null);
  assert.equal(value?.complete, false);
  assert.match(value?.missing[0] ?? '', /judgement nobody records/);
  const economics = metrics.find((entry) => entry.id === 'economics');
  assert.equal(economics?.value, null);
  assert.equal(economics?.complete, false);
  // Every missing cost input is named rather than silently treated as zero.
  assert.ok(economics?.missing.length && economics.missing.length >= 4);
  assert.ok(economics?.missing.some((reason) => /compute/.test(reason)));
  assert.ok(economics?.missing.some((reason) => /gas/.test(reason)));
  // What is known is still reported, as parts rather than as a margin.
  assert.equal(economics?.detail?.feeRevenueFinalizedUnits, '0');
  const repeat = metrics.find((entry) => entry.id === 'repeat-purchase');
  assert.equal(repeat?.complete, false);
  assert.match(repeat?.missing[0] ?? '', /no funded payment authority/);
  const timeliness = metrics.find((entry) => entry.id === 'payment-timeliness');
  assert.equal(timeliness?.complete, false);
  assert.match(timeliness?.missing[0] ?? '', /no payout has reached finality/i);
});

test('payment correctness is zero and complete whatever has happened', async () => {
  const correctness = await metric('payment-correctness');
  // Nothing is owed on an empty denominator here: a duplicate payout or an
  // overspent ceiling either exists or does not.
  assert.equal(correctness.complete, true);
  assert.equal(correctness.value, 0);
  assert.equal(correctness.meetsTarget, true);
  assert.equal(correctness.detail?.duplicateFinalizedPayouts, 0);
  assert.equal(correctness.detail?.campaignsOverCeiling, 0);
});

test('readiness reports coverage, and a reviewer read is recorded', async () => {
  const readiness = await pilotReadiness(db.pool, owner, workspaceId);
  assert.equal(readiness.summary.targets, 8);
  assert.ok(readiness.summary.unmeasurable >= 3);
  assert.equal(
    readiness.summary.measurable,
    readiness.summary.targets - readiness.summary.unmeasurable,
  );
  // The stream's own coverage, so a target resting on an event that never
  // fired is visible as such.
  const topics = readiness.coverage.map((entry) => entry.topic);
  for (const expected of [
    'campaign.published',
    'campaign.funding_failed',
    'assignment.claimed',
    'run.started',
    'evidence.submitted',
    'reproduction.outcome',
    'decision.accepted',
    'review.opened',
  ])
    assert.ok(topics.includes(expected), `${expected} was never recorded`);
  const asReviewer = await pilotReadiness(db.pool, reviewer, workspaceId);
  assert.equal(asReviewer.summary.targets, 8);
  const audited = await db.pool.query(
    "SELECT count(*)::int AS n FROM audit_events WHERE action='reviewer.metrics_read'",
  );
  assert.ok(audited.rows[0].n >= 1);
  const operator = await qualifiedOperator('metric-outsider');
  await assert.rejects(pilotReadiness(db.pool, operator.actor, workspaceId), code('ACCESS_DENIED'));
});
