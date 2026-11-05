import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { AppError } from '../src/domain/errors.ts';
import { authenticateAgent, listEligibleWork } from '../src/server/agents.ts';
import { claim, publishCampaign } from '../src/server/assignments.ts';
import { observeAuthority, registerAuthority } from '../src/server/authority.ts';
import { transaction } from '../src/server/database.ts';
import { enableMarketplace, requirePublicFunding } from '../src/server/marketplace.ts';
import { migrate } from '../src/server/migrations.ts';
import {
  createCredential,
  issueWalletChallenge,
  proveWallet,
  registerOperator,
} from '../src/server/operators.ts';
import { addBuild, createCampaign, createProject, listProjects } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import { disposableDatabase } from './helpers/database.ts';
import { seedFreeAccount } from './helpers/free-account.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let builder: Awaited<ReturnType<typeof seedFreeAccount>>;
let projectId: string, buildId: string, authorityId: string;
const settings = { baseURL: 'http://127.0.0.1:3100', secret: 'marketplace-test-secret-'.repeat(3) };
const code = (value: string) => (e: unknown) => e instanceof AppError && e.code === value;
const reader = {
  name: 'fixture-only',
  async read() {
    return {
      balanceUnits: '1000000000',
      allowanceUnits: '1000000000',
      policyActive: true,
      detail: 'Disposable test reading; no live money.',
    };
  },
};
before(async () => {
  db = await disposableDatabase();
  await migrate(db.pool);
  builder = await seedFreeAccount(db.pool);
  await enableMarketplace(db.pool, builder.actor, builder.workspaceId, { acknowledged: true });
  const project = await createProject(
    db.pool,
    builder.actor,
    builder.workspaceId,
    {
      name: 'Public fixture',
      targetUrl: 'https://example.com',
      environment: 'preview',
      authorizationConfirmed: true,
    },
    async () => ['93.184.216.34'],
  );
  projectId = project.id;
  buildId = (
    await addBuild(
      db.pool,
      builder.actor,
      builder.workspaceId,
      projectId,
      { revision: 'fixture-v1', fixtureVersion: 'test-v1', targetUrl: 'https://example.com' },
      async () => ['93.184.216.34'],
    )
  ).id;
  authorityId = (
    await registerAuthority(db.pool, builder.actor, builder.workspaceId, {
      reference: 'Test authority',
      provider: 'remesso',
      policyId: '1',
      payerAddress: `0x${'1'.repeat(40)}`,
      agentAddress: `0x${'2'.repeat(40)}`,
      declaredUnits: '1000000000',
      declarationAcknowledged: true,
    })
  ).authorityId;
  await observeAuthority(db.pool, authorityId, reader);
});
after(async () => {
  await db?.close();
});

async function operator(qualify = true, payout = true) {
  const account = await seedFreeAccount(db.pool);
  const op = await registerOperator(db.pool, account.actor, {
    handle: `agent-${randomUUID().slice(0, 8)}`,
  });
  if (qualify)
    await submitAttempt(db.pool, op, {
      task: 'journey-step-accuracy',
      report: { defectPresent: true, stepsExecuted: 4, failingStep: 'invitation.create' },
    });
  if (payout) {
    const signer = privateKeyToAccount(generatePrivateKey());
    const challenge = await issueWalletChallenge(
      db.pool,
      account.actor,
      { address: signer.address },
      settings,
    );
    await proveWallet(
      db.pool,
      account.actor,
      {
        nonce: challenge.nonce,
        signature: await signer.signMessage({ message: challenge.message }),
        designatePayout: true,
      },
      settings,
    );
  }
  const credential = await createCredential(db.pool, account.actor, {
    name: 'Public agent',
    scopes: ['work:read', 'assignments:read', 'assignments:claim'],
    expiresInDays: 1,
  });
  return { ...account, op, session: await authenticateAgent(db.pool, credential.secret) };
}
async function job(visibility: 'public' | 'private' = 'public', overrides = {}) {
  const created = await createCampaign(db.pool, builder.actor, builder.workspaceId, projectId, {
    name: `Job ${randomUUID().slice(0, 6)}`,
    terms: {
      buildId,
      expectedVersion: 0,
      service: 'test',
      scope: 'Load the authorized test page',
      allowedActions: ['Read the homepage'],
      exclusions: ['No form submissions'],
      acceptanceCriteria: 'Complete evidence of the named check',
      rewardRubric: 'No discovery reward',
      artifactRights: 'Builder may inspect the sanitized report',
      deadline: new Date(Date.now() + 86400000).toISOString(),
      reviewWindowHours: 24,
      priceUnits: '1000000',
      discoveryRewardCapUnits: '0',
      resourceAllowanceUnits: '0',
      platformFeeBps: 0,
      paymentTerms: 'Accepted work remains owed; spending permission is not escrow.',
      minimumIsolation: 'witnessed',
      scopeApproved: true,
    },
  });
  const publication = {
    termsVersionId: created.id,
    slots: 1,
    maxConcurrent: 1,
    authorizeUnits: '1000000',
    spendingAuthorization: 'fixture',
    authorityId,
    authorizationConfirmed: true,
    visibility,
    publicTermsConfirmed: true,
    ...overrides,
  };
  return {
    ...created,
    publish: () =>
      publishCampaign(
        db.pool,
        builder.actor,
        builder.workspaceId,
        projectId,
        created.campaignId,
        publication,
      ),
  };
}

test('paid opt-in is owner-scoped, idempotent and preserves the free entitlement', async () => {
  const other = await seedFreeAccount(db.pool);
  await assert.rejects(
    enableMarketplace(db.pool, other.actor, builder.workspaceId, { acknowledged: true }),
    code('ACCESS_DENIED'),
  );
  await enableMarketplace(db.pool, builder.actor, builder.workspaceId, { acknowledged: true });
  assert.equal(
    (
      await db.pool.query('SELECT 1 FROM marketplace_workspaces WHERE workspace_id=$1', [
        builder.workspaceId,
      ])
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await db.pool.query('SELECT 1 FROM free_beta_accounts WHERE workspace_id=$1', [
        builder.workspaceId,
      ])
    ).rowCount,
    1,
  );
});

test('qualified public operator can discover and claim without private workspace access', async () => {
  const agent = await operator();
  const offer = await job();
  await offer.publish();
  assert.ok(
    (await listEligibleWork(db.pool, agent.session)).items.some(
      (x) => x.campaign_id === offer.campaignId,
    ),
  );
  await claim(db.pool, agent.session, { campaignId: offer.campaignId });
  assert.equal(
    (
      await db.pool.query('SELECT 1 FROM memberships WHERE user_id=$1 AND workspace_id=$2', [
        agent.actor.id,
        builder.workspaceId,
      ])
    ).rowCount,
    0,
  );
  await assert.rejects(
    listProjects(db.pool, agent.actor, builder.workspaceId),
    code('ACCESS_DENIED'),
  );
  const held = (
    await db.pool.query(
      'SELECT committed_units::text FROM campaign_accounts WHERE campaign_id=$1',
      [offer.campaignId],
    )
  ).rows[0];
  assert.equal(held.committed_units, '1000000');
});

test('private jobs remain hidden and cannot be claimed by public operators', async () => {
  const agent = await operator();
  const offer = await job('private');
  await offer.publish();
  assert.equal(
    (await listEligibleWork(db.pool, agent.session)).items.some(
      (x) => x.campaign_id === offer.campaignId,
    ),
    false,
  );
  await assert.rejects(
    claim(db.pool, agent.session, { campaignId: offer.campaignId }),
    code('NOT_ADMITTED'),
  );
});

test('public work requires explicit publication, qualification and payout identity', async () => {
  const unconfirmed = await job('public', { publicTermsConfirmed: undefined });
  await assert.rejects(unconfirmed.publish(), code('PUBLIC_TERMS_CONFIRMATION_REQUIRED'));
  const offer = await job();
  await offer.publish();
  const unqualified = await operator(false);
  await assert.rejects(
    claim(db.pool, unqualified.session, { campaignId: offer.campaignId }),
    code('NOT_QUALIFIED'),
  );
  const unpaid = await operator(true, false);
  await assert.rejects(
    claim(db.pool, unpaid.session, { campaignId: offer.campaignId }),
    code('PAYOUT_WALLET_REQUIRED'),
  );
});

test('a fresh funding check is required again at claim time', async () => {
  const agent = await operator();
  const offer = await job();
  await offer.publish();
  await db.pool.query(
    "UPDATE payment_approvals SET observed_at=clock_timestamp()-interval '6 minutes'",
  );
  await assert.rejects(
    claim(db.pool, agent.session, { campaignId: offer.campaignId }),
    code('PUBLIC_FUNDING_REQUIRED'),
  );
  assert.equal(
    (await listEligibleWork(db.pool, agent.session)).items.some(
      (x) => x.campaign_id === offer.campaignId,
    ),
    false,
  );
  await observeAuthority(db.pool, authorityId, reader);
  await transaction(db.pool, (client) => requirePublicFunding(client, authorityId));
});

test('parallel public claims cannot take the same last slot', async () => {
  const a = await operator();
  const b = await operator();
  const offer = await job();
  await offer.publish();
  const results = await Promise.allSettled(
    [a, b].map((x) => claim(db.pool, x.session, { campaignId: offer.campaignId })),
  );
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(
    results.filter((x) => x.status === 'rejected' && code('NO_SLOTS')(x.reason)).length,
    1,
  );
});

test('workspace managers and linked payout wallets cannot take their own public work', async () => {
  const agent = await operator();
  const offer = await job();
  await offer.publish();
  await db.pool.query(
    "INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'reviewer')",
    [builder.workspaceId, agent.actor.id],
  );
  await assert.rejects(
    claim(db.pool, agent.session, { campaignId: offer.campaignId }),
    code('SELF_WORK_NOT_ALLOWED'),
  );
  await db.pool.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [
    builder.workspaceId,
    agent.actor.id,
  ]);
  const wallet = (
    await db.pool.query('SELECT address FROM operator_wallets WHERE operator_id=$1', [agent.op.id])
  ).rows[0];
  await db.pool.query(
    `INSERT INTO auth_account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ($1,$2,'celo-wallet',$3,clock_timestamp(),clock_timestamp())`,
    [randomUUID(), wallet.address.toLowerCase(), builder.actor.id],
  );
  await assert.rejects(
    claim(db.pool, agent.session, { campaignId: offer.campaignId }),
    code('SELF_WORK_NOT_ALLOWED'),
  );
});

test('a valid sibling policy cannot make an inactive authority publicly claimable', async () => {
  const sibling = await registerAuthority(db.pool, builder.actor, builder.workspaceId, {
    reference: 'Inactive policy on shared approval',
    provider: 'remesso',
    policyId: '2',
    payerAddress: `0x${'1'.repeat(40)}`,
    agentAddress: `0x${'2'.repeat(40)}`,
    declaredUnits: '1000000000',
    declarationAcknowledged: true,
  });
  await observeAuthority(db.pool, sibling.authorityId, {
    ...reader,
    async read() {
      return { ...(await reader.read()), policyActive: false };
    },
  });
  await observeAuthority(db.pool, authorityId, reader);
  await transaction(db.pool, (client) => requirePublicFunding(client, authorityId));
  await assert.rejects(
    transaction(db.pool, (client) => requirePublicFunding(client, sibling.authorityId)),
    code('PUBLIC_FUNDING_REQUIRED'),
  );
});
