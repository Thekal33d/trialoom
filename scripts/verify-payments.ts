/**
 * The funded payment authority, exercised against a real Remesso policy on an
 * owned Celo fork. Everything here is the product's own code path: a real
 * decision writes a real payable, the worker dispatches it through the live
 * adapter, the USDC moves under Trialoom's operation key, and the shared
 * approval accounting follows the money.
 *
 * It is not mainnet evidence. All transactions go to a disposable loopback
 * Anvil fork, started and stopped by this script, and the signing keys are the
 * public Anvil fixture accounts. What it does establish is that the adapter,
 * the Postgres journal bridge and the approval reader work against deployed
 * contract code rather than against a fixture that answers as we expect.
 *
 *   npm run payments:fork
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deployment } from 'remesso-sdk';
import { assertLocalAnvil, startDev } from 'remesso-sdk/dev';
import { createPublicClient, createWalletClient, erc20Abi, http, parseAbi, toHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { exactUnits } from '../src/domain/values.ts';
import { authenticateAgent } from '../src/server/agents.ts';
import { claim, publishCampaign } from '../src/server/assignments.ts';
import {
  registerAuthority,
  revokeAuthority,
  verifyAuthority,
  verifyScheduled,
  workspaceAuthorities,
} from '../src/server/authority.ts';
import { decideExecution } from '../src/server/decisions.ts';
import { storeArtifact, submitEvidence } from '../src/server/evidence.ts';
import { gasByCurrency } from '../src/server/gas.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { processOne } from '../src/server/jobs.ts';
import { pilotMetrics } from '../src/server/metrics.ts';
import { migrate } from '../src/server/migrations.ts';
import {
  createCredential,
  issueWalletChallenge,
  proveWallet,
  registerOperator,
} from '../src/server/operators.ts';
import { addBuild, createCampaign, createProject } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import { remessoAdapter, remessoReader } from '../src/server/remesso.ts';
import { authenticateRun, isolationProfile, startRun } from '../src/server/runner.ts';
import { dispatchPayout } from '../src/server/settlement.ts';
import { digestOf } from '../src/server/storage.ts';
import { disposableDatabase } from '../tests/helpers/database.ts';

// A configured key in the environment would be a real one. This script signs
// only with the public Anvil fixture accounts, so it refuses to inherit any.
if (process.env.TRIALOOM_REMESSO_AGENT_KEY)
  throw new Error('Unset TRIALOOM_REMESSO_AGENT_KEY before running the fork check.');

const checks: string[] = [];
function check(name: string, condition: boolean) {
  assert.ok(condition, name);
  checks.push(name);
  console.log(`PASS ${name}`);
}

const settlementToken = deployment.tokens.find((token) => token.symbol === 'USDC');
if (!settlementToken) throw new Error('The pinned deployment manifest has no USDC entry.');
const usdc = settlementToken;
// PUBLIC Anvil fixture mnemonic. Never usable on a real network.
const fixtureMnemonic = 'test test test test test test test test test test test junk';
const keyAt = (index: number) => {
  const key = mnemonicToAccount(fixtureMnemonic, { addressIndex: index }).getHdKey().privateKey;
  if (!key) throw new Error('The fixture account has no private key.');
  return `0x${Buffer.from(key).toString('hex')}`;
};

const target = 'https://preview.example.com/';
const publicDns = async () => ['93.184.215.14'];
const settledProbe = async () => ({ status: 200, location: null, revision: 'baseline-1' });
const password = randomBytes(24).toString('base64url');
const evidenceDir = resolve(
  'artifacts/payments-fork',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
const qualifications: Record<string, Record<string, unknown>> = {
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

/** Mints USDC inside the owned fork by impersonating its discovered minter. */
async function seedUsdc(rpcUrl: string, recipient: string, amount: bigint) {
  await assertLocalAnvil(rpcUrl);
  const client = createPublicClient({ chain: celo, transport: http(rpcUrl) });
  const abi = parseAbi([
    'function masterMinter() view returns (address)',
    'function configureMinter(address minter, uint256 allowance) returns (bool)',
    'function mint(address to, uint256 amount) returns (bool)',
    'function removeMinter(address minter) returns (bool)',
  ]);
  const master = (await client.readContract({
    address: usdc.address,
    abi,
    functionName: 'masterMinter',
  })) as `0x${string}`;
  await client.request({
    method: 'anvil_setBalance',
    params: [master, toHex(10n ** 18n)],
  } as never);
  await client.request({ method: 'anvil_impersonateAccount', params: [master] } as never);
  try {
    const wallet = createWalletClient({ account: master, chain: celo, transport: http(rpcUrl) });
    for (const [functionName, args] of [
      ['configureMinter', [master, amount]],
      ['mint', [recipient, amount]],
      ['removeMinter', [master]],
    ] as const) {
      const hash = await wallet.writeContract({
        address: usdc.address,
        abi,
        functionName,
        args: args as never,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`fork USDC seed failed: ${functionName}`);
    }
  } finally {
    await client.request({ method: 'anvil_stopImpersonatingAccount', params: [master] } as never);
  }
}

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
console.log('Starting an owned local Celo fork; the upstream node is only read.');
const env = await startDev({ signal: controller.signal });
await assertLocalAnvil(env.rpcUrl);
const db = await disposableDatabase();
const chain = createPublicClient({
  chain: celo,
  transport: http(env.rpcUrl),
  pollingInterval: 100,
});
const balanceOf = (address: string) =>
  chain.readContract({
    address: usdc.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address as `0x${string}`],
  }) as Promise<bigint>;
/**
 * Advances the fork so an included payment can reach a finalized block. Anvil
 * reports `finalized` sixty-four blocks behind `latest`, so a round has to
 * carry the payment past that distance for the adapter to read finality rather
 * than inclusion.
 */
const mine = (blocks = 70) =>
  chain.request({ method: 'anvil_mine', params: [toHex(blocks)] } as never);

try {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  process.env.TRIALOOM_EVIDENCE_DIR = resolve(evidenceDir, 'evidence');
  await migrate(db.pool);

  // 1. A real policy on the fork, created by the payer's own wallet. The
  //    budget is added to that wallet's token approval for the allowance
  //    contract, which is the number every policy for the token shares.
  await seedUsdc(env.rpcUrl, env.accounts.treasury, 20_000_000n);
  const policy = await env.clients.treasury.policies.create({
    agent: env.accounts.buyer,
    token: 'USDC',
    perPayment: '5',
    perDay: '20',
    days: 1,
    budget: '20',
    recipients: [env.accounts.seller],
  });
  const onChain = await env.clients.treasury.policies.get(policy.id);
  check(
    'a real policy exists on the fork with the payer approval it declares',
    onChain.active &&
      onChain.ownerAllowance >= 20_000_000n &&
      onChain.owner === env.accounts.treasury,
  );

  // 2. Trialoom's own records: a workspace, a project, a pinned build.
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Funded authority workspace',
  });
  const workspaceId = bootstrap.workspaceId;
  await acceptInvitation(db.pool, { token: bootstrap.token, name: 'Owner', password }, null);
  const actorFor = async (email: string) =>
    (await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [email])).rows[0];
  const owner = await actorFor('owner@example.test');
  const project = await createProject(
    db.pool,
    owner,
    workspaceId,
    {
      name: 'Funded preview project',
      targetUrl: target,
      environment: 'preview',
      authorizationConfirmed: true,
    },
    publicDns,
  );
  const projectId = project.id;
  const buildId = (
    await addBuild(
      db.pool,
      owner,
      workspaceId,
      projectId,
      { revision: 'baseline-1', fixtureVersion: 'invitation-1', targetUrl: target },
      publicDns,
    )
  ).id;

  // 3. The authority, declared from what the chain actually says.
  const authority = await registerAuthority(db.pool, owner, workspaceId, {
    reference: 'Fork treasury policy',
    provider: 'remesso',
    policyId: String(policy.id),
    payerAddress: env.accounts.treasury,
    agentAddress: env.accounts.buyer,
    declaredUnits: onChain.ownerAllowance.toString(),
    declarationAcknowledged: true,
  });
  const config = {
    agentKey: keyAt(0),
    rpcUrl: env.rpcUrl,
    functionsUrl: env.functionsUrl,
    namespace: 'trialoom-fork-check',
    builderCodes: ['trialoom_local'],
  };
  const reader = remessoReader(db.pool, config);
  const adapter = remessoAdapter(db.pool, config);
  const verified = await verifyAuthority(
    db.pool,
    owner,
    workspaceId,
    authority.authorityId,
    reader,
  );
  check(
    'the reader reads the live approval and balance and marks the authority verified',
    verified.approval.state === 'verified' &&
      verified.approval.observedAllowanceUnits === onChain.ownerAllowance.toString() &&
      verified.approval.observedBalanceUnits ===
        (await balanceOf(env.accounts.treasury)).toString(),
  );

  // 4. A brief committed against that approval, and the work that earns a fee.
  const campaign = await createCampaign(db.pool, owner, workspaceId, projectId, {
    name: 'Find invitation defects',
    terms: {
      buildId,
      expectedVersion: 0,
      service: 'bug_discovery',
      scope: 'Exercise the seeded invitation journey on the pinned build',
      allowedActions: ['Create sandbox invitations'],
      exclusions: ['No real emails'],
      acceptanceCriteria: 'Reports must replay from the exported trace',
      rewardRubric: 'One discovery reward per distinct accepted defect',
      artifactRights: 'Builder retains reports and regression tests',
      deadline: new Date(Date.now() + 86_400_000).toISOString(),
      reviewWindowHours: 48,
      priceUnits: '2000000',
      discoveryRewardCapUnits: '1000000',
      resourceAllowanceUnits: '0',
      platformFeeBps: 0,
      paymentTerms: 'Authorized spending is not escrow; accepted work remains owed.',
      scopeApproved: true,
    },
  });
  const published = await publishCampaign(
    db.pool,
    owner,
    workspaceId,
    projectId,
    campaign.campaignId,
    {
      termsVersionId: campaign.id,
      slots: 1,
      maxConcurrent: 1,
      authorizeUnits: '5000000',
      spendingAuthorization: `remesso-policy-${policy.id}`,
      authorityId: authority.authorityId,
      authorizationConfirmed: true,
    },
  );
  check('the brief published against the authority that funds it', published.status === 'open');

  const operatorEmail = 'payee@example.test';
  const invitation = await createInvitation(db.pool, owner, workspaceId, {
    email: operatorEmail,
    role: 'operator',
  });
  await acceptInvitation(db.pool, { token: invitation.token, name: 'payee', password }, null);
  const operatorActor = await actorFor(operatorEmail);
  const operator = await registerOperator(db.pool, operatorActor, { handle: 'forkpayee' });
  for (const [task, report] of Object.entries(qualifications))
    await submitAttempt(db.pool, operator, { task, report });
  // The payout address is the fork's seller account, which signs its own proof.
  const seller = mnemonicToAccount(fixtureMnemonic, { addressIndex: 1 });
  const challenge = await issueWalletChallenge(db.pool, operatorActor, { address: seller.address });
  await proveWallet(db.pool, operatorActor, {
    nonce: challenge.nonce,
    signature: await seller.signMessage({ message: challenge.message }),
    designatePayout: true,
  });
  const credential = await createCredential(db.pool, operatorActor, {
    name: 'Runner',
    scopes: ['work:read', 'assignments:read', 'assignments:claim', 'runs:execute', 'payouts:read'],
    expiresInDays: 1,
  });
  const session = await authenticateAgent(db.pool, credential.secret);
  const assignment = await claim(db.pool, session, { campaignId: campaign.campaignId });
  const run = await startRun(
    db.pool,
    session,
    assignment.assignmentId,
    { attemptToken: assignment.attemptToken },
    { resolver: publicDns, probe: settledProbe },
  );
  const grant = await authenticateRun(db.pool, run.runToken);
  const archive = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0xff, 0xfe]),
    randomBytes(24),
  ]);
  await storeArtifact(
    db.pool,
    grant,
    { name: 'replay.trace.zip', kind: 'trace', sha256: digestOf(archive) },
    'application/zip',
    archive,
  );
  const assertions = Buffer.from(`{"assignment":"${assignment.assignmentId}"}`);
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
    assertions: [
      { name: 'invitation.plus-alias', passed: false, detail: 'Expected 201, observed 400' },
    ],
    outcome: 'product_failed',
    summary: 'The seeded validator rejects a plus alias on the pinned build.',
    artifacts: [
      { name: 'replay.trace.zip', sha256: digestOf(archive) },
      { name: 'assertions.json', sha256: digestOf(assertions) },
    ],
  });
  await decideExecution(db.pool, owner, workspaceId, projectId, assignment.assignmentId, {
    outcome: 'accepted',
    reason: 'Every assigned step ran with complete evidence.',
    evidenceRefs: [],
  });
  const payable = (
    await db.pool.query(`SELECT * FROM payables WHERE assignment_id=$1 AND kind='operator'`, [
      assignment.assignmentId,
    ])
  ).rows[0];
  check(
    'the accepted decision owes a payable bound to the authority and the payee wallet',
    payable.authority_id === authority.authorityId &&
      payable.recipient_address.toLowerCase() === seller.address.toLowerCase() &&
      payable.amount_units === '2000000',
  );

  // 5. The worker pays it through the live adapter.
  const before = await balanceOf(seller.address);
  const nonceBefore = await chain.getTransactionCount({ address: env.accounts.buyer });
  // Gas comes out of the agent's own balance, not the builder's approval, so
  // this is the number the recorded cost has to match.
  const celoBefore = await chain.getBalance({ address: env.accounts.buyer });
  const lease = async () =>
    (
      await db.pool.query(
        `UPDATE outbox_jobs SET state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),
        lease_until=clock_timestamp()+interval '60 seconds',available_at=clock_timestamp()
        WHERE dedupe_key=$1 AND state IN ('pending','leased')
        RETURNING id,topic,lease_token,attempts,payload`,
        [payable.operation_key],
      )
    ).rows[0];
  const outcomes: string[] = [];
  for (let round = 0; round < 6; round += 1) {
    const job = await lease();
    if (!job) break;
    outcomes.push(await dispatchPayout(db.pool, job, adapter));
    await mine();
    const state = (await db.pool.query('SELECT state FROM payables WHERE id=$1', [payable.id]))
      .rows[0].state;
    if (state === 'finalized') break;
  }
  const paid = (await db.pool.query('SELECT * FROM payables WHERE id=$1', [payable.id])).rows[0];
  check(
    `the payable settled through the live adapter: ${outcomes.join(' then ')}`,
    paid.state === 'finalized' && /^0x[0-9a-f]{64}$/.test(paid.transaction_hash),
  );
  check(
    'exactly the owed amount reached the payee on the fork',
    (await balanceOf(seller.address)) - before === 2_000_000n,
  );
  check(
    'one signed transaction from the agent carried it',
    (await chain.getTransactionCount({ address: env.accounts.buyer })) === nonceBefore + 1,
  );
  const settledApproval = (
    await db.pool.query('SELECT * FROM payment_approvals WHERE id=$1', [
      authority.approval.approvalId,
    ])
  ).rows[0];
  check(
    'the approval records the spend and its remainder fell with it',
    settledApproval.settled_units === '2000000' &&
      settledApproval.committed_units === '3000000' &&
      settledApproval.declared_units === '18000000',
  );
  const reread = await verifyAuthority(db.pool, owner, workspaceId, authority.authorityId, reader);
  check(
    'the chain agrees: the live approval fell by exactly what was paid',
    reread.approval.observedAllowanceUnits === '18000000',
  );

  // What it cost to send, read from the receipt rather than estimated.
  const gasRow = (await db.pool.query('SELECT * FROM payout_gas WHERE payable_id=$1', [payable.id]))
    .rows;
  const spend = gasRow[0];
  check(
    'the receipt\u2019s own gas was recorded once against the payout',
    gasRow.length === 1 &&
      spend.transaction_hash === paid.transaction_hash &&
      BigInt(spend.cost_units) === BigInt(spend.gas_used) * BigInt(spend.effective_price) &&
      BigInt(spend.gas_used) > 0n,
  );
  check(
    'the agent\u2019s own balance fell by exactly the recorded gas, and the payee\u2019s did not',
    celoBefore - (await chain.getBalance({ address: env.accounts.buyer })) ===
      BigInt(spend.cost_units) && (await balanceOf(seller.address)) - before === 2_000_000n,
  );
  const perCurrency = await gasByCurrency(db.pool, workspaceId);
  check(
    `gas was paid in ${spend.currency_symbol} and is reported as its own cost, not folded into revenue`,
    perCurrency.length === 1 &&
      perCurrency[0].comparableWithRevenue === false &&
      perCurrency[0].costUnits === spend.cost_units &&
      spend.fee_currency_address === null,
  );
  const economics = (await pilotMetrics(db.pool, workspaceId)).find(
    (metric) => metric.id === 'economics',
  );
  check(
    'the economics target reports the real gas and still refuses to print a margin',
    economics?.complete === false &&
      economics?.value === null &&
      !economics.missing.some((reason) => /gas is not recorded/.test(reason)) &&
      economics.missing.some((reason) => /not convertible/.test(reason)),
  );

  // 6. The provider's own journal, which is what every recovery path rests on.
  //    Sending the same operation key again must report the first payment
  //    rather than make a second one, and a key it never saw must come back
  //    unknown rather than as a failure that looks like a lost payment.
  const request = {
    operationKey: payable.operation_key,
    chainId: payable.currency_chain_id,
    tokenAddress: payable.currency_address,
    recipient: payable.recipient_address,
    amountUnits: payable.amount_units,
    authority: {
      id: authority.authorityId,
      provider: 'remesso' as const,
      policyId: String(policy.id),
      payerAddress: env.accounts.treasury,
      agentAddress: env.accounts.buyer,
    },
  };
  const again = await adapter.send(request);
  check(
    'the same operation key sent again reports the first payment and moves nothing',
    /already paid/.test(again.detail) &&
      (await balanceOf(seller.address)) - before === 2_000_000n &&
      (await chain.getTransactionCount({ address: env.accounts.buyer })) === nonceBefore + 1,
  );
  const unseen = await adapter.confirm({
    operationKey: `trp_${randomBytes(24).toString('hex')}`,
    transactionHash: null,
  });
  check(
    'a key the provider never saw comes back unknown rather than failed',
    unseen.status === 'unknown',
  );

  // 7. The recurring read, driven the way the worker drives it: through the
  //    outbox, with the real reader, against the real chain.
  const scheduled = async () =>
    processOne(db.pool, {
      'authority.verify': (client, lease) => verifyScheduled(client, lease, reader),
    });
  const observationsNow = async () =>
    Number(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM payment_approval_observations WHERE approval_id=$1',
          [authority.approval.approvalId],
        )
      ).rows[0].n,
    );
  const seenBefore = await observationsNow();
  check('the worker picked the recurring read off the outbox', await scheduled());
  const jobAfter = (
    await db.pool.query(
      `SELECT state,available_at>clock_timestamp() AS deferred FROM outbox_jobs
      WHERE dedupe_key=$1`,
      [`authority:${authority.authorityId}`],
    )
  ).rows[0];
  check(
    'it read the live approval again and put itself back on the queue',
    (await observationsNow()) === seenBefore + 1 &&
      jobAfter.state === 'pending' &&
      jobAfter.deferred === true,
  );

  // 8. A policy revoked on chain is a fact, so the scheduled read finds it and
  //    stops new claims without cancelling anything already accepted.
  await env.clients.treasury.policies.revoke(policy.id);
  await mine(1);
  await db.pool.query(`UPDATE outbox_jobs SET available_at=clock_timestamp() WHERE dedupe_key=$1`, [
    `authority:${authority.authorityId}`,
  ]);
  await scheduled();
  const listing = await workspaceAuthorities(db.pool, owner, workspaceId);
  const owed = (await db.pool.query('SELECT state FROM payables WHERE id=$1', [payable.id]))
    .rows[0];
  check(
    'the scheduled read found the revoked policy, paused the brief and left the record intact',
    listing.authorities[0].approval.state === 'short' &&
      listing.authorities[0].approval.settledUnits === '2000000' &&
      (await db.pool.query('SELECT status FROM campaigns WHERE id=$1', [campaign.campaignId]))
        .rows[0].status === 'paused' &&
      owed.state === 'finalized',
  );
  await revokeAuthority(db.pool, owner, workspaceId, authority.authorityId, {
    reason: 'The policy was revoked on chain during the fork check.',
  });
  await db.pool.query(`UPDATE outbox_jobs SET available_at=clock_timestamp() WHERE dedupe_key=$1`, [
    `authority:${authority.authorityId}`,
  ]);
  await scheduled();
  check(
    'revoking the authority ends its recurring read rather than leaving it spinning',
    (
      await db.pool.query('SELECT state FROM outbox_jobs WHERE dedupe_key=$1', [
        `authority:${authority.authorityId}`,
      ])
    ).rows[0].state === 'done',
  );

  console.log(
    `\n${checks.length} fork checks passed. ${exactUnits('2000000')} USDC moved on a disposable fork and cost ${exactUnits(spend.cost_units, 18)} ${spend.currency_symbol} in gas; no mainnet value was spent.`,
  );
} finally {
  await db.close();
  await env.close();
  controller.abort();
  await rm(evidenceDir, { recursive: true, force: true });
}
