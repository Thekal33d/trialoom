import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { homepageAction } from '../../src/domain/hosted-tests.ts';
import { authenticateAgent } from '../../src/server/agents.ts';
import { claim, publishCampaign } from '../../src/server/assignments.ts';
import { observeAuthority, registerAuthority } from '../../src/server/authority.ts';
import { paidRunnerHeartbeat } from '../../src/server/hosted-tests.ts';
import { registerHost } from '../../src/server/isolation.ts';
import { enableMarketplace } from '../../src/server/marketplace.ts';
import {
  createCredential,
  issueWalletChallenge,
  proveWallet,
  registerOperator,
} from '../../src/server/operators.ts';
import { addBuild, createCampaign, createProject } from '../../src/server/projects.ts';
import { submitAttempt } from '../../src/server/qualification.ts';
import {
  issueTargetChallenge,
  verifyTargetChallenge,
} from '../../src/server/target-verification.ts';
import { seedFreeAccount } from './free-account.ts';

/** Disposable owned-target fixture. Funding/DNS observations are injected, never live. */
export async function seedPublicMarketplace(pool: Pool, image = `sha256:${'a'.repeat(64)}`) {
  const builder = await seedFreeAccount(pool);
  await pool.query(
    'INSERT INTO settlement_runtime (id,agent_address) VALUES (true,$1) ON CONFLICT(id) DO UPDATE SET heartbeat_at=clock_timestamp()',
    [`0x${'2'.repeat(40)}`],
  );
  await pool.query(
    `INSERT INTO auth_account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ($1,$2,'celo-wallet',$3,clock_timestamp(),clock_timestamp())`,
    [randomUUID(), `0x${'1'.repeat(40)}`, builder.actor.id],
  );
  await enableMarketplace(pool, builder.actor, builder.workspaceId, { acknowledged: true });
  const resolver = async () => ['93.184.216.34'];
  const origin = 'https://preview.example.com';
  const project = await createProject(
    pool,
    builder.actor,
    builder.workspaceId,
    {
      name: 'Owned public job fixture',
      targetUrl: origin,
      environment: 'preview',
      authorizationConfirmed: true,
    },
    resolver,
  );
  const proof = await issueTargetChallenge(pool, builder.actor, builder.workspaceId, project.id);
  await verifyTargetChallenge(
    pool,
    builder.actor,
    builder.workspaceId,
    project.id,
    { challengeId: proof.id },
    { resolver, txt: async () => [[proof.record.value]] },
  );
  const build = await addBuild(
    pool,
    builder.actor,
    builder.workspaceId,
    project.id,
    { revision: 'owned-preview-v1', fixtureVersion: 'owned-preview-v1', targetUrl: origin },
    resolver,
  );
  const authority = await registerAuthority(pool, builder.actor, builder.workspaceId, {
    reference: 'Disposable fixture only',
    provider: 'remesso',
    policyId: '1',
    payerAddress: `0x${'1'.repeat(40)}`,
    agentAddress: `0x${'2'.repeat(40)}`,
    declaredUnits: '1000000000',
    declarationAcknowledged: true,
  });
  await observeAuthority(pool, authority.authorityId, {
    name: 'fixture-only',
    read: async () => ({
      balanceUnits: '1000000000',
      allowanceUnits: '1000000000',
      policyActive: true,
      perPaymentUnits: '1000000000',
      remainingTodayUnits: '1000000000',
      openRecipients: true,
      detail: 'No live funding or payment.',
    }),
  });
  const account = await seedFreeAccount(pool);
  const operator = await registerOperator(pool, account.actor, {
    handle: `hosted-${randomUUID().slice(0, 8)}`,
  });
  await submitAttempt(pool, operator, {
    task: 'journey-step-accuracy',
    report: { defectPresent: true, stepsExecuted: 4, failingStep: 'invitation.create' },
  });
  const signer = privateKeyToAccount(generatePrivateKey());
  const settings = {
    baseURL: 'http://127.0.0.1:3100',
    secret: 'disposable-wallet-proof-fixture'.repeat(3),
  };
  const wallet = await issueWalletChallenge(
    pool,
    account.actor,
    { address: signer.address },
    settings,
  );
  await proveWallet(
    pool,
    account.actor,
    {
      nonce: wallet.nonce,
      signature: await signer.signMessage({ message: wallet.message }),
      designatePayout: true,
    },
    settings,
  );
  const credential = await createCredential(pool, account.actor, {
    name: 'Disposable test agent',
    scopes: ['work:read', 'assignments:read', 'assignments:claim', 'runs:execute'],
    expiresInDays: 1,
  });
  const session = await authenticateAgent(pool, credential.secret);
  const host = await registerHost(pool, builder.actor, builder.workspaceId, {
    name: 'Disposable managed host',
    contractVersion: 'runner-host-v1',
    sandbox: 'gvisor',
    egressEnforced: true,
    ephemeralFilesystem: true,
    isolationLevel: 'witnessed',
    contractAccepted: true,
  });
  await pool.query('UPDATE runner_hosts SET platform_managed=true WHERE id=$1', [host.hostId]);
  await paidRunnerHeartbeat(pool, host.hostId, image);
  async function assignment(actions = [homepageAction]) {
    const job = await createCampaign(pool, builder.actor, builder.workspaceId, project.id, {
      name: 'Read the owned homepage',
      terms: {
        buildId: build.id,
        expectedVersion: 0,
        service: 'test',
        scope: 'Read-only homepage check',
        allowedActions: actions,
        exclusions: ['No signing in or form submission'],
        acceptanceCriteria: 'Complete the agreed homepage check with evidence',
        rewardRubric: 'Execution fee only',
        artifactRights: 'Builder can review the sanitized report',
        deadline: new Date(Date.now() + 86400000).toISOString(),
        reviewWindowHours: 24,
        priceUnits: '1000000',
        discoveryRewardCapUnits: '0',
        resourceAllowanceUnits: '0',
        platformFeeBps: 0,
        paymentTerms:
          'Accepted execution is owed even if the product fails. Spending permission is not escrow.',
        minimumIsolation: 'witnessed',
        scopeApproved: true,
      },
    });
    await publishCampaign(pool, builder.actor, builder.workspaceId, project.id, job.campaignId, {
      termsVersionId: job.id,
      slots: 1,
      maxConcurrent: 1,
      authorizeUnits: '1000000',
      spendingAuthorization: 'fixture-only',
      authorityId: authority.authorityId,
      authorizationConfirmed: true,
      visibility: 'public',
      publicTermsConfirmed: true,
    });
    return claim(pool, session, { campaignId: job.campaignId });
  }
  return {
    builder,
    account,
    operator,
    project,
    build,
    authority,
    session,
    credential,
    host,
    assignment,
    deps: {
      resolver,
      probe: async () => ({ status: 200, location: null, revision: 'owned-preview-v1' }),
    },
  };
}
