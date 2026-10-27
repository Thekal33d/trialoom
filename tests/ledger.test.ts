import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import { AppError } from '../src/domain/errors.ts';
import type { Actor } from '../src/server/access.ts';
import { type AgentSession, authenticateAgent, listEligibleWork } from '../src/server/agents.ts';
import {
  authorizeMore,
  campaignLedger,
  claim,
  claimAssignment,
  heartbeatAssignment,
  publishCampaign,
  releaseAssignment,
  setCampaignStatus,
  sweepExpiredAssignments,
} from '../src/server/assignments.ts';
import { transaction } from '../src/server/database.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import {
  campaignAccounting,
  finalizeAccepted,
  lockAccount,
  maximumLiability,
  outstandingCommitment,
  reclassifyToAccepted,
  replayLedger,
  total,
} from '../src/server/ledger.ts';
import { migrate } from '../src/server/migrations.ts';
import { createCredential, registerOperator } from '../src/server/operators.ts';
import { addBuild, createCampaign, createProject, reviseTerms } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let owner: Actor, member: Actor;
let workspaceId: string, projectId: string, buildId: string;
const password = randomBytes(24).toString('base64url');
const code = (name: string) => (error: unknown) => error instanceof AppError && error.code === name;
const scopes = ['work:read', 'qualification:submit', 'assignments:read', 'assignments:claim'];
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
const publicDns = async () => ['93.184.215.14'];

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
async function newCampaign(name: string, overrides: Record<string, unknown> = {}) {
  const created = await createCampaign(db.pool, owner, workspaceId, projectId, {
    name,
    terms: termsInput(overrides),
  });
  return created;
}
async function publish(
  campaignId: string,
  termsVersionId: string,
  input: Record<string, unknown> = {},
) {
  return publishCampaign(db.pool, owner, workspaceId, projectId, campaignId, {
    termsVersionId,
    slots: 2,
    maxConcurrent: 2,
    authorizeUnits: '20000000',
    spendingAuthorization: 'remesso-policy-local-fixture',
    authorizationConfirmed: true,
    ...input,
  });
}
async function qualifiedOperator(handle: string): Promise<AgentSession> {
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
  return authenticateAgent(db.pool, credential.secret);
}

before(async () => {
  db = await disposableDatabase();
  await migrate(db.pool);
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Ledger workspace',
  });
  workspaceId = bootstrap.workspaceId;
  await acceptInvitation(db.pool, { token: bootstrap.token, name: 'Owner', password }, null);
  owner = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [
      'owner@example.test',
    ])
  ).rows[0];
  const invite = await createInvitation(db.pool, owner, workspaceId, {
    email: 'member@example.test',
    role: 'member',
  });
  await acceptInvitation(db.pool, { token: invite.token, name: 'Member', password }, null);
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
      name: 'Ledger preview project',
      targetUrl: 'https://preview.example.com/',
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
      {
        revision: 'baseline-1',
        fixtureVersion: 'invitation-1',
        targetUrl: 'https://preview.example.com/',
      },
      publicDns,
    )
  ).id;
});
after(async () => {
  await db?.close();
});

test('maximum liability rounds the platform fee up so a reservation is never short', () => {
  const parts = maximumLiability({
    service: 'test',
    deadline: new Date().toISOString(),
    priceUnits: '1',
    discoveryRewardCapUnits: '0',
    resourceAllowanceUnits: '0',
    platformFeeBps: 1,
  });
  // 0.01% of one base unit still reserves a whole unit.
  assert.equal(parts.fee, 1n);
  assert.equal(total(parts), 2n);
  const typical = maximumLiability({
    service: 'bug_discovery',
    deadline: new Date().toISOString(),
    priceUnits: '2000000',
    discoveryRewardCapUnits: '1000000',
    resourceAllowanceUnits: '500000',
    platformFeeBps: 1000,
  });
  assert.deepEqual(typical, {
    execution: 2000000n,
    discovery: 1000000n,
    resource: 500000n,
    fee: 300000n,
  });
  assert.equal(total(typical), 3800000n);
});

test('publication records an exact terms version and refuses an underfunded ceiling', async () => {
  const campaign = await newCampaign('Underfunded brief');
  await assert.rejects(
    publish(campaign.campaignId, campaign.id, { authorizeUnits: '1000000' }),
    code('INSUFFICIENT_BUDGET'),
  );
  // Nothing was published, so nothing is claimable.
  const row = (
    await db.pool.query('SELECT status,published_at FROM campaigns WHERE id=$1', [
      campaign.campaignId,
    ])
  ).rows[0];
  assert.deepEqual([row.status, row.published_at], ['draft', null]);
  const published = await publish(campaign.campaignId, campaign.id);
  assert.equal(published.status, 'open');
  assert.equal(published.termsVersionId, campaign.id);
  assert.equal(published.perAssignmentUnits, '3800000');
  assert.equal(published.ceilingUnits, '20000000');
  // Only a workspace owner can commit the builder to spending.
  await assert.rejects(
    publishCampaign(db.pool, member, workspaceId, projectId, campaign.campaignId, {
      termsVersionId: campaign.id,
      slots: 1,
      maxConcurrent: 1,
      authorizeUnits: '0',
      spendingAuthorization: 'x',
      authorizationConfirmed: true,
    }),
    code('ACCESS_DENIED'),
  );
});

test('a later terms revision does not change the published offer until it is republished', async () => {
  const campaign = await newCampaign('Revised brief');
  await publish(campaign.campaignId, campaign.id);
  const revised = await reviseTerms(
    db.pool,
    owner,
    workspaceId,
    projectId,
    campaign.campaignId,
    termsInput({ expectedVersion: 1, priceUnits: '9000000' }),
  );
  const pinned = (
    await db.pool.query('SELECT published_terms_id,latest_version FROM campaigns WHERE id=$1', [
      campaign.campaignId,
    ])
  ).rows[0];
  assert.equal(pinned.latest_version, 2);
  assert.equal(pinned.published_terms_id, campaign.id);
  // The dearer revision needs its own funding check before it can be offered.
  await assert.rejects(
    publish(campaign.campaignId, revised.id, { authorizeUnits: '0' }),
    code('INSUFFICIENT_BUDGET'),
  );
  const republished = await publish(campaign.campaignId, revised.id, {
    authorizeUnits: '20000000',
    slots: 1,
    maxConcurrent: 1,
  });
  assert.equal(republished.termsVersionId, revised.id);
  assert.equal(republished.termsVersion, 2);
});

test('a claim pins the published terms and build and reserves the maximum liability', async () => {
  const campaign = await newCampaign('Claimable brief');
  await publish(campaign.campaignId, campaign.id);
  const session = await qualifiedOperator('claimer');
  const work = await listEligibleWork(db.pool, session);
  const offer = work.items.find((item) => item.campaign_id === campaign.campaignId);
  assert.equal(offer.terms_version_id, campaign.id);
  assert.equal(offer.slots_used, 0);
  assert.equal(offer.available_units, '20000000');
  const claimed = await claim(db.pool, session, { campaignId: campaign.campaignId });
  assert.equal(claimed.termsVersionId, campaign.id);
  assert.equal(claimed.buildId, buildId);
  assert.equal(claimed.maxLiabilityUnits, '3800000');
  assert.equal(claimed.state, 'claimed');
  assert.ok(claimed.attemptToken);
  const accounting = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(accounting?.committedUnits, '3800000');
  assert.equal(accounting?.availableUnits, '16200000');
  assert.equal(accounting?.reconciled, true);
  // The commitment is itemized, not a single opaque number.
  assert.deepEqual(accounting?.byCategory.map((row) => [row.category, row.committed]).sort(), [
    ['discovery', '1000000'],
    ['execution', '2000000'],
    ['fee', '300000'],
    ['resource', '500000'],
  ]);
  await assert.rejects(
    claim(db.pool, session, { campaignId: campaign.campaignId }),
    code('ALREADY_CLAIMED'),
  );
});

test('concurrent claims for the last slot admit one operator and hold the ceiling', async () => {
  const campaign = await newCampaign('Last slot brief');
  await publish(campaign.campaignId, campaign.id, { slots: 1, maxConcurrent: 1 });
  const racers = await Promise.all([qualifiedOperator('racer-a'), qualifiedOperator('racer-b')]);
  const results = await Promise.allSettled(
    racers.map((session) => claim(db.pool, session, { campaignId: campaign.campaignId })),
  );
  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
  for (const entry of results.filter((item) => item.status === 'rejected'))
    assert.ok(code('NO_SLOTS')((entry as PromiseRejectedResult).reason));
  const accounting = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(accounting?.committedUnits, '3800000');
  assert.ok(BigInt(accounting?.availableUnits ?? '0') >= 0n);
  assert.equal(accounting?.reconciled, true);
});

test('the ceiling is a database invariant, not only an application check', async () => {
  const campaign = await newCampaign('Ceiling brief');
  await publish(campaign.campaignId, campaign.id, { slots: 1, maxConcurrent: 1 });
  await assert.rejects(
    db.pool.query(
      'UPDATE campaign_accounts SET committed_units=ceiling_units+1 WHERE campaign_id=$1',
      [campaign.campaignId],
    ),
    (error: unknown) => (error as { code?: string }).code === '23514',
  );
  await assert.rejects(
    transaction(db.pool, async (client) => {
      await lockAccount(client, campaign.campaignId);
      await client.query(
        `UPDATE campaign_accounts SET accepted_units=ceiling_units,committed_units=1
        WHERE campaign_id=$1`,
        [campaign.campaignId],
      );
    }),
    (error: unknown) => (error as { code?: string }).code === '23514',
  );
});

test('budget exhaustion stops further claims while the campaign stays open', async () => {
  const campaign = await newCampaign('Tight budget brief');
  // Two slots are offered, but only one assignment fits after the exact ceiling.
  await publish(campaign.campaignId, campaign.id, {
    slots: 1,
    maxConcurrent: 1,
    authorizeUnits: '3800000',
  });
  const first = await qualifiedOperator('budget-a');
  await claim(db.pool, first, { campaignId: campaign.campaignId });
  const accounting = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(accounting?.availableUnits, '0');
  const second = await qualifiedOperator('budget-b');
  await assert.rejects(
    claim(db.pool, second, { campaignId: campaign.campaignId }),
    code('NO_SLOTS'),
  );
  await db.pool.query('UPDATE campaigns SET slots=5,max_concurrent=5 WHERE id=$1', [
    campaign.campaignId,
  ]);
  await assert.rejects(
    claim(db.pool, second, { campaignId: campaign.campaignId }),
    code('INSUFFICIENT_BUDGET'),
  );
  await authorizeMore(db.pool, owner, workspaceId, projectId, campaign.campaignId, {
    authorizeUnits: '3800000',
    spendingAuthorization: 'remesso-policy-local-fixture-2',
  });
  const claimed = await claim(db.pool, second, { campaignId: campaign.campaignId });
  assert.equal(claimed.availableUnitsAfter, '0');
});

test('an unqualified or unadmitted operator cannot claim', async () => {
  const campaign = await newCampaign('Gated brief');
  await publish(campaign.campaignId, campaign.id);
  const email = 'ungated@example.test';
  const invitation = await createInvitation(db.pool, owner, workspaceId, {
    email,
    role: 'operator',
  });
  await acceptInvitation(db.pool, { token: invitation.token, name: 'Ungated', password }, null);
  const actor: Actor = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [email])
  ).rows[0];
  await registerOperator(db.pool, actor, { handle: 'ungated' });
  const credential = await createCredential(db.pool, actor, {
    name: 'Runner',
    scopes,
    expiresInDays: 1,
  });
  const session = await authenticateAgent(db.pool, credential.secret);
  await assert.rejects(
    claim(db.pool, session, { campaignId: campaign.campaignId }),
    code('NOT_QUALIFIED'),
  );
  // Removing the workspace membership removes the work perimeter.
  const qualified = await qualifiedOperator('removed-operator');
  await db.pool.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [
    workspaceId,
    qualified.userId,
  ]);
  await assert.rejects(
    claim(db.pool, qualified, { campaignId: campaign.campaignId }),
    code('NOT_ADMITTED'),
  );
});

test('a lease renews within the deadline and an expired attempt is fenced', async () => {
  const campaign = await newCampaign('Lease brief');
  await publish(campaign.campaignId, campaign.id, { slots: 2, maxConcurrent: 2 });
  const session = await qualifiedOperator('leaseholder');
  const claimed = await claim(db.pool, session, { campaignId: campaign.campaignId });
  const beat = await heartbeatAssignment(db.pool, session, claimed.assignmentId, {
    attemptToken: claimed.attemptToken,
  });
  assert.equal(beat.state, 'running');
  assert.ok(new Date(beat.leaseExpiresAt) > new Date(claimed.leaseExpiresAt));
  assert.ok(new Date(beat.leaseExpiresAt) <= new Date(claimed.deadline));
  await assert.rejects(
    heartbeatAssignment(db.pool, session, claimed.assignmentId, {
      attemptToken: '00000000-0000-4000-8000-000000000000',
    }),
    code('STALE_ATTEMPT'),
  );
  // The lease lapses while the runner is still alive.
  await db.pool.query(
    "UPDATE assignments SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [claimed.assignmentId],
  );
  assert.equal(await sweepExpiredAssignments(db.pool), 1);
  const expired = (
    await db.pool.query('SELECT state,closed_reason FROM assignments WHERE id=$1', [
      claimed.assignmentId,
    ])
  ).rows[0];
  assert.equal(expired.state, 'expired');
  assert.match(expired.closed_reason, /lease expired/i);
  for (const call of [
    () =>
      heartbeatAssignment(db.pool, session, claimed.assignmentId, {
        attemptToken: claimed.attemptToken,
      }),
    () =>
      releaseAssignment(db.pool, session, claimed.assignmentId, {
        attemptToken: claimed.attemptToken,
      }),
  ])
    await assert.rejects(call, code('ATTEMPT_CLOSED'));
  // The reservation returned to the campaign, and the slot freed.
  const accounting = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(accounting?.committedUnits, '0');
  assert.equal(accounting?.reconciled, true);
  assert.deepEqual(await outstandingCommitment(db.pool, claimed.assignmentId), {
    execution: 0n,
    discovery: 0n,
    resource: 0n,
    fee: 0n,
  });
  const again = await claim(db.pool, session, { campaignId: campaign.campaignId });
  assert.notEqual(again.attemptToken, claimed.attemptToken);
  assert.notEqual(again.assignmentId, claimed.assignmentId);
});

test('releasing an assignment returns its reservation exactly once', async () => {
  const campaign = await newCampaign('Release brief');
  await publish(campaign.campaignId, campaign.id);
  const session = await qualifiedOperator('releaser');
  const claimed = await claim(db.pool, session, { campaignId: campaign.campaignId });
  const released = await releaseAssignment(db.pool, session, claimed.assignmentId, {
    attemptToken: claimed.attemptToken,
  });
  assert.equal(released.releasedUnits, '3800000');
  const accounting = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(accounting?.committedUnits, '0');
  assert.equal(accounting?.availableUnits, '20000000');
  await assert.rejects(
    releaseAssignment(db.pool, session, claimed.assignmentId, {
      attemptToken: claimed.attemptToken,
    }),
    code('ATTEMPT_CLOSED'),
  );
  assert.equal(accounting?.reconciled, true);
});

test('acceptance reclassifies the same money once and releases the remainder', async () => {
  const campaign = await newCampaign('Acceptance brief');
  await publish(campaign.campaignId, campaign.id);
  const session = await qualifiedOperator('accepted-operator');
  const claimed = await claim(db.pool, session, { campaignId: campaign.campaignId });
  const accepted = await transaction(db.pool, async (client) => {
    await lockAccount(client, campaign.campaignId);
    return reclassifyToAccepted(
      client,
      campaign.campaignId,
      claimed.assignmentId,
      { execution: 2000000n, fee: 200000n },
      'Seeded acceptance for the ledger check',
      owner.id,
    );
  });
  assert.equal(accepted, 2200000n);
  const accounting = await campaignAccounting(db.pool, campaign.campaignId);
  // Committed fell by the whole reservation; accepted rose by the accepted part only.
  assert.equal(accounting?.committedUnits, '0');
  assert.equal(accounting?.acceptedUnits, '2200000');
  assert.equal(accounting?.availableUnits, '17800000');
  assert.equal(accounting?.reconciled, true);
  const replayed = await replayLedger(db.pool, campaign.campaignId);
  assert.deepEqual(replayed, {
    ceiling: 20000000n,
    committed: 0n,
    accepted: 2200000n,
    finalized: 0n,
  });
  // Accepting more than was reserved is refused outright.
  await assert.rejects(
    transaction(db.pool, async (client) => {
      await lockAccount(client, campaign.campaignId);
      return reclassifyToAccepted(
        client,
        campaign.campaignId,
        claimed.assignmentId,
        { execution: 1n },
        'Second acceptance attempt',
        owner.id,
      );
    }),
    code('EXCEEDS_COMMITMENT'),
  );
  // Settlement moves the same amount again without changing the total.
  await transaction(db.pool, (client) =>
    finalizeAccepted(
      client,
      campaign.campaignId,
      claimed.assignmentId,
      2200000n,
      'Seeded settlement for the ledger check',
      owner.id,
    ),
  );
  const settled = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(settled?.acceptedUnits, '0');
  assert.equal(settled?.finalizedUnits, '2200000');
  assert.equal(settled?.availableUnits, '17800000');
  assert.equal(settled?.reconciled, true);
});

test('cancellation stops new claims, drains live work, and preserves obligations', async () => {
  const campaign = await newCampaign('Cancelled brief');
  await publish(campaign.campaignId, campaign.id, { slots: 3, maxConcurrent: 3 });
  const working = await qualifiedOperator('draining-operator');
  const accepted = await qualifiedOperator('owed-operator');
  const live = await claim(db.pool, working, { campaignId: campaign.campaignId });
  const owed = await claim(db.pool, accepted, { campaignId: campaign.campaignId });
  await transaction(db.pool, async (client) => {
    await lockAccount(client, campaign.campaignId);
    await reclassifyToAccepted(
      client,
      campaign.campaignId,
      owed.assignmentId,
      { execution: 2000000n, fee: 200000n },
      'Seeded acceptance before cancellation',
      owner.id,
    );
    await client.query(
      `UPDATE assignments SET state='accepted',accepted_units=2200000,closed_at=clock_timestamp(),
      closed_reason='Accepted in the ledger check' WHERE id=$1`,
      [owed.assignmentId],
    );
  });
  const cancelled = await setCampaignStatus(
    db.pool,
    owner,
    workspaceId,
    projectId,
    campaign.campaignId,
    {
      status: 'cancelled',
      reason: 'Builder stopped the pilot campaign',
    },
  );
  assert.equal(cancelled.drainingAssignments, 1);
  const blocked = await qualifiedOperator('late-operator');
  await assert.rejects(
    claim(db.pool, blocked, { campaignId: campaign.campaignId }),
    code('CAMPAIGN_CLOSED'),
  );
  // The live assignment keeps working under the terms it pinned.
  const beat = await heartbeatAssignment(db.pool, working, live.assignmentId, {
    attemptToken: live.attemptToken,
  });
  assert.equal(beat.state, 'running');
  const accounting = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(accounting?.acceptedUnits, '2200000');
  assert.equal(accounting?.committedUnits, '3800000');
  assert.equal(accounting?.reconciled, true);
  // The accepted obligation survives losing the spending authorization.
  await db.pool.query('UPDATE campaigns SET spending_authorization=$2 WHERE id=$1', [
    campaign.campaignId,
    'revoked-by-builder',
  ]);
  const after = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(after?.acceptedUnits, '2200000');
});

test('pausing stops claims and reopening restores them', async () => {
  const campaign = await newCampaign('Paused brief');
  await publish(campaign.campaignId, campaign.id);
  const session = await qualifiedOperator('paused-operator');
  await setCampaignStatus(db.pool, owner, workspaceId, projectId, campaign.campaignId, {
    status: 'paused',
    reason: 'Builder paused while reviewing funding',
  });
  await assert.rejects(
    claim(db.pool, session, { campaignId: campaign.campaignId }),
    code('CAMPAIGN_CLOSED'),
  );
  assert.equal(
    (await listEligibleWork(db.pool, session)).items.filter(
      (item) => item.campaign_id === campaign.campaignId,
    ).length,
    0,
  );
  await setCampaignStatus(db.pool, owner, workspaceId, projectId, campaign.campaignId, {
    status: 'open',
    reason: 'Funding confirmed',
  });
  const claimed = await claim(db.pool, session, { campaignId: campaign.campaignId });
  assert.equal(claimed.state, 'claimed');
});

test('the builder ledger view reconciles and reviewer reads are audited', async () => {
  const campaign = await newCampaign('Reported brief');
  await publish(campaign.campaignId, campaign.id);
  const session = await qualifiedOperator('reported-operator');
  const claimed = await claim(db.pool, session, { campaignId: campaign.campaignId });
  const view = await campaignLedger(db.pool, owner, workspaceId, projectId, campaign.campaignId);
  assert.equal(view.campaign.status, 'open');
  assert.equal(view.campaign.publishedTermsId, campaign.id);
  assert.equal(view.accounting?.reconciled, true);
  assert.equal(view.accounting?.committedUnits, '3800000');
  assert.equal(view.assignments.length, 1);
  assert.equal(view.assignments[0].id, claimed.assignmentId);
  assert.equal(view.assignments[0].handle, 'reported-operator');
  // The view never hands an operator's attempt token to the builder.
  assert.ok(!JSON.stringify(view).includes(claimed.attemptToken));
  const invite = await createInvitation(db.pool, owner, workspaceId, {
    email: 'ledger-reviewer@example.test',
    role: 'reviewer',
  });
  await acceptInvitation(db.pool, { token: invite.token, name: 'Reviewer', password }, null);
  const reviewer: Actor = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [
      'ledger-reviewer@example.test',
    ])
  ).rows[0];
  await campaignLedger(db.pool, reviewer, workspaceId, projectId, campaign.campaignId);
  const audited = await db.pool.query(
    `SELECT 1 FROM audit_events WHERE workspace_id=$1 AND action='reviewer.ledger_read' AND subject_id=$2`,
    [workspaceId, campaign.campaignId],
  );
  assert.equal(audited.rowCount, 1);
});

test('a claim inside a rolled back transaction leaves no reservation', async () => {
  const campaign = await newCampaign('Rollback brief');
  await publish(campaign.campaignId, campaign.id);
  const session = await qualifiedOperator('rollback-operator');
  await assert.rejects(
    transaction(db.pool, async (client) => {
      await claimAssignment(client, session, { campaignId: campaign.campaignId });
      throw new Error('simulated failure after the claim');
    }),
  );
  const accounting = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(accounting?.committedUnits, '0');
  assert.equal(
    (await db.pool.query('SELECT 1 FROM assignments WHERE campaign_id=$1', [campaign.campaignId]))
      .rowCount,
    0,
  );
  const claimed = await claim(db.pool, session, { campaignId: campaign.campaignId });
  assert.equal(claimed.state, 'claimed');
});
