import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { AppError } from '../src/domain/errors.ts';
import type { Actor } from '../src/server/access.ts';
import { type AgentSession, authenticateAgent } from '../src/server/agents.ts';
import { claim, publishCampaign, releaseAssignment } from '../src/server/assignments.ts';
import { transaction } from '../src/server/database.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { campaignAccounting, outstandingCommitment } from '../src/server/ledger.ts';
import { migrate } from '../src/server/migrations.ts';
import { createCredential, registerOperator } from '../src/server/operators.ts';
import { addBuild, createCampaign, createProject } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import {
  authorizeResourceCeiling,
  purchaseResource,
  type ResourceAdapter,
  type ResourceOutcome,
  type ResourceSettlement,
  reconcilePurchase,
  remainingAllowance,
  unconfiguredResources,
} from '../src/server/resources.ts';
import { startRun } from '../src/server/runner.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let owner: Actor;
let workspaceId: string, projectId: string, buildId: string, evidenceDir: string;
const password = randomBytes(24).toString('base64url');
const code = (name: string) => (error: unknown) => error instanceof AppError && error.code === name;
const target = 'https://preview.example.com/';
const publicDns = async () => ['93.184.215.14'];
const settledProbe = async () => ({ status: 200, location: null, revision: 'baseline-1' });
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
const scopes = [
  'work:read',
  'assignments:read',
  'assignments:claim',
  'runs:execute',
  'resources:purchase',
];
const payee = '0x1111111111111111111111111111111111111111';
const settlementHash = `0x${'ab'.repeat(32)}`;

/**
 * Stands in for buy. It records what it was asked, so a check can assert that
 * nothing was sent when a gate refused, and answers with whatever outcome the
 * case under test needs.
 */
function recordingProvider(options: {
  quotedUnits?: string;
  expiresInSeconds?: number;
  outcome?: ResourceOutcome;
  settlement?: ResourceSettlement;
  failQuote?: boolean;
  throwOnPurchase?: boolean;
}): ResourceAdapter & { sent: number; resolved: number } {
  const adapter = {
    name: 'recording',
    sent: 0,
    resolved: 0,
    async quote() {
      if (options.failQuote)
        return {
          status: 'refused' as const,
          reason: 'provider_refused' as const,
          detail: 'The provider has no capacity.',
        };
      return {
        status: 'quoted' as const,
        amountUnits: options.quotedUnits ?? '3606',
        chainId: 42220,
        tokenAddress: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
        tokenDecimals: 6,
        payee,
        expiresAt: new Date(Date.now() + (options.expiresInSeconds ?? 300) * 1000).toISOString(),
      };
    },
    async purchase() {
      adapter.sent += 1;
      if (options.throwOnPurchase) throw new Error('socket hang up');
      return (
        options.outcome ?? {
          status: 'usable' as const,
          costUnits: options.quotedUnits ?? '3606',
          transactionHash: settlementHash,
          receipt: { session: 'browser-1' },
          detail: 'Session provisioned.',
        }
      );
    },
    async resolve() {
      adapter.resolved += 1;
      return options.settlement ?? { status: 'unknown' as const, detail: 'No receipt yet.' };
    },
  };
  return adapter;
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
  const campaign = await createCampaign(db.pool, owner, workspaceId, projectId, {
    name,
    terms: termsInput(overrides),
  });
  await publishCampaign(db.pool, owner, workspaceId, projectId, campaign.campaignId, {
    termsVersionId: campaign.id,
    slots: 2,
    maxConcurrent: 2,
    authorizeUnits: '40000000',
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
    scopes,
    expiresInDays: 7,
  });
  return { actor, operator, session: await authenticateAgent(db.pool, credential.secret) };
}
/** Claims a slot and opens a run, which is what a purchase hangs off. */
async function runningAssignment(session: AgentSession, campaignId: string) {
  const assignment = await claim(db.pool, session, { campaignId });
  const run = await startRun(
    db.pool,
    session,
    assignment.assignmentId,
    { attemptToken: assignment.attemptToken },
    { resolver: publicDns, probe: settledProbe },
  );
  return { assignment, runId: run.runId };
}
let counter = 0;
function buy(
  session: AgentSession,
  runId: string,
  attemptToken: string,
  adapter: ResourceAdapter,
  overrides: { maxAmountUnits?: string; key?: string } = {},
) {
  counter += 1;
  return purchaseResource(
    db.pool,
    session,
    runId,
    overrides.key ?? `resource-check-${counter}`,
    {
      attemptToken,
      provider: 'buy',
      sku: 'browser.session',
      request: { durationMinutes: 1 },
      maxAmountUnits: overrides.maxAmountUnits ?? '100000',
    },
    adapter,
  );
}
/** Leases this purchase's own reconciliation job, not whatever is next. */
async function reconcile(intentKey: string, adapter: ResourceAdapter) {
  const lease = (
    await db.pool.query(
      `UPDATE outbox_jobs SET state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+interval '30 seconds',available_at=clock_timestamp()
      WHERE dedupe_key=$1 AND state IN ('pending','leased')
      RETURNING id,topic,lease_token,attempts,payload`,
      [intentKey],
    )
  ).rows[0];
  if (!lease) return 'no-job';
  return reconcilePurchase(db.pool, lease, adapter);
}
const purchaseRow = async (id: string) =>
  (await db.pool.query('SELECT * FROM resource_purchases WHERE id=$1', [id])).rows[0];
const platformAccount = async () =>
  (await db.pool.query("SELECT * FROM resource_accounts WHERE id='platform'")).rows[0];
/** The platform resource account is one shared row, so checks compare moves. */
const moved = (
  before: { reserved_units: string; settled_units: string },
  after: { reserved_units: string; settled_units: string },
) => ({
  reserved: BigInt(after.reserved_units) - BigInt(before.reserved_units),
  settled: BigInt(after.settled_units) - BigInt(before.settled_units),
});

before(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), 'trialoom-resources-'));
  process.env.TRIALOOM_EVIDENCE_DIR = evidenceDir;
  db = await disposableDatabase();
  await migrate(db.pool);
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Resources workspace',
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
      name: 'Resources preview project',
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

test('with no funded resource wallet a purchase is refused and nothing is owed', async () => {
  const campaign = await newCampaign('Unfunded');
  const operator = await qualifiedOperator('res-unfunded');
  const live = await runningAssignment(operator.session, campaign.campaignId);
  const account = await platformAccount();
  // The platform's own ceiling is seeded at nothing, so the builder's allowance
  // is irrelevant: Trialoom cannot fund the purchase in the first place.
  assert.equal(account.ceiling_units, '0');
  await assert.rejects(
    buy(operator.session, live.runId, live.assignment.attemptToken, unconfiguredResources),
    code('RESOURCE_CEILING_EXCEEDED'),
  );
  assert.equal(
    (await db.pool.query('SELECT count(*)::int AS n FROM resource_purchases')).rows[0].n,
    0,
  );
  await authorizeResourceCeiling(db.pool, 10_000_000n, 'resource-check-funding');
  // Funded, the default adapter still refuses: no provider is configured.
  await assert.rejects(
    buy(operator.session, live.runId, live.assignment.attemptToken, unconfiguredResources),
    code('RESOURCE_UNAVAILABLE'),
  );
  const after = await platformAccount();
  assert.equal(after.reserved_units, '0');
  assert.equal(after.settled_units, '0');
  assert.equal(after.ceiling_units, '10000000');
});

test('a quote above the authorized limit is refused before anything is signed', async () => {
  const campaign = await newCampaign('Overquoted');
  const operator = await qualifiedOperator('res-overquoted');
  const live = await runningAssignment(operator.session, campaign.campaignId);
  const provider = recordingProvider({ quotedUnits: '90000' });
  await assert.rejects(
    buy(operator.session, live.runId, live.assignment.attemptToken, provider, {
      maxAmountUnits: '50000',
    }),
    code('QUOTE_ABOVE_LIMIT'),
  );
  // The limit is the caller's: the provider was never asked to take payment.
  assert.equal(provider.sent, 0);
  const expiring = recordingProvider({ expiresInSeconds: 5 });
  await assert.rejects(
    buy(operator.session, live.runId, live.assignment.attemptToken, expiring),
    code('QUOTE_EXPIRED'),
  );
  assert.equal(expiring.sent, 0);
});

test('a purchase cannot exceed the assignment resource allowance', async () => {
  const campaign = await newCampaign('Allowance');
  const operator = await qualifiedOperator('res-allowance');
  const live = await runningAssignment(operator.session, campaign.campaignId);
  const remaining = await transaction(db.pool, (client) =>
    remainingAllowance(client, live.assignment.assignmentId),
  );
  assert.equal(remaining, 500_000n);
  await assert.rejects(
    buy(operator.session, live.runId, live.assignment.attemptToken, recordingProvider({}), {
      maxAmountUnits: '600000',
    }),
    code('ALLOWANCE_EXCEEDED'),
  );
  // A purchase whose cost the provider has reported holds only that cost: the
  // rest of the authorized ceiling was never at risk and stays spendable.
  const priced = recordingProvider({
    outcome: { status: 'submitted', costUnits: '3606', detail: 'Provisioning.' },
  });
  await buy(operator.session, live.runId, live.assignment.attemptToken, priced, {
    maxAmountUnits: '400000',
  });
  assert.equal(
    await transaction(db.pool, (client) =>
      remainingAllowance(client, live.assignment.assignmentId),
    ),
    496_394n,
  );
  // A purchase whose charge is still undecided holds the whole ceiling it was
  // authorized under, so two calls cannot each authorize the same allowance.
  const unresolved = recordingProvider({
    outcome: { status: 'uncertain', reason: 'settlement_uncertain', detail: 'Unclear.' },
  });
  await buy(operator.session, live.runId, live.assignment.attemptToken, unresolved, {
    maxAmountUnits: '400000',
  });
  assert.equal(
    await transaction(db.pool, (client) =>
      remainingAllowance(client, live.assignment.assignmentId),
    ),
    96_394n,
  );
  await assert.rejects(
    buy(operator.session, live.runId, live.assignment.attemptToken, unresolved, {
      maxAmountUnits: '200000',
    }),
    code('ALLOWANCE_EXCEEDED'),
  );
});

test('a paid usable resource is reconciled into one itemized reimbursement', async () => {
  const campaign = await newCampaign('Reimbursed');
  const operator = await qualifiedOperator('res-reimbursed');
  const live = await runningAssignment(operator.session, campaign.campaignId);
  const provider = recordingProvider({ quotedUnits: '3606' });
  const opening = await platformAccount();
  const bought = await buy(operator.session, live.runId, live.assignment.attemptToken, provider, {
    maxAmountUnits: '10000',
  });
  assert.equal(bought.purchase.state, 'usable');
  assert.equal(bought.purchase.charge, 'builder');
  assert.equal(bought.purchase.cost_units, '3606');
  assert.equal(bought.replayed, false);
  // The authorized ceiling, not the quote, is what the platform holds.
  assert.deepEqual(moved(opening, await platformAccount()), { reserved: 10_000n, settled: 0n });

  assert.equal(await reconcile(bought.purchase.intent_key, provider), 'reimbursed');
  const row = await purchaseRow(bought.purchase.id);
  assert.equal(row.state, 'reconciled');
  assert.equal(row.charge, 'builder');
  // Only what actually settled is recorded as spent; the rest comes back.
  assert.deepEqual(moved(opening, await platformAccount()), { reserved: 0n, settled: 3606n });

  const payable = (
    await db.pool.query(
      "SELECT * FROM payables WHERE resource_purchase_id=$1 AND kind='resource'",
      [bought.purchase.id],
    )
  ).rows[0];
  assert.equal(payable.amount_units, '3606');
  assert.equal(payable.category, 'resource');
  assert.equal(payable.decision_id, null);
  // No platform resource wallet is configured, so the reimbursement is owed.
  assert.equal(payable.state, 'blocked');
  assert.equal(payable.blocked_reason, 'resource_recipient_unconfigured');

  const accounting = await campaignAccounting(db.pool, campaign.campaignId);
  const resource = accounting?.byCategory.find((row) => row.category === 'resource');
  assert.equal(resource?.accepted, '3606');
  assert.equal(accounting?.reconciled, true);
  // The eligible cost left the reservation and became a liability; it was not
  // counted in both places.
  const held = await transaction(db.pool, (client) =>
    outstandingCommitment(client, live.assignment.assignmentId),
  );
  assert.equal(held.resource, 496_394n);
});

test('a reconciled cost cannot be reimbursed a second time', async () => {
  const campaign = await newCampaign('Oncereimbursed');
  const operator = await qualifiedOperator('res-once');
  const live = await runningAssignment(operator.session, campaign.campaignId);
  const provider = recordingProvider({ quotedUnits: '5000' });
  const bought = await buy(operator.session, live.runId, live.assignment.attemptToken, provider, {
    maxAmountUnits: '5000',
  });
  assert.equal(await reconcile(bought.purchase.intent_key, provider), 'reimbursed');
  // Replaying the job cannot write a second reimbursement: the purchase is
  // already reconciled and the database allows one payable per purchase.
  assert.equal(await reconcile(bought.purchase.intent_key, provider), 'no-job');
  const payables = await db.pool.query(
    'SELECT count(*)::int AS n FROM payables WHERE resource_purchase_id=$1',
    [bought.purchase.id],
  );
  assert.equal(payables.rows[0].n, 1);
  await assert.rejects(
    db.pool.query(
      `INSERT INTO payables (campaign_id,assignment_id,operator_id,kind,category,amount_units,
      currency_chain_id,currency_address,currency_decimals,operation_key,resource_purchase_id,state)
      VALUES ($1,$2,$3,'resource','resource',1,42220,'0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
      6,$4,$5,'queued')`,
      [
        campaign.campaignId,
        live.assignment.assignmentId,
        operator.operator.id,
        `trp_${randomBytes(24).toString('hex')}`,
        bought.purchase.id,
      ],
    ),
    /duplicate key|unique/i,
    'the database, not the code, forbids a second reimbursement',
  );
});

test('a purchase the platform could not deliver is absorbed, not charged', async () => {
  const campaign = await newCampaign('Absorbed');
  const operator = await qualifiedOperator('res-absorbed');
  const live = await runningAssignment(operator.session, campaign.campaignId);
  const provider = recordingProvider({
    quotedUnits: '8000',
    outcome: { status: 'provision_failed', detail: 'The session could not be started.' },
    settlement: { status: 'settled', costUnits: '8000', detail: 'The transfer settled.' },
  });
  const opening = await platformAccount();
  const bought = await buy(operator.session, live.runId, live.assignment.attemptToken, provider, {
    maxAmountUnits: '8000',
  });
  assert.equal(bought.purchase.state, 'failed');
  assert.equal(bought.purchase.charge, 'platform_absorbed');
  assert.equal(await reconcile(bought.purchase.intent_key, provider), 'absorbed');
  // The money really left the platform wallet, and the builder owes none of it:
  // a purchase that produced nothing is not completed testing to charge for.
  assert.deepEqual(moved(opening, await platformAccount()), { reserved: 0n, settled: 8000n });
  assert.equal(
    (
      await db.pool.query('SELECT count(*)::int AS n FROM payables WHERE resource_purchase_id=$1', [
        bought.purchase.id,
      ])
    ).rows[0].n,
    0,
  );
  const accounting = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(accounting?.byCategory.find((row) => row.category === 'resource')?.accepted, '0');
});

test('an uncertain purchase keeps its commitment until it is reconciled', async () => {
  const campaign = await newCampaign('Uncertainty');
  const operator = await qualifiedOperator('res-uncertain');
  const live = await runningAssignment(operator.session, campaign.campaignId);
  const lost = recordingProvider({ quotedUnits: '9000', throwOnPurchase: true });
  const bought = await buy(operator.session, live.runId, live.assignment.attemptToken, lost, {
    maxAmountUnits: '9000',
  });
  assert.equal(bought.purchase.state, 'uncertain');
  assert.equal(bought.purchase.reason, 'response_lost');
  assert.equal(bought.purchase.charge, 'pending');

  // An unresolved answer is asked again, never bought again.
  assert.equal(await reconcile(bought.purchase.intent_key, lost), 'unresolved');
  assert.equal(lost.sent, 1);
  assert.equal(lost.resolved, 1);

  // R07: releasing the assignment cannot give the reservation back while the
  // settlement might still land on the builder.
  await releaseAssignment(db.pool, operator.session, live.assignment.assignmentId, {
    attemptToken: live.assignment.attemptToken,
  });
  const retained = await transaction(db.pool, (client) =>
    outstandingCommitment(client, live.assignment.assignmentId),
  );
  assert.equal(retained.resource, 9_000n);
  assert.equal(retained.execution, 0n);

  const resolved = recordingProvider({
    settlement: { status: 'settled', costUnits: '7600', detail: 'The transfer settled.' },
  });
  assert.equal(await reconcile(bought.purchase.intent_key, resolved), 'reimbursed');
  const row = await purchaseRow(bought.purchase.id);
  assert.equal(row.state, 'reconciled');
  assert.equal(row.cost_units, '7600');
  // Only now does the rest of the reservation go back.
  const freed = await transaction(db.pool, (client) =>
    outstandingCommitment(client, live.assignment.assignmentId),
  );
  assert.equal(freed.resource, 0n);
  const accounting = await campaignAccounting(db.pool, campaign.campaignId);
  assert.equal(accounting?.reconciled, true);
  assert.equal(
    accounting?.byCategory.find((entry) => entry.category === 'resource')?.accepted,
    '7600',
  );
});

test('an authorization that never settled charges and spends nothing', async () => {
  const campaign = await newCampaign('Unsettled');
  const operator = await qualifiedOperator('res-unsettled');
  const live = await runningAssignment(operator.session, campaign.campaignId);
  const opening = await platformAccount();
  const lost = recordingProvider({
    quotedUnits: '4000',
    outcome: { status: 'uncertain', reason: 'settlement_uncertain', detail: 'Settlement unclear.' },
    settlement: { status: 'unsettled', detail: 'The token recorded no transfer.' },
  });
  const bought = await buy(operator.session, live.runId, live.assignment.attemptToken, lost, {
    maxAmountUnits: '4000',
  });
  assert.equal(await reconcile(bought.purchase.intent_key, lost), 'unsettled');
  const row = await purchaseRow(bought.purchase.id);
  assert.equal(row.state, 'refused');
  assert.equal(row.charge, 'none');
  // Nothing was paid, so neither the reserve nor the spend moved at all.
  assert.deepEqual(moved(opening, await platformAccount()), { reserved: 0n, settled: 0n });
});

test('a settled cost above the authorized limit is held, not charged', async () => {
  const campaign = await newCampaign('Overlimit');
  const operator = await qualifiedOperator('res-overlimit');
  const live = await runningAssignment(operator.session, campaign.campaignId);
  const provider = recordingProvider({
    quotedUnits: '6000',
    outcome: { status: 'uncertain', reason: 'settlement_uncertain', detail: 'Settlement unclear.' },
    settlement: { status: 'settled', costUnits: '6001', detail: 'The transfer settled high.' },
  });
  const bought = await buy(operator.session, live.runId, live.assignment.attemptToken, provider, {
    maxAmountUnits: '6000',
  });
  assert.equal(await reconcile(bought.purchase.intent_key, provider), 'over_limit');
  const row = await purchaseRow(bought.purchase.id);
  // Recording less than was taken would hide it, so nothing is recorded and
  // nobody is charged: the reservation stays for a person to resolve.
  assert.equal(row.state, 'uncertain');
  assert.equal(row.charge, 'pending');
  assert.equal(row.cost_units, null);
  assert.equal(
    (
      await db.pool.query('SELECT count(*)::int AS n FROM payables WHERE resource_purchase_id=$1', [
        bought.purchase.id,
      ])
    ).rows[0].n,
    0,
  );
});

test('a retried purchase returns the one it already started', async () => {
  const campaign = await newCampaign('Retried');
  const operator = await qualifiedOperator('res-retried');
  const live = await runningAssignment(operator.session, campaign.campaignId);
  const provider = recordingProvider({ quotedUnits: '2500' });
  const key = 'resource-retry-key-1';
  const first = await buy(operator.session, live.runId, live.assignment.attemptToken, provider, {
    maxAmountUnits: '2500',
    key,
  });
  const again = await buy(operator.session, live.runId, live.assignment.attemptToken, provider, {
    maxAmountUnits: '2500',
    key,
  });
  assert.equal(again.replayed, true);
  assert.equal(again.purchase.id, first.purchase.id);
  // One authorization, one payment: the retry never reached the provider.
  assert.equal(provider.sent, 1);
  assert.equal(
    (
      await db.pool.query(
        'SELECT count(*)::int AS n FROM resource_purchases WHERE assignment_id=$1',
        [live.assignment.assignmentId],
      )
    ).rows[0].n,
    1,
  );
});

test('a purchase needs its own scope and a live attempt', async () => {
  const campaign = await newCampaign('Scoped');
  const email = 'res-scoped@example.test';
  const invitation = await createInvitation(db.pool, owner, workspaceId, {
    email,
    role: 'operator',
  });
  await acceptInvitation(db.pool, { token: invitation.token, name: 'res-scoped', password }, null);
  const actor: Actor = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [email])
  ).rows[0];
  const operator = await registerOperator(db.pool, actor, { handle: 'res-scoped' });
  for (const [task, report] of Object.entries(correct))
    await submitAttempt(db.pool, operator, { task, report });
  // Everything an operator needs to run, and nothing that can spend.
  const credential = await createCredential(db.pool, actor, {
    name: 'Runner',
    scopes: ['work:read', 'assignments:read', 'assignments:claim', 'runs:execute'],
    expiresInDays: 7,
  });
  const session = await authenticateAgent(db.pool, credential.secret);
  const live = await runningAssignment(session, campaign.campaignId);
  await assert.rejects(
    buy(session, live.runId, live.assignment.attemptToken, recordingProvider({})),
    code('SCOPE_REQUIRED'),
  );
  const spender = await qualifiedOperator('res-spender');
  await assert.rejects(
    buy(spender.session, live.runId, live.assignment.attemptToken, recordingProvider({})),
    code('NOT_FOUND'),
    'another operator cannot buy against this run',
  );
  // A retired attempt cannot spend, however valid the credential is.
  const own = await runningAssignment(spender.session, campaign.campaignId);
  await assert.rejects(
    buy(spender.session, own.runId, crypto.randomUUID(), recordingProvider({})),
    code('STALE_ATTEMPT'),
  );
});
