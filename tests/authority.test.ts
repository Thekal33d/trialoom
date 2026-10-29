import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import type { Actor } from '../src/server/access.ts';
import { authenticateAgent } from '../src/server/agents.ts';
import { claim, publishCampaign, setCampaignStatus } from '../src/server/assignments.ts';
import { workspaceAttention } from '../src/server/attention.ts';
import {
  type AuthorityReader,
  registerAuthority,
  replayApproval,
  revokeAuthority,
  stalenessHours,
  topUpAuthority,
  unreadableAuthority,
  verificationIntervalHours,
  verifyAuthority,
  verifyScheduled,
  workspaceAuthorities,
} from '../src/server/authority.ts';
import { decideExecution } from '../src/server/decisions.ts';
import { storeArtifact, submitEvidence } from '../src/server/evidence.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { campaignAccounting } from '../src/server/ledger.ts';
import { migrate } from '../src/server/migrations.ts';
import {
  deliverNotice,
  type NoticeBody,
  type NoticeDelivery,
  type NoticeTransport,
  noticeSignatureMatches,
  registerEndpoint,
  revokeEndpoint,
  webhookTransport,
} from '../src/server/notices.ts';
import { createCredential, registerOperator } from '../src/server/operators.ts';
import { addBuild, createCampaign, createProject } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import { authenticateRun, isolationProfile, startRun } from '../src/server/runner.ts';
import {
  dispatchPayout,
  type SettlementAdapter,
  type SettlementResult,
} from '../src/server/settlement.ts';
import { digestOf } from '../src/server/storage.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let owner: Actor;
let workspaceId: string, projectId: string, buildId: string, evidenceDir: string;
const password = randomBytes(24).toString('base64url');
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
const hashFor = (seed: string) => `0x${digestOf(Buffer.from(seed, 'utf8'))}`;

/**
 * Stands in for a provider with a durable journal: it records every send by
 * operation key and answers later questions about that same key, so a repeated
 * send under one key would be visible as a second entry.
 */
function recordingAdapter(
  options: { onSend?: (key: string) => SettlementResult | undefined; finalizeAfter?: number } = {},
) {
  const sends: string[] = [];
  const confirms: string[] = [];
  const journal = new Map<string, { hash: string; seen: number }>();
  const adapter: SettlementAdapter = {
    name: 'recording',
    async send(request) {
      sends.push(request.operationKey);
      const override = options.onSend?.(request.operationKey);
      if (override) {
        if (override.transactionHash)
          journal.set(request.operationKey, { hash: override.transactionHash, seen: 0 });
        return override;
      }
      const hash = hashFor(request.operationKey);
      journal.set(request.operationKey, { hash, seen: 0 });
      return { status: 'submitted', transactionHash: hash, detail: 'Broadcast to the fixture.' };
    },
    async confirm({ operationKey }) {
      confirms.push(operationKey);
      const entry = journal.get(operationKey);
      if (!entry) return { status: 'unknown', detail: 'No record of this key.' };
      entry.seen += 1;
      if (entry.seen >= (options.finalizeAfter ?? 1))
        return { status: 'finalized', transactionHash: entry.hash, detail: 'Finality verified.' };
      return { status: 'included', transactionHash: entry.hash, detail: 'Included in a block.' };
    },
  };
  return { adapter, sends, confirms, journal };
}

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
type Publication = { ceilingUnits?: string; authorityId?: string; slots?: number };
async function draftCampaign(name: string, overrides: Record<string, unknown> = {}) {
  const assertion = `invitation.${name.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  const campaign = await createCampaign(db.pool, owner, workspaceId, projectId, {
    name,
    terms: termsInput(overrides),
  });
  return { ...campaign, assertion };
}
function publish(campaignId: string, termsVersionId: string, options: Publication = {}) {
  return publishCampaign(db.pool, owner, workspaceId, projectId, campaignId, {
    termsVersionId,
    slots: options.slots ?? 1,
    maxConcurrent: options.slots ?? 1,
    authorizeUnits: options.ceilingUnits ?? '40000000',
    spendingAuthorization: 'remesso-policy-local-fixture',
    ...(options.authorityId ? { authorityId: options.authorityId } : {}),
    authorizationConfirmed: true,
  });
}
async function newCampaign(
  name: string,
  options: Publication = {},
  overrides: Record<string, unknown> = {},
) {
  const campaign = await draftCampaign(name, overrides);
  await publish(campaign.campaignId, campaign.id, options);
  return campaign;
}
async function qualifiedOperator(handle: string, designateWallet = true) {
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
  const address = `0x${randomBytes(20).toString('hex')}`;
  if (designateWallet) await designate(operator.id, address);
  const credential = await createCredential(db.pool, actor, {
    name: 'Runner',
    scopes: ['work:read', 'assignments:read', 'assignments:claim', 'runs:execute', 'payouts:read'],
    expiresInDays: 7,
  });
  return {
    actor,
    operator,
    address,
    session: await authenticateAgent(db.pool, credential.secret),
  };
}
/** Writes a proven, designated payout wallet the way ALPHA-03 records one. */
async function designate(operatorId: string, address: string) {
  const challenge = (
    await db.pool.query<{ id: string }>(
      `INSERT INTO wallet_challenges (operator_id,chain_id,address,nonce,message,expires_at,consumed_at)
      VALUES ($1,42220,$2,$3,'proof',clock_timestamp()+interval '1 hour',clock_timestamp())
      RETURNING id`,
      [operatorId, address, randomBytes(16).toString('hex')],
    )
  ).rows[0];
  await db.pool.query(
    `INSERT INTO operator_wallets (operator_id,chain_id,address,account_type,challenge_id,
    proof_message,signature_hash,payout_designated_at)
    VALUES ($1,42220,$2,'eoa',$3,'proof',$4,clock_timestamp())`,
    [operatorId, address, challenge.id, randomBytes(32).toString('hex')],
  );
}
async function acceptedWork(
  handle: string,
  options: { wallet?: boolean; publication?: Publication } = {},
) {
  const campaign = await newCampaign(`Pay ${handle}`, options.publication);
  const operator = await qualifiedOperator(handle, options.wallet ?? true);
  const assignment = await claim(db.pool, operator.session, { campaignId: campaign.campaignId });
  const run = await startRun(
    db.pool,
    operator.session,
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
  const assertions = Buffer.from(`{"a":"${assignment.assignmentId}"}`);
  await storeArtifact(
    db.pool,
    grant,
    { name: 'assertions.json', kind: 'assertions', sha256: digestOf(assertions) },
    'application/json',
    assertions,
  );
  const now = new Date().toISOString();
  await submitEvidence(db.pool, grant, {
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
    assertions: [{ name: campaign.assertion, passed: false, detail: 'Expected 201, observed 400' }],
    outcome: 'product_failed',
    summary: 'The seeded validator rejects a plus alias on the pinned build.',
    artifacts: [
      { name: 'replay.trace.zip', sha256: digestOf(archive) },
      { name: 'assertions.json', sha256: digestOf(assertions) },
    ],
  });
  const decision = await decideExecution(
    db.pool,
    owner,
    workspaceId,
    projectId,
    assignment.assignmentId,
    {
      outcome: 'accepted',
      reason: 'Every assigned step ran with complete evidence.',
      evidenceRefs: [],
    },
  );
  return { campaign, operator, assignment, decision };
}
const payablesOf = (assignmentId: string) =>
  db.pool.query(`SELECT * FROM payables WHERE assignment_id=$1 ORDER BY kind,created_at`, [
    assignmentId,
  ]);
/**
 * Leases and dispatches one payable's own job. Other checks share this queue,
 * so a round here names the payment it is settling instead of taking whatever
 * the worker would claim next.
 */
async function runPayout(adapter: SettlementAdapter, operationKey: string) {
  const lease = (
    await db.pool.query(
      `UPDATE outbox_jobs SET state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+interval '30 seconds',available_at=clock_timestamp()
      WHERE dedupe_key=$1 AND state IN ('pending','leased')
      RETURNING id,topic,lease_token,attempts,payload`,
      [operationKey],
    )
  ).rows[0];
  if (!lease) return 'no-job';
  return dispatchPayout(db.pool, lease, adapter);
}
async function settle(adapter: SettlementAdapter, operationKey: string, rounds = 4) {
  const outcomes: string[] = [];
  for (let round = 0; round < rounds; round += 1)
    outcomes.push(await runPayout(adapter, operationKey));
  return outcomes;
}

before(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), 'trialoom-authority-'));
  process.env.TRIALOOM_EVIDENCE_DIR = evidenceDir;
  db = await disposableDatabase();
  await migrate(db.pool);
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Authority workspace',
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
      name: 'Authority preview project',
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

const payer = () => `0x${randomBytes(20).toString('hex')}`;
const agent = () => `0x${randomBytes(20).toString('hex')}`;
async function authority(
  reference: string,
  declaredUnits: string,
  options: { payerAddress?: string; policyId?: string } = {},
) {
  return registerAuthority(db.pool, owner, workspaceId, {
    reference,
    provider: 'remesso',
    policyId: options.policyId ?? `${1 + Math.floor(Math.random() * 100000)}`,
    payerAddress: options.payerAddress ?? payer(),
    agentAddress: agent(),
    declaredUnits,
    declarationAcknowledged: true,
  });
}
/** A reader that answers with fixed numbers, standing in for a chain read. */
function reading(
  allowanceUnits: string,
  balanceUnits: string,
  policyActive = true,
): AuthorityReader {
  return {
    name: 'fixture',
    async read() {
      return { allowanceUnits, balanceUnits, policyActive, detail: 'Fixture reading.' };
    },
  };
}
const approvalOf = async (approvalId: string) =>
  (await db.pool.query('SELECT * FROM payment_approvals WHERE id=$1', [approvalId])).rows[0];

test('two briefs cannot both promise one shared approval', async () => {
  const live = await authority('Shared treasury', '10000000');
  const first = await newCampaign('Shared one', {
    authorityId: live.authorityId,
    ceilingUnits: '6000000',
  });
  const second = await draftCampaign('Shared two');
  await assert.rejects(
    publish(second.campaignId, second.id, {
      authorityId: live.authorityId,
      ceilingUnits: '6000000',
    }),
    /has 4000000 left uncommitted/,
  );
  // The refusal leaves the first brief exactly as it was published, and the
  // second one unpublished rather than open against money nothing holds.
  const approval = await approvalOf(live.approval.approvalId);
  assert.equal(approval.committed_units, '6000000');
  assert.equal(
    (await db.pool.query('SELECT status FROM campaigns WHERE id=$1', [second.campaignId])).rows[0]
      .status,
    'draft',
  );
  assert.equal((await campaignAccounting(db.pool, first.campaignId))?.ceilingUnits, '6000000');
  // What fits is still publishable, down to the last base unit.
  await publish(second.campaignId, second.id, {
    authorityId: live.authorityId,
    ceilingUnits: '4000000',
  });
  assert.equal((await approvalOf(live.approval.approvalId)).committed_units, '10000000');
});

test('a second authority on the same wallet describes the approval rather than adding to it', async () => {
  const wallet = payer();
  const first = await authority('Wallet handle one', '5000000', { payerAddress: wallet });
  const second = await authority('Wallet handle two', '5000000', { payerAddress: wallet });
  // Both handles resolve to one approval row, so the second declaration states
  // the same five rather than raising the total to ten.
  assert.equal(second.approval.approvalId, first.approval.approvalId);
  assert.equal(second.approval.declaredUnits, '5000000');
  const campaign = await newCampaign('Wallet one brief', {
    authorityId: first.authorityId,
    ceilingUnits: '5000000',
  });
  assert.ok(campaign.campaignId);
  const other = await draftCampaign('Wallet two brief');
  await assert.rejects(
    publish(other.campaignId, other.id, {
      authorityId: second.authorityId,
      ceilingUnits: '1000000',
    }),
    /left uncommitted across every campaign/,
  );
  // A different wallet is a different approval, with its own room.
  const elsewhere = await authority('Another wallet', '4000000');
  assert.notEqual(elsewhere.approval.approvalId, first.approval.approvalId);
  await publish(other.campaignId, other.id, {
    authorityId: elsewhere.authorityId,
    ceilingUnits: '4000000',
  });
});

test('a declaration rises but is never edited downwards', async () => {
  const live = await authority('Topped up', '2000000');
  await assert.rejects(
    topUpAuthority(db.pool, owner, workspaceId, live.authorityId, {
      declaredUnits: '1000000',
      declarationAcknowledged: true,
    }),
    /cannot be edited downwards/,
  );
  const raised = await topUpAuthority(db.pool, owner, workspaceId, live.authorityId, {
    declaredUnits: '9000000',
    declarationAcknowledged: true,
  });
  assert.equal(raised.declaredUnits, '9000000');
  assert.equal(raised.uncommittedUnits, '9000000');
  // The entries explain the number: one declaration of two, then seven more.
  const entries = (
    await db.pool.query(
      `SELECT amount_units FROM payment_approval_entries
      WHERE approval_id=$1 AND kind='declare' ORDER BY created_at`,
      [live.approval.approvalId],
    )
  ).rows.map((row) => row.amount_units);
  assert.deepEqual(entries, ['2000000', '7000000']);
  assert.deepEqual(await replayApproval(db.pool, live.approval.approvalId), {
    declaredUnits: '9000000',
    committedUnits: '0',
    settledUnits: '0',
  });
});

test('the table refuses a forced overcommitment', async () => {
  const live = await authority('Forced', '1000000');
  await assert.rejects(
    db.pool.query(
      `UPDATE payment_approvals SET committed_units=committed_units+2000000 WHERE id=$1`,
      [live.approval.approvalId],
    ),
    /payment_approval_ceiling/,
  );
});

test('publication must name an authority once one exists, and cannot change it later', async () => {
  const live = await authority('Named', '20000000');
  const campaign = await draftCampaign('Unnamed authority');
  await assert.rejects(
    publish(campaign.campaignId, campaign.id, { ceilingUnits: '4000000' }),
    /name the one this brief draws on/,
  );
  await publish(campaign.campaignId, campaign.id, {
    authorityId: live.authorityId,
    ceilingUnits: '4000000',
  });
  const other = await authority('Second named', '20000000');
  await assert.rejects(
    publish(campaign.campaignId, campaign.id, {
      authorityId: other.authorityId,
      ceilingUnits: '4000000',
    }),
    /fixed at first publication/,
  );
  // Republishing under the authority it is already bound to is unremarkable.
  await publish(campaign.campaignId, campaign.id, {
    authorityId: live.authorityId,
    ceilingUnits: '4000000',
  });
  assert.equal((await approvalOf(live.approval.approvalId)).committed_units, '8000000');
});

test('a finalized payout spends the approval instead of freeing it', async () => {
  const live = await authority('Spending', '40000000');
  const work = await acceptedWork('spend-payout', {
    publication: { authorityId: live.authorityId, ceilingUnits: '40000000' },
  });
  const before = await approvalOf(live.approval.approvalId);
  assert.equal(before.committed_units, '40000000');
  assert.equal(before.settled_units, '0');
  const operatorPayable = (await payablesOf(work.assignment.assignmentId)).rows.find(
    (row) => row.kind === 'operator',
  );
  assert.equal(operatorPayable.authority_id, live.authorityId);
  const { adapter } = recordingAdapter();
  await settle(adapter, operatorPayable.operation_key);
  assert.equal(
    (await payablesOf(work.assignment.assignmentId)).rows.find((row) => row.kind === 'operator')
      .state,
    'finalized',
  );
  const after = await approvalOf(live.approval.approvalId);
  // The money left the approval, so the reservation became spend and the
  // remainder fell with it. Nothing was returned to the next brief.
  assert.equal(after.settled_units, '2000000');
  assert.equal(after.committed_units, '38000000');
  assert.equal(after.declared_units, '38000000');
  assert.deepEqual(await replayApproval(db.pool, live.approval.approvalId), {
    declaredUnits: '38000000',
    committedUnits: '38000000',
    settledUnits: '2000000',
  });
});

test('closing a brief returns its remainder but keeps what is still owed reserved', async () => {
  const live = await authority('Closing', '40000000');
  const work = await acceptedWork('close-remainder', {
    wallet: false,
    publication: { authorityId: live.authorityId, ceilingUnits: '40000000' },
  });
  const owed = (await payablesOf(work.assignment.assignmentId)).rows;
  const total = owed.reduce((sum, row) => sum + BigInt(row.amount_units), 0n);
  const closed = await setCampaignStatus(
    db.pool,
    owner,
    workspaceId,
    projectId,
    work.campaign.campaignId,
    {
      status: 'cancelled',
      reason: 'Closing with an accepted obligation still unpaid.',
    },
  );
  assert.equal(closed.approvalReleasedUnits, (40000000n - total).toString());
  const approval = await approvalOf(live.approval.approvalId);
  assert.equal(approval.committed_units, total.toString());
  // Closing twice releases nothing the second time: the release is derived
  // from the entries, not from the status change that triggered it.
  await assert.rejects(
    setCampaignStatus(db.pool, owner, workspaceId, projectId, work.campaign.campaignId, {
      status: 'cancelled',
      reason: 'Closing again.',
    }),
    /already closed/,
  );
  assert.equal(
    (await approvalOf(live.approval.approvalId)).committed_units,
    approval.committed_units,
  );
});

test('a revoked authority blocks the payout, pauses the brief and keeps the debt', async () => {
  const live = await authority('Revoked', '40000000');
  const work = await acceptedWork('revoked-payout', {
    publication: { authorityId: live.authorityId, ceilingUnits: '40000000' },
  });
  const accounting = await campaignAccounting(db.pool, work.campaign.campaignId);
  const revoked = await revokeAuthority(db.pool, owner, workspaceId, live.authorityId, {
    reason: 'The builder withdrew the approval on chain.',
  });
  assert.equal(revoked.pausedCampaigns, 1);
  const operatorPayable = (await payablesOf(work.assignment.assignmentId)).rows.find(
    (row) => row.kind === 'operator',
  );
  const { adapter, sends } = recordingAdapter();
  await runPayout(adapter, operatorPayable.operation_key);
  const blocked = (await payablesOf(work.assignment.assignmentId)).rows.find(
    (row) => row.kind === 'operator',
  );
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.blocked_reason, 'authority_revoked');
  // Nothing was sent, and the obligation is exactly what was accepted.
  assert.deepEqual(sends, []);
  assert.equal(blocked.amount_units, '2000000');
  const after = await campaignAccounting(db.pool, work.campaign.campaignId);
  assert.equal(after?.acceptedUnits, accounting?.acceptedUnits);
  assert.equal(after?.acceptedUnits, '2200000');
  assert.equal(
    (await db.pool.query('SELECT status FROM campaigns WHERE id=$1', [work.campaign.campaignId]))
      .rows[0].status,
    'paused',
  );
  // A revoked authority funds nothing new.
  const next = await draftCampaign('After revocation');
  await assert.rejects(
    publish(next.campaignId, next.id, {
      authorityId: live.authorityId,
      ceilingUnits: '1000000',
    }),
    /has been revoked/,
  );
});

test('verification records what was read and marks a short approval short', async () => {
  const live = await authority('Verified', '10000000');
  await newCampaign('Verified brief', {
    authorityId: live.authorityId,
    ceilingUnits: '8000000',
  });
  // With no provider configured, verification refuses rather than recording a
  // reading nobody took.
  await assert.rejects(
    verifyAuthority(db.pool, owner, workspaceId, live.authorityId, unreadableAuthority),
    /No payment provider is configured/,
  );
  assert.equal((await approvalOf(live.approval.approvalId)).state, 'declared');
  const covered = await verifyAuthority(
    db.pool,
    owner,
    workspaceId,
    live.authorityId,
    reading('10000000', '10000000'),
  );
  assert.equal(covered.approval.state, 'verified');
  assert.equal(covered.approval.shortfallUnits, '0');
  // A balance below the commitments is a shortfall even when the allowance is
  // intact: an approval nobody can fund pays nothing.
  const short = await verifyAuthority(
    db.pool,
    owner,
    workspaceId,
    live.authorityId,
    reading('10000000', '3000000'),
  );
  assert.equal(short.approval.state, 'short');
  assert.equal(short.approval.shortfallUnits, '5000000');
  // Nothing was cancelled by the bad news.
  assert.equal((await approvalOf(live.approval.approvalId)).committed_units, '8000000');
  const observations = (
    await db.pool.query(
      `SELECT reader,allowance_units,balance_units,committed_at_read FROM payment_approval_observations
      WHERE approval_id=$1 ORDER BY created_at`,
      [live.approval.approvalId],
    )
  ).rows;
  assert.equal(observations.length, 2);
  assert.deepEqual(
    observations.map((row) => row.balance_units),
    ['10000000', '3000000'],
  );
  assert.equal(observations[1].committed_at_read, '8000000');
  // Observations are evidence, so the record cannot be rewritten.
  await assert.rejects(
    db.pool.query(`UPDATE payment_approval_observations SET balance_units=0 WHERE approval_id=$1`, [
      live.approval.approvalId,
    ]),
    /immutable/i,
  );
  // An inactive policy is short whatever the numbers say.
  const inactive = await verifyAuthority(
    db.pool,
    owner,
    workspaceId,
    live.authorityId,
    reading('10000000', '10000000', false),
  );
  assert.equal(inactive.approval.state, 'short');
});

test('the listing names the shared approval and what is left to promise', async () => {
  const wallet = payer();
  const live = await authority('Listed', '5000000', { payerAddress: wallet });
  await newCampaign('Listed brief', { authorityId: live.authorityId, ceilingUnits: '4000000' });
  const listing = await workspaceAuthorities(db.pool, owner, workspaceId);
  const entry = listing.authorities.find((row) => row.id === live.authorityId);
  assert.ok(entry);
  assert.equal(entry.approval.payerAddress, wallet);
  assert.equal(entry.approval.uncommittedUnits, '1000000');
  assert.equal(entry.campaigns, 1);
  assert.match(listing.note, /one shared remainder/);
});

/** Leases this authority's own recurring job and runs one turn of it. */
async function runVerification(authorityId: string, reader: AuthorityReader) {
  const lease = (
    await db.pool.query(
      `UPDATE outbox_jobs SET state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+interval '30 seconds',available_at=clock_timestamp()
      WHERE dedupe_key=$1 AND state IN ('pending','leased')
      RETURNING id,topic,lease_token,attempts,payload`,
      [`authority:${authorityId}`],
    )
  ).rows[0];
  if (!lease) return { outcome: 'no-job', job: null };
  const outcome = await verifyScheduled(db.pool, lease, reader);
  const job = (
    await db.pool.query(
      `SELECT state,attempts,available_at>clock_timestamp() AS deferred,
      EXTRACT(EPOCH FROM available_at-clock_timestamp())::int AS wait
      FROM outbox_jobs WHERE dedupe_key=$1`,
      [`authority:${authorityId}`],
    )
  ).rows[0];
  return { outcome, job };
}
const failingReader = (message: string): AuthorityReader => ({
  name: 'failing',
  async read() {
    throw new Error(message);
  },
});

test('registering an authority starts a recurring read that reschedules itself', async () => {
  const live = await authority('Scheduled', '10000000');
  const queued = (
    await db.pool.query(`SELECT topic,state,payload FROM outbox_jobs WHERE dedupe_key=$1`, [
      `authority:${live.authorityId}`,
    ])
  ).rows[0];
  assert.equal(queued.topic, 'authority.verify');
  assert.equal(queued.state, 'pending');
  assert.equal(queued.payload.authorityId, live.authorityId);

  const first = await runVerification(live.authorityId, reading('10000000', '10000000'));
  assert.equal(first.outcome, 'verified');
  // The reading is the same evidence a person's read would have left, recorded
  // with no actor behind it.
  const observation = (
    await db.pool.query(
      `SELECT reader,allowance_units FROM payment_approval_observations WHERE approval_id=$1`,
      [live.approval.approvalId],
    )
  ).rows;
  assert.equal(observation.length, 1);
  assert.equal(observation[0].allowance_units, '10000000');
  const audited = (
    await db.pool.query(
      `SELECT action,actor_id FROM audit_events WHERE subject_id=$1 AND action LIKE 'payment_authority.%'
      ORDER BY created_at DESC LIMIT 1`,
      [live.authorityId],
    )
  ).rows[0];
  assert.equal(audited.action, 'payment_authority.verified');
  assert.equal(audited.actor_id, null);
  // It put itself back on the queue rather than needing a cron.
  assert.equal(first.job?.state, 'pending');
  assert.equal(first.job?.deferred, true);
  assert.ok(first.job?.wait > 3600 * (verificationIntervalHours - 1));
  const approval = await approvalOf(live.approval.approvalId);
  assert.equal(approval.state, 'verified');
  assert.equal(approval.last_read_error, null);
  assert.ok(approval.last_read_attempted_at);
});

test('a read that failed is recorded as unread, not as a shortfall', async () => {
  const live = await authority('Unreadable', '10000000');
  await newCampaign('Unreadable brief', {
    authorityId: live.authorityId,
    ceilingUnits: '8000000',
  });
  await runVerification(live.authorityId, reading('10000000', '10000000'));
  assert.equal((await approvalOf(live.approval.approvalId)).state, 'verified');

  const failed = await runVerification(live.authorityId, failingReader('forno is unreachable'));
  assert.match(String(failed.outcome), /^unread/);
  const approval = await approvalOf(live.approval.approvalId);
  // The failure is visible, the old reading is untouched, and the approval is
  // emphatically not called short on the strength of an outage.
  assert.match(approval.last_read_error, /forno is unreachable/);
  assert.equal(approval.state, 'verified');
  assert.equal(approval.observed_allowance_units, '10000000');
  assert.equal(
    (
      await db.pool.query(
        'SELECT count(*)::int AS n FROM payment_approval_observations WHERE approval_id=$1',
        [live.approval.approvalId],
      )
    ).rows[0].n,
    1,
  );
  // A recurring read that died after five bad answers would stop checking
  // exactly when checking matters, so a failure is a wait and the retry is
  // sooner than the normal interval.
  assert.equal(failed.job?.state, 'pending');
  assert.equal(failed.job?.attempts, 0);
  assert.ok(failed.job?.wait < 3600 * verificationIntervalHours);
  // A later successful read clears the error.
  await runVerification(live.authorityId, reading('10000000', '10000000'));
  assert.equal((await approvalOf(live.approval.approvalId)).last_read_error, null);
});

test('a policy the chain says is inactive stops new claims and keeps the debt', async () => {
  const live = await authority('Inactive', '40000000');
  const work = await acceptedWork('inactive-policy', {
    publication: { authorityId: live.authorityId, ceilingUnits: '40000000' },
  });
  const accounting = await campaignAccounting(db.pool, work.campaign.campaignId);
  const outcome = await runVerification(live.authorityId, reading('40000000', '40000000', false));
  assert.equal(outcome.outcome, 'inactive:1');
  assert.equal(
    (await db.pool.query('SELECT status FROM campaigns WHERE id=$1', [work.campaign.campaignId]))
      .rows[0].status,
    'paused',
  );
  // Learning it early is the same fact a failed payout would have reported, so
  // it stops new work and erases nothing that was accepted.
  const after = await campaignAccounting(db.pool, work.campaign.campaignId);
  assert.equal(after?.acceptedUnits, accounting?.acceptedUnits);
  assert.equal((await approvalOf(live.approval.approvalId)).state, 'short');
  const audited = (
    await db.pool.query(
      `SELECT action FROM audit_events WHERE subject_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [live.authorityId],
    )
  ).rows[0];
  assert.equal(audited.action, 'payment_authority.inactive');
  // A shortfall on an active policy pauses nothing: it is a number the builder
  // can top up, not a fact about the policy.
  await db.pool.query(`UPDATE campaigns SET status='open' WHERE id=$1`, [work.campaign.campaignId]);
  await runVerification(live.authorityId, reading('40000000', '1000000'));
  assert.equal(
    (await db.pool.query('SELECT status FROM campaigns WHERE id=$1', [work.campaign.campaignId]))
      .rows[0].status,
    'open',
  );
  assert.equal((await approvalOf(live.approval.approvalId)).state, 'short');
});

test('revoking an authority ends its recurring read', async () => {
  const live = await authority('Retired', '5000000');
  await runVerification(live.authorityId, reading('5000000', '5000000'));
  await revokeAuthority(db.pool, owner, workspaceId, live.authorityId, {
    reason: 'Rotating the policy.',
  });
  const stopped = await runVerification(live.authorityId, reading('5000000', '5000000'));
  assert.equal(stopped.outcome, 'revoked');
  assert.equal(stopped.job?.state, 'done');
  // Nothing re-reads it, so no second observation arrives.
  assert.equal(
    (
      await db.pool.query(
        'SELECT count(*)::int AS n FROM payment_approval_observations WHERE approval_id=$1',
        [live.approval.approvalId],
      )
    ).rows[0].n,
    1,
  );
});

test('the queue names an approval nobody has read, one gone stale, and one that is short', async () => {
  const unread = await authority('Never read', '9000000');
  await newCampaign('Never read brief', {
    authorityId: unread.authorityId,
    ceilingUnits: '4000000',
  });
  let queue = await workspaceAttention(db.pool, owner, workspaceId);
  let entry = queue.authorities.find((row) => row.id === unread.authorityId);
  assert.equal(entry?.neverRead, true);
  assert.equal(entry?.readingAgeHours, null);
  assert.equal(entry?.needsAttention, true);
  assert.ok(queue.totals.authoritiesNeverRead >= 1);
  assert.equal(queue.policy.verificationIntervalHours, verificationIntervalHours);

  // A fresh covering reading takes it out of the queue's way.
  await runVerification(unread.authorityId, reading('9000000', '9000000'));
  queue = await workspaceAttention(db.pool, owner, workspaceId);
  entry = queue.authorities.find((row) => row.id === unread.authorityId);
  assert.equal(entry?.neverRead, false);
  assert.equal(entry?.stale, false);
  assert.equal(entry?.needsAttention, false);

  // Age that reading past the staleness threshold and the queue says so,
  // without anything about the approval itself having changed.
  await db.pool.query(
    `UPDATE payment_approvals SET observed_at=clock_timestamp()-make_interval(hours=>$2)
    WHERE id=$1`,
    [unread.approval.approvalId, stalenessHours + 1],
  );
  queue = await workspaceAttention(db.pool, owner, workspaceId);
  entry = queue.authorities.find((row) => row.id === unread.authorityId);
  assert.equal(entry?.stale, true);
  assert.equal(entry?.needsAttention, true);
  assert.ok(queue.totals.authoritiesStale >= 1);
  assert.equal(entry?.shortfallUnits, null);
  assert.equal(queue.policy.stalenessHours, stalenessHours);
  assert.match(queue.policy.staleReadings, /never cancels an obligation/);
});

const noticesFor = async (subjectId: string) =>
  (
    await db.pool.query(`SELECT * FROM notices WHERE subject_id=$1 ORDER BY raised_at,topic`, [
      subjectId,
    ])
  ).rows;
/** Captures what the orchestration hands a transport, without a network. */
function capturingTransport(
  result: NoticeDelivery = { delivered: true, status: 202, detail: 'Accepted.' },
) {
  const sent: { body: NoticeBody; url: string }[] = [];
  const transport: NoticeTransport = {
    name: 'capturing',
    async deliver(body, endpoint) {
      sent.push({ body, url: endpoint.url });
      return result;
    },
  };
  return { transport, sent };
}
async function deliverFor(noticeId: string, transport: NoticeTransport) {
  const lease = (
    await db.pool.query(
      `UPDATE outbox_jobs SET state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+interval '30 seconds',available_at=clock_timestamp()
      WHERE dedupe_key=$1 AND state IN ('pending','leased')
      RETURNING id,topic,lease_token,attempts,payload`,
      [`notice:${noticeId}`],
    )
  ).rows[0];
  if (!lease) return 'no-job';
  return deliverNotice(db.pool, lease, transport);
}
/** Registers a destination without the admission check a real URL goes through. */
async function endpointAt(url: string) {
  const secret = `trn_${randomBytes(32).toString('base64url')}`;
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO notice_endpoints (workspace_id,name,url,signing_secret,registered_by)
    VALUES ($1,'Fixture',$2,$3,$4) RETURNING id`,
    [workspaceId, url, secret, owner.id],
  );
  return { id: rows[0].id, url, signingSecret: secret };
}

test('a shortfall is raised once, resolved when it clears, and raised again if it returns', async () => {
  const live = await authority('Told once', '10000000');
  await newCampaign('Told once brief', { authorityId: live.authorityId, ceilingUnits: '8000000' });
  await runVerification(live.authorityId, reading('10000000', '3000000'));
  let open = (await noticesFor(live.authorityId)).filter((row) => !row.resolved_at);
  assert.equal(open.length, 1);
  assert.equal(open[0].topic, 'authority.short');
  assert.match(open[0].summary, /5000000 base units short/);
  assert.equal(open[0].detail.shortfallUnits, '5000000');
  // Nothing in a notice is a credential, and the table refuses one at any depth.
  assert.ok(!JSON.stringify(open[0].detail).match(/secret|token|grant/i));

  // The read runs every six hours; it must not announce the same shortfall
  // four times a day.
  await runVerification(live.authorityId, reading('10000000', '2000000'));
  assert.equal((await noticesFor(live.authorityId)).length, 1);

  // A covering reading closes it, with silence as the resolution.
  await runVerification(live.authorityId, reading('10000000', '10000000'));
  const closed = await noticesFor(live.authorityId);
  assert.equal(closed.length, 1);
  assert.ok(closed[0].resolved_at);
  assert.match(closed[0].resolved_reason, /covers what is committed/);

  // And if it returns, that is news again.
  await runVerification(live.authorityId, reading('10000000', '1000000'));
  open = (await noticesFor(live.authorityId)).filter((row) => !row.resolved_at);
  assert.equal(open.length, 1);
  assert.equal((await noticesFor(live.authorityId)).length, 2);
});

test('a read nobody could complete is raised separately from a shortfall', async () => {
  const live = await authority('Unread notice', '10000000');
  await runVerification(live.authorityId, failingReader('forno timed out'));
  const open = (await noticesFor(live.authorityId)).filter((row) => !row.resolved_at);
  assert.equal(open.length, 1);
  assert.equal(open[0].topic, 'authority.unreadable');
  assert.match(open[0].summary, /could not be read/);
  assert.match(open[0].detail.reason, /forno timed out/);
  // Repeated failures are the same condition, not a new one each cycle.
  await runVerification(live.authorityId, failingReader('forno timed out'));
  assert.equal((await noticesFor(live.authorityId)).length, 1);
  // A successful read closes it even if the news is bad in another way.
  await runVerification(live.authorityId, reading('10000000', '10000000'));
  assert.ok((await noticesFor(live.authorityId))[0].resolved_at);
});

test('an inactive policy is told, and revoking the authority closes what it raised', async () => {
  const live = await authority('Inactive notice', '40000000');
  const campaign = await newCampaign('Inactive notice brief', {
    authorityId: live.authorityId,
    ceilingUnits: '4000000',
  });
  assert.ok(campaign.campaignId);
  await runVerification(live.authorityId, reading('40000000', '40000000', false));
  const open = (await noticesFor(live.authorityId)).filter((row) => !row.resolved_at);
  assert.equal(open.length, 1);
  assert.equal(open[0].topic, 'authority.inactive');
  assert.match(open[0].summary, /no longer active on chain/);
  assert.match(open[0].summary, /still owed/);
  assert.equal(open[0].detail.pausedCampaigns, 1);
  await revokeAuthority(db.pool, owner, workspaceId, live.authorityId, {
    reason: 'Rotating after the policy was revoked.',
  });
  const after = await noticesFor(live.authorityId);
  assert.ok(after.every((row) => row.resolved_at));
  assert.match(after[0].resolved_reason, /revoked by its owner/);
});

test('with nowhere to be told, a notice records that it reached nobody', async () => {
  const live = await authority('Nowhere', '10000000');
  await newCampaign('Nowhere brief', { authorityId: live.authorityId, ceilingUnits: '8000000' });
  await runVerification(live.authorityId, reading('10000000', '1000000'));
  const notice = (await noticesFor(live.authorityId))[0];
  assert.equal(notice.delivery, 'undeliverable');
  assert.equal(notice.endpoint_id, null);
  assert.match(notice.last_error, /no notice destination/i);
  // No job was queued for it, because there was nothing to try.
  assert.equal(
    (
      await db.pool.query('SELECT count(*)::int AS n FROM outbox_jobs WHERE dedupe_key=$1', [
        `notice:${notice.id}`,
      ])
    ).rows[0].n,
    0,
  );
  const queue = await workspaceAttention(db.pool, owner, workspaceId);
  assert.ok(queue.totals.noticesNowhereToSend >= 1);

  // Registering a destination lets what is already open go out.
  const { transport, sent } = capturingTransport();
  const registered = await registerEndpoint(
    db.pool,
    owner,
    workspaceId,
    { name: 'Ops', url: 'https://notices.example.com/trialoom', acknowledged: true },
    async () => ['93.184.215.14'],
  );
  assert.ok(registered.requeued >= 1);
  assert.match(registered.signingSecret, /^trn_/);
  assert.equal(await deliverFor(notice.id, transport), 'delivered');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.topic, 'authority.short');
  assert.equal(sent[0].url, 'https://notices.example.com/trialoom');
  const delivered = (await noticesFor(live.authorityId))[0];
  assert.equal(delivered.delivery, 'delivered');
  assert.ok(delivered.delivered_at);
  const attempt = (
    await db.pool.query('SELECT * FROM notice_attempts WHERE notice_id=$1', [notice.id])
  ).rows;
  assert.equal(attempt.length, 1);
  assert.equal(attempt[0].delivered, true);
  assert.equal(attempt[0].status, 202);
  // A second live destination would make "was anyone told?" ambiguous.
  await assert.rejects(
    registerEndpoint(
      db.pool,
      owner,
      workspaceId,
      { name: 'Another', url: 'https://second.example.com/hook', acknowledged: true },
      async () => ['93.184.215.14'],
    ),
    /already has a live notice destination/,
  );
  // And a destination pointing into private space is refused outright.
  await assert.rejects(
    registerEndpoint(
      db.pool,
      owner,
      workspaceId,
      { name: 'Internal', url: 'https://hooks.internal/trialoom', acknowledged: true },
      async () => ['10.0.0.9'],
    ),
    /Private or internal|not supported|resolve/i,
  );
  await revokeEndpoint(db.pool, owner, workspaceId, registered.endpointId);
});

test('a destination that refuses leaves the notice undelivered and keeps retrying', async () => {
  const live = await authority('Refused', '10000000');
  await newCampaign('Refused brief', { authorityId: live.authorityId, ceilingUnits: '8000000' });
  const endpoint = await endpointAt('https://refusing.example.com/hook');
  await runVerification(live.authorityId, reading('10000000', '1000000'));
  const notice = (await noticesFor(live.authorityId))[0];
  assert.equal(notice.delivery, 'pending');
  const { transport } = capturingTransport({
    delivered: false,
    status: 500,
    detail: 'The endpoint answered 500.',
  });
  assert.equal(await deliverFor(notice.id, transport), 'undelivered');
  const failed = (await noticesFor(live.authorityId))[0];
  assert.equal(failed.delivery, 'failed');
  assert.equal(failed.attempts, 1);
  assert.match(failed.last_error, /answered 500/);
  // A destination that is down is not a failing handler: the job waits rather
  // than spending the attempts that would retire it.
  const job = (
    await db.pool.query(
      `SELECT state,attempts,available_at>clock_timestamp() AS deferred FROM outbox_jobs
      WHERE dedupe_key=$1`,
      [`notice:${notice.id}`],
    )
  ).rows[0];
  assert.equal(job.state, 'pending');
  assert.equal(job.deferred, true);
  assert.equal(job.attempts, 1);
  const queue = await workspaceAttention(db.pool, owner, workspaceId);
  assert.ok(queue.totals.noticesUndelivered >= 1);

  // A condition that cleared before anyone was told is suppressed: stale news
  // would send the builder looking for a shortfall that no longer exists.
  await runVerification(live.authorityId, reading('10000000', '10000000'));
  assert.equal(await deliverFor(notice.id, transport), 'done');
  const suppressed = (await noticesFor(live.authorityId))[0];
  assert.equal(suppressed.delivery, 'suppressed');
  assert.equal(suppressed.attempts, 1);
  await db.pool.query(`UPDATE notice_endpoints SET revoked_at=clock_timestamp() WHERE id=$1`, [
    endpoint.id,
  ]);
});

test('a delivery is one signed POST that a receiver can verify', async () => {
  const received: {
    body: string;
    signature: string | undefined;
    timestamp: string | undefined;
    topic: string | undefined;
    method: string | undefined;
  }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      received.push({
        body,
        signature: request.headers['x-trialoom-signature'] as string | undefined,
        timestamp: request.headers['x-trialoom-timestamp'] as string | undefined,
        topic: request.headers['x-trialoom-topic'] as string | undefined,
        method: request.method,
      });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  try {
    const secret = `trn_${randomBytes(32).toString('base64url')}`;
    const body: NoticeBody = {
      noticeId: randomUUID(),
      topic: 'authority.short',
      workspaceId,
      subjectId: randomUUID(),
      raisedAt: new Date().toISOString(),
      summary: 'The approval is short of what is committed against it.',
      detail: { policyId: '12', shortfallUnits: '5000000' },
    };
    const result = await webhookTransport.deliver(body, {
      id: randomUUID(),
      url: `http://127.0.0.1:${port}/hook`,
      signingSecret: secret,
    });
    assert.equal(result.delivered, true);
    assert.equal(result.status, 204);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].topic, 'authority.short');
    // The receiver can tell a real notice from anything else that finds the URL.
    assert.ok(received[0].signature && received[0].timestamp);
    assert.ok(
      noticeSignatureMatches(
        secret,
        received[0].timestamp,
        received[0].body,
        received[0].signature,
      ),
    );
    // A captured body replayed under a different timestamp does not verify.
    assert.ok(!noticeSignatureMatches(secret, '0', received[0].body, received[0].signature));
    assert.ok(
      !noticeSignatureMatches(
        'trn_other',
        received[0].timestamp,
        received[0].body,
        received[0].signature,
      ),
    );
    const parsed = JSON.parse(received[0].body);
    assert.equal(parsed.summary, body.summary);
    assert.equal(parsed.detail.shortfallUnits, '5000000');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('the table refuses a notice carrying a credential at any depth', async () => {
  const live = await authority('Guarded', '1000000');
  for (const detail of [
    { token: 'trp_live' },
    { outer: { signature: '0xdeadbeef' } },
    { items: [{ runToken: 'trr_live' }] },
  ])
    await assert.rejects(
      db.pool.query(
        `INSERT INTO notices (workspace_id,topic,subject_id,summary,detail)
        VALUES ($1,'authority.short',$2,'forced',$3)`,
        [workspaceId, live.authorityId, JSON.stringify(detail)],
      ),
      /notices_detail_clean/,
    );
});
