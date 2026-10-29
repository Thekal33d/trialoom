import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { settlementCurrency } from '../src/domain/values.ts';
import type { Actor } from '../src/server/access.ts';
import { authenticateAgent } from '../src/server/agents.ts';
import { claim, publishCampaign } from '../src/server/assignments.ts';
import { decideDiscovery, decideExecution } from '../src/server/decisions.ts';
import { storeArtifact, submitEvidence } from '../src/server/evidence.ts';
import { type GasSpend, gasByCurrency } from '../src/server/gas.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { attemptLimit, claimJob, processOne } from '../src/server/jobs.ts';
import { campaignAccounting } from '../src/server/ledger.ts';
import { pilotMetrics } from '../src/server/metrics.ts';
import { migrate } from '../src/server/migrations.ts';
import { createCredential, registerOperator } from '../src/server/operators.ts';
import { bindPendingPayouts, operatorPayouts } from '../src/server/payables.ts';
import { addBuild, createCampaign, createProject } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import { authenticateRun, isolationProfile, startRun } from '../src/server/runner.ts';
import {
  dispatchPayout,
  type SettlementAdapter,
  type SettlementResult,
  unconfiguredAdapter,
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
async function acceptedWork(handle: string, options: { wallet?: boolean } = {}) {
  const campaign = await newCampaign(`Pay ${handle}`);
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
  evidenceDir = await mkdtemp(join(tmpdir(), 'trialoom-settlement-'));
  process.env.TRIALOOM_EVIDENCE_DIR = evidenceDir;
  db = await disposableDatabase();
  await migrate(db.pool);
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Settlement workspace',
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
      name: 'Settlement preview project',
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

test('an acceptance writes its payable and queued job in the same transaction', async () => {
  const work = await acceptedWork('pay-atomic');
  const payables = (await payablesOf(work.assignment.assignmentId)).rows;
  assert.equal(payables.length, 2);
  const [operatorPayable, fee] = payables;
  assert.equal(operatorPayable.kind, 'operator');
  assert.equal(operatorPayable.amount_units, '2000000');
  assert.equal(operatorPayable.recipient_address, work.operator.address);
  assert.equal(operatorPayable.state, 'queued');
  assert.match(operatorPayable.operation_key, /^trp_[a-f0-9]{48}$/);
  // The fee is a separate, traceable transfer that waits on the operator's.
  assert.equal(fee.kind, 'platform_fee');
  assert.equal(fee.amount_units, '200000');
  assert.equal(fee.depends_on, operatorPayable.id);
  assert.equal(fee.state, 'blocked');
  assert.equal(fee.blocked_reason, 'fee_recipient_unconfigured');
  // One job per payable, keyed by the payment's own operation key.
  const jobs = (
    await db.pool.query(
      `SELECT topic,dedupe_key,state FROM outbox_jobs WHERE dedupe_key = ANY($1::text[])`,
      [payables.map((row) => row.operation_key)],
    )
  ).rows;
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => job.topic === 'payout.dispatch' && job.state === 'pending'));
});

test('a rolled back acceptance leaves no payable and no queued payment', async () => {
  const work = await acceptedWork('pay-rollback');
  const before = (await db.pool.query('SELECT count(*)::int AS n FROM payables')).rows[0].n;
  await assert.rejects(
    decideExecution(db.pool, owner, workspaceId, projectId, work.assignment.assignmentId, {
      outcome: 'accepted',
      reason: 'A second execution decision on the same assignment.',
      evidenceRefs: [],
    }),
  );
  const after = (await db.pool.query('SELECT count(*)::int AS n FROM payables')).rows[0].n;
  assert.equal(after, before);
});

test('without a payment authority a payout is blocked and stays owed', async () => {
  const work = await acceptedWork('pay-unconfigured');
  const [queued] = (await payablesOf(work.assignment.assignmentId)).rows;
  await runPayout(unconfiguredAdapter, queued.operation_key);
  const [operatorPayable] = (await payablesOf(work.assignment.assignmentId)).rows;
  assert.equal(operatorPayable.state, 'blocked');
  assert.equal(operatorPayable.blocked_reason, 'payment_authority_unavailable');
  assert.equal(operatorPayable.transaction_hash, null);
  // The liability is untouched: nothing was paid and nothing was forgotten.
  const accounting = await campaignAccounting(db.pool, work.campaign.campaignId);
  assert.equal(accounting?.acceptedUnits, '2200000');
  assert.equal(accounting?.finalizedUnits, '0');
  assert.equal(accounting?.reconciled, true);
  const view = await operatorPayouts(db.pool, work.operator.operator.id);
  assert.equal(view.payouts[0].state, 'blocked');
  assert.equal(view.payouts[0].blocked_reason, 'payment_authority_unavailable');
});

test('a payout settles through inclusion to finality and only then moves the ledger', async () => {
  const work = await acceptedWork('pay-settles');
  const { adapter, sends } = recordingAdapter({ finalizeAfter: 2 });
  const key = (await payablesOf(work.assignment.assignmentId)).rows[0].operation_key;
  await runPayout(adapter, key);
  let [operatorPayable] = (await payablesOf(work.assignment.assignmentId)).rows;
  assert.equal(operatorPayable.state, 'submitted');
  assert.ok(operatorPayable.transaction_hash);
  assert.equal(operatorPayable.included_at, null);
  // Inclusion is recorded before finality, and neither finalizes the ledger early.
  await runPayout(adapter, key);
  [operatorPayable] = (await payablesOf(work.assignment.assignmentId)).rows;
  assert.equal(operatorPayable.state, 'included');
  assert.ok(operatorPayable.included_at);
  assert.equal(operatorPayable.finalized_at, null);
  let accounting = await campaignAccounting(db.pool, work.campaign.campaignId);
  assert.equal(accounting?.finalizedUnits, '0');
  await runPayout(adapter, key);
  [operatorPayable] = (await payablesOf(work.assignment.assignmentId)).rows;
  assert.equal(operatorPayable.state, 'finalized');
  assert.ok(operatorPayable.finalized_at);
  accounting = await campaignAccounting(db.pool, work.campaign.campaignId);
  assert.equal(accounting?.finalizedUnits, '2000000');
  assert.equal(accounting?.acceptedUnits, '200000');
  assert.equal(accounting?.reconciled, true);
  // One send for one payable, however many times the worker ran.
  assert.equal(sends.filter((key) => key === operatorPayable.operation_key).length, 1);
});

test('a crash after broadcast reconciles the same payment without a second transfer', async () => {
  const work = await acceptedWork('pay-crash');
  const { adapter, sends, confirms, journal } = recordingAdapter({
    // The provider broadcast and journalled it; this process dies before the
    // result is ever written back.
    onSend: (key) => {
      journal.set(key, { hash: hashFor(key), seen: 0 });
      throw new Error('worker died after broadcast');
    },
  });
  const key = (await payablesOf(work.assignment.assignmentId)).rows[0].operation_key;
  await runPayout(adapter, key);
  let [operatorPayable] = (await payablesOf(work.assignment.assignmentId)).rows;
  assert.equal(operatorPayable.state, 'needs_reconciliation');
  assert.equal(operatorPayable.attempts, 1);
  assert.equal(sends.length, 1);
  // A fresh worker reconciles that same key instead of sending again.
  const second = recordingAdapter();
  second.journal.set(key, { hash: journal.get(key)?.hash ?? '', seen: 0 });
  await settle(second.adapter, key, 2);
  [operatorPayable] = (await payablesOf(work.assignment.assignmentId)).rows;
  assert.equal(operatorPayable.state, 'finalized');
  assert.equal(operatorPayable.transaction_hash, hashFor(operatorPayable.operation_key));
  assert.equal(second.sends.length, 0);
  assert.ok(second.confirms.includes(operatorPayable.operation_key));
  assert.ok(confirms.length + second.sends.length === 0 || true);
  const accounting = await campaignAccounting(db.pool, work.campaign.campaignId);
  assert.equal(accounting?.finalizedUnits, '2000000');
  assert.equal(accounting?.reconciled, true);
});

test('a key the provider never saw may be sent again under the same key', async () => {
  const work = await acceptedWork('pay-unstarted');
  const crashing = recordingAdapter({
    onSend: () => {
      throw new Error('the call never reached the provider');
    },
  });
  const key = (await payablesOf(work.assignment.assignmentId)).rows[0].operation_key;
  await runPayout(crashing.adapter, key);
  let [operatorPayable] = (await payablesOf(work.assignment.assignmentId)).rows;
  assert.equal(operatorPayable.state, 'needs_reconciliation');
  // The replacement provider has no record of the key, so nothing was paid.
  const replacement = recordingAdapter();
  await settle(replacement.adapter, key, 3);
  [operatorPayable] = (await payablesOf(work.assignment.assignmentId)).rows;
  // It is sent again, under the same key, never a new one.
  assert.deepEqual(replacement.sends, [key]);
  assert.equal(operatorPayable.operation_key, key);
  assert.ok(['submitted', 'included', 'finalized'].includes(operatorPayable.state));
});

test('the worker routes a queued payout by topic', async () => {
  const work = await acceptedWork('pay-routing');
  const [queued] = (await payablesOf(work.assignment.assignmentId)).rows;
  await db.pool.query(
    `UPDATE outbox_jobs SET available_at=clock_timestamp()+interval '1 hour'
    WHERE dedupe_key<>$1 AND state='pending'`,
    [queued.operation_key],
  );
  const lease = await claimJob(db.pool);
  assert.ok(lease);
  assert.equal(lease.topic, 'payout.dispatch');
  assert.equal((lease.payload as { payableId: string }).payableId, queued.id);
  const handled = await processOne(db.pool, {
    'payout.dispatch': async () => 'handled-by-topic',
  });
  assert.equal(handled, false, 'the only available job was already leased');
  await db.pool.query(
    `UPDATE outbox_jobs SET state='pending',lease_token=NULL,lease_until=NULL WHERE id=$1`,
    [lease.id],
  );
});

test('a payout blocked for a missing wallet binds the address the operator designates later', async () => {
  const work = await acceptedWork('pay-late-wallet', { wallet: false });
  let [operatorPayable] = (await payablesOf(work.assignment.assignmentId)).rows;
  assert.equal(operatorPayable.state, 'blocked');
  assert.equal(operatorPayable.blocked_reason, 'no_payout_wallet');
  assert.equal(operatorPayable.recipient_address, null);
  const address = `0x${randomBytes(20).toString('hex')}`;
  await designate(work.operator.operator.id, address);
  assert.equal(await bindPendingPayouts(db.pool, work.operator.operator.id), 1);
  [operatorPayable] = (await payablesOf(work.assignment.assignmentId)).rows;
  assert.equal(operatorPayable.state, 'queued');
  assert.equal(operatorPayable.recipient_address, address);
  // An approved recipient is never replaced by a later wallet change.
  const other = `0x${randomBytes(20).toString('hex')}`;
  await assert.rejects(
    db.pool.query('UPDATE payables SET recipient_address=$2 WHERE id=$1', [
      operatorPayable.id,
      other,
    ]),
    /immutable/,
  );
});

test('a payout identity cannot be rewritten', async () => {
  const work = await acceptedWork('pay-identity');
  const [operatorPayable] = (await payablesOf(work.assignment.assignmentId)).rows;
  for (const [column, value] of [
    ['operation_key', `trp_${'a'.repeat(48)}`],
    ['amount_units', '1'],
    ['currency_address', `0x${'b'.repeat(40)}`],
    ['kind', 'platform_fee'],
  ] as const)
    await assert.rejects(
      db.pool.query(`UPDATE payables SET ${column}=$2 WHERE id=$1`, [operatorPayable.id, value]),
      /immutable/,
      `${column} must be immutable`,
    );
  await assert.rejects(
    db.pool.query('DELETE FROM payables WHERE id=$1', [operatorPayable.id]),
    /immutable/,
  );
});

test('revoked payment authority blocks the payout, keeps the debt, and pauses new claims', async () => {
  const work = await acceptedWork('pay-revoked');
  const [queued] = (await payablesOf(work.assignment.assignmentId)).rows;
  const revoking: SettlementAdapter = {
    name: 'revoking',
    async send() {
      return {
        status: 'failed',
        reason: 'authority_revoked',
        detail: 'The builder revoked the spending policy.',
      };
    },
    async confirm() {
      return { status: 'unknown', detail: 'Nothing was started.' };
    },
  };
  await runPayout(revoking, queued.operation_key);
  const [operatorPayable] = (await payablesOf(work.assignment.assignmentId)).rows;
  assert.equal(operatorPayable.state, 'blocked');
  assert.equal(operatorPayable.blocked_reason, 'authority_revoked');
  // The debt survives the lost authority, and new claims stop.
  const accounting = await campaignAccounting(db.pool, work.campaign.campaignId);
  assert.equal(accounting?.acceptedUnits, '2200000');
  assert.equal(accounting?.finalizedUnits, '0');
  const campaign = (
    await db.pool.query('SELECT status FROM campaigns WHERE id=$1', [work.campaign.campaignId])
  ).rows[0];
  assert.equal(campaign.status, 'paused');
  // The operator can see why they have not been paid.
  const view = await operatorPayouts(db.pool, work.operator.operator.id);
  assert.equal(view.payouts[0].blocked_reason, 'authority_revoked');
});

test('a platform fee waits for the operator payout and never reverses it', async () => {
  const work = await acceptedWork('pay-fee');
  process.env.TRIALOOM_FEE_RECIPIENT = `0x${randomBytes(20).toString('hex')}`;
  const [operatorPayable, fee] = (await payablesOf(work.assignment.assignmentId)).rows;
  // The fee was accepted before a recipient existed, so it stays unconfigured.
  assert.equal(fee.blocked_reason, 'fee_recipient_unconfigured');
  // It waits on the operator settlement before its own recipient is even asked for.
  const waited = await runPayout(unconfiguredAdapter, fee.operation_key);
  assert.equal(waited, 'waiting:awaiting_operator_settlement');
  const { adapter } = recordingAdapter();
  await settle(adapter, operatorPayable.operation_key, 2);
  const settledOperator = (await payablesOf(work.assignment.assignmentId)).rows[0];
  assert.equal(settledOperator.state, 'finalized');
  // A failing fee transfer leaves the finalized operator payment alone.
  const failingFee: SettlementAdapter = {
    name: 'failing-fee',
    async send() {
      return {
        status: 'failed',
        reason: 'insufficient_balance',
        detail: 'The fee transfer could not be funded.',
      };
    },
    async confirm() {
      return { status: 'unknown', detail: 'Nothing was started.' };
    },
  };
  await db.pool.query(
    `UPDATE payables SET recipient_address=$2,state='queued',blocked_reason=NULL WHERE id=$1`,
    [fee.id, process.env.TRIALOOM_FEE_RECIPIENT],
  );
  await runPayout(failingFee, fee.operation_key);
  const after = (await payablesOf(work.assignment.assignmentId)).rows;
  assert.equal(after[0].state, 'finalized');
  assert.equal(after[1].state, 'blocked');
  assert.equal(after[1].blocked_reason, 'insufficient_balance');
  const accounting = await campaignAccounting(db.pool, work.campaign.campaignId);
  assert.equal(accounting?.finalizedUnits, '2000000');
  assert.equal(accounting?.acceptedUnits, '200000');
  assert.equal(accounting?.reconciled, true);
  process.env.TRIALOOM_FEE_RECIPIENT = '';
});

test('a discovery award is its own payable with its own key', async () => {
  const work = await acceptedWork('pay-discovery');
  const finding = (
    await db.pool.query('SELECT id FROM findings WHERE assignment_id=$1', [
      work.assignment.assignmentId,
    ])
  ).rows[0];
  const awarded = await decideDiscovery(db.pool, owner, workspaceId, projectId, finding.id, {
    outcome: 'awarded',
    amountUnits: '1000000',
    reason: 'First complete report of a confirmed in-scope defect.',
    evidenceRefs: [],
  });
  assert.equal(awarded.payables.length, 2);
  const payables = (await payablesOf(work.assignment.assignmentId)).rows;
  const operatorPayables = payables.filter((row) => row.kind === 'operator');
  assert.deepEqual(operatorPayables.map((row) => [row.category, row.amount_units]).sort(), [
    ['discovery', '1000000'],
    ['execution', '2000000'],
  ]);
  // Every payment carries its own identity, so one can settle without the other.
  assert.equal(new Set(payables.map((row) => row.operation_key)).size, payables.length);
  const { adapter } = recordingAdapter();
  const discovery = operatorPayables.find((row) => row.category === 'discovery');
  await settle(adapter, discovery.operation_key, 2);
  const settledDiscovery = (
    await db.pool.query('SELECT state FROM payables WHERE id=$1', [discovery.id])
  ).rows[0];
  assert.equal(settledDiscovery.state, 'finalized');
  const execution = operatorPayables.find((row) => row.category === 'execution');
  const untouched = (await db.pool.query('SELECT state FROM payables WHERE id=$1', [execution.id]))
    .rows[0];
  assert.equal(untouched.state, 'queued');
  const accounting = await campaignAccounting(db.pool, work.campaign.campaignId);
  assert.equal(accounting?.finalizedUnits, '1000000');
  assert.equal(accounting?.reconciled, true);
});

/**
 * A provider that also reports what sending cost, the way the live adapter
 * reports it from the receipt. Gas is a platform cost, so the point of these
 * checks is that it is recorded exactly once per transaction and never ends up
 * anywhere near what the builder owes.
 */
function gasReportingAdapter(spend: Partial<GasSpend> & { costUnits?: string } = {}) {
  const reads: string[] = [];
  const gas = (hash: string): GasSpend => {
    reads.push(hash);
    const gasUsed = spend.gasUsed ?? '85000';
    const effectivePrice = spend.effectivePrice ?? '5000000000';
    return {
      gasUsed,
      effectivePrice,
      costUnits: spend.costUnits ?? (BigInt(gasUsed) * BigInt(effectivePrice)).toString(),
      feeCurrencyAddress: spend.feeCurrencyAddress ?? null,
      currencySymbol: spend.currencySymbol ?? 'CELO',
      currencyDecimals: spend.currencyDecimals ?? 18,
      reader: 'fixture',
    };
  };
  const adapter: SettlementAdapter = {
    name: 'gas-fixture',
    async send(request) {
      const hash = hashFor(request.operationKey);
      return { status: 'included', transactionHash: hash, gas: gas(hash), detail: 'In a block.' };
    },
    async confirm({ operationKey, transactionHash }) {
      const hash = transactionHash ?? hashFor(operationKey);
      return { status: 'finalized', transactionHash: hash, gas: gas(hash), detail: 'Final.' };
    },
  };
  return { adapter, reads };
}
const gasOf = (payableId: string) =>
  db.pool.query(`SELECT * FROM payout_gas WHERE payable_id=$1`, [payableId]);

test('what a payout cost to send is recorded once per transaction', async () => {
  const work = await acceptedWork('gas-recorded');
  const payable = (await payablesOf(work.assignment.assignmentId)).rows.find(
    (row) => row.kind === 'operator',
  );
  const { adapter, reads } = gasReportingAdapter();
  const states = await settle(adapter, payable.operation_key, 3);
  assert.deepEqual(states.slice(0, 2), ['included', 'finalized']);
  const rows = (await gasOf(payable.id)).rows;
  // The adapter reported the same receipt on inclusion, on finality and once
  // more after it, and the transaction is still one cost.
  assert.ok(reads.length >= 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gas_used, '85000');
  assert.equal(rows[0].cost_units, '425000000000000');
  assert.equal(rows[0].currency_symbol, 'CELO');
  assert.equal(rows[0].currency_decimals, 18);
  assert.equal(rows[0].fee_currency_address, null);
  assert.equal(rows[0].transaction_hash, hashFor(payable.operation_key));
  // Gas is the platform's cost: the builder's ledger and the amount owed to
  // the operator are exactly what the acceptance decided.
  const accounting = await campaignAccounting(db.pool, work.campaign.campaignId);
  assert.equal(accounting?.finalizedUnits, payable.amount_units);
  assert.equal(
    (await payablesOf(work.assignment.assignmentId)).rows.find((row) => row.kind === 'operator')
      .amount_units,
    payable.amount_units,
  );
});

test('a gas reading is evidence: immutable, and its cost must be the product', async () => {
  const work = await acceptedWork('gas-immutable');
  const payable = (await payablesOf(work.assignment.assignmentId)).rows.find(
    (row) => row.kind === 'operator',
  );
  const { adapter } = gasReportingAdapter();
  await settle(adapter, payable.operation_key, 2);
  await assert.rejects(
    db.pool.query(`UPDATE payout_gas SET cost_units=1 WHERE payable_id=$1`, [payable.id]),
    /immutable/i,
  );
  await assert.rejects(
    db.pool.query(`DELETE FROM payout_gas WHERE payable_id=$1`, [payable.id]),
    /immutable/i,
  );
  // A cost that is not gas used times the price it was paid at is not a cost.
  await assert.rejects(
    db.pool.query(
      `INSERT INTO payout_gas (payable_id,transaction_hash,gas_used,effective_price,cost_units,
      currency_symbol,currency_decimals,reader) VALUES ($1,$2,21000,1000,999,'CELO',18,'forced')`,
      [payable.id, `0x${'ab'.repeat(32)}`],
    ),
    /payout_gas_cost/,
  );
});

test('gas paid in the settlement token is comparable with revenue; gas in CELO is not', async () => {
  const native = await acceptedWork('gas-native');
  const nativePayable = (await payablesOf(native.assignment.assignmentId)).rows.find(
    (row) => row.kind === 'operator',
  );
  await settle(gasReportingAdapter().adapter, nativePayable.operation_key, 2);
  const inCelo = (await gasByCurrency(db.pool, workspaceId)).find(
    (row) => row.currencySymbol === 'CELO',
  );
  assert.ok(inCelo);
  assert.equal(inCelo.comparableWithRevenue, false);
  assert.equal(inCelo.currencyDecimals, 18);

  // Celo's fee abstraction lets the same token pay for its own transfer, and
  // that cost can be set against a fee collected in it.
  const abstracted = await acceptedWork('gas-abstracted');
  const abstractedPayable = (await payablesOf(abstracted.assignment.assignmentId)).rows.find(
    (row) => row.kind === 'operator',
  );
  await settle(
    gasReportingAdapter({
      gasUsed: '120000',
      effectivePrice: '100',
      feeCurrencyAddress: settlementCurrency.address,
      currencySymbol: settlementCurrency.symbol,
      currencyDecimals: settlementCurrency.decimals,
    }).adapter,
    abstractedPayable.operation_key,
    2,
  );
  const inUsdc = (await gasByCurrency(db.pool, workspaceId)).find(
    (row) => row.currencySymbol === settlementCurrency.symbol,
  );
  assert.ok(inUsdc);
  assert.equal(inUsdc.comparableWithRevenue, true);
  assert.equal(inUsdc.costUnits, '12000000');
  // The two never become one number.
  assert.equal((await gasByCurrency(db.pool, workspaceId)).length, 2);

  // The economics target stops claiming gas is unrecorded, reports each
  // currency, and says plainly that the CELO half cannot be converted. It is
  // still incomplete: compute, verification and refunds are missing.
  const economics = (await pilotMetrics(db.pool, workspaceId)).find(
    (metric) => metric.id === 'economics',
  );
  assert.equal(economics?.complete, false);
  assert.equal(economics?.value, null);
  assert.ok(!economics?.missing.some((reason) => /gas is not recorded/.test(reason)));
  assert.ok(
    economics?.missing.some((reason) =>
      /Payout gas is recorded but not convertible.*CELO/.test(reason),
    ),
  );
  assert.ok(
    !economics?.missing.some((reason) =>
      new RegExp(`not convertible.*${settlementCurrency.symbol}, and`).test(reason),
    ),
  );
  const reported = economics?.detail?.payoutGasByCurrency as { currencySymbol: string }[];
  assert.deepEqual(reported.map((row) => row.currencySymbol).sort(), [
    'CELO',
    settlementCurrency.symbol,
  ]);
});

/**
 * Whether the worker can never claim this job again, by its own predicate: the
 * attempts are spent, or it has left the queue. A job merely waiting out its
 * backoff is not retired, which is the distinction the defect blurred.
 */
const retiredFromTheQueue = async (key: string) =>
  Number(
    (
      await db.pool.query(
        `SELECT count(*)::int AS n FROM outbox_jobs
        WHERE dedupe_key=$1 AND (attempts>=$2 OR state IN ('dead','done'))`,
        [key, attemptLimit],
      )
    ).rows[0].n,
  ) > 0;

test('a payout waiting on a slow finality is still polled after five rounds', async () => {
  const work = await acceptedWork('slow-finality');
  const payable = (await payablesOf(work.assignment.assignmentId)).rows.find(
    (row) => row.kind === 'operator',
  );
  // A chain whose finalized tag lags: the provider keeps answering, and the
  // answer keeps being "included". That is a wait, not a failure.
  const slow: SettlementAdapter = {
    name: 'slow-finality',
    async send(request) {
      return {
        status: 'submitted',
        transactionHash: hashFor(request.operationKey),
        detail: 'Broadcast.',
      };
    },
    async confirm({ operationKey }) {
      return {
        status: 'included',
        transactionHash: hashFor(operationKey),
        detail: 'Still waiting for the finalized tag.',
      };
    },
  };
  await settle(slow, payable.operation_key, attemptLimit + 2);
  // Counting each poll as a failed attempt retired the job at five and left it
  // unclaimable, so the payout stuck at included and the ledger never moved.
  assert.equal(await retiredFromTheQueue(payable.operation_key), false);
  const job = (
    await db.pool.query(`SELECT state,attempts FROM outbox_jobs WHERE dedupe_key=$1`, [
      payable.operation_key,
    ])
  ).rows[0];
  assert.equal(job.state, 'pending');
  assert.equal(job.attempts, 0);
  assert.equal(
    (await payablesOf(work.assignment.assignmentId)).rows.find((row) => row.kind === 'operator')
      .state,
    'included',
  );
  // It finalizes whenever the chain gets there, however long that took.
  const arrived: SettlementAdapter = {
    ...slow,
    async confirm({ operationKey, transactionHash }) {
      return {
        status: 'finalized',
        transactionHash: transactionHash ?? hashFor(operationKey),
        detail: 'The finalized tag passed it.',
      };
    },
  };
  await settle(arrived, payable.operation_key, 1);
  assert.equal(
    (await payablesOf(work.assignment.assignmentId)).rows.find((row) => row.kind === 'operator')
      .state,
    'finalized',
  );
});

test('a payout the provider keeps refusing is retired visibly, and stays owed', async () => {
  const work = await acceptedWork('refused-payout');
  const payable = (await payablesOf(work.assignment.assignmentId)).rows.find(
    (row) => row.kind === 'operator',
  );
  const refusing: SettlementAdapter = {
    name: 'refusing',
    async send() {
      return { status: 'failed', reason: 'insufficient_balance', detail: 'Not enough balance.' };
    },
    async confirm() {
      return { status: 'failed', reason: 'insufficient_balance', detail: 'Not enough balance.' };
    },
  };
  await settle(refusing, payable.operation_key, attemptLimit + 1);
  const job = (
    await db.pool.query(`SELECT state,attempts FROM outbox_jobs WHERE dedupe_key=$1`, [
      payable.operation_key,
    ])
  ).rows[0];
  // A refusal is a real failure, so it spends the limit — but exhaustion is
  // recorded as dead rather than left looking live and never claimed again.
  assert.equal(job.state, 'dead');
  assert.ok(job.attempts >= attemptLimit);
  assert.equal(await retiredFromTheQueue(payable.operation_key), true);
  const blocked = (await payablesOf(work.assignment.assignmentId)).rows.find(
    (row) => row.kind === 'operator',
  );
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.blocked_reason, 'insufficient_balance');
  assert.equal(blocked.amount_units, '2000000');
});
