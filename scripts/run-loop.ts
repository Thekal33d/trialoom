/**
 * The seeded end-to-end loop: one campaign driven from publication to an owed
 * payable, plus a repair, a capped resource purchase, an export, and the three
 * recovery paths the release scenarios ask about.
 *
 * It runs against a disposable database and the real server modules, so every
 * rule it exercises is the one the product enforces. It asserts as it goes and
 * exits non-zero on the first failure, so it is a check as well as a demo. The
 * HTTP surface is covered separately by the browser checks.
 *
 *   npm run loop
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { canonicalJson } from '../src/domain/values.ts';
import { authenticateAgent } from '../src/server/agents.ts';
import {
  claim,
  publishCampaign,
  releaseAssignment,
  sweepExpiredAssignments,
} from '../src/server/assignments.ts';
import { workspaceAttention } from '../src/server/attention.ts';
import { transaction } from '../src/server/database.ts';
import { decideDiscovery, decideExecution } from '../src/server/decisions.ts';
import { storeArtifact, submitEvidence } from '../src/server/evidence.ts';
import { campaignExport } from '../src/server/exports.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { authenticateHost, recordEgress, registerHost } from '../src/server/isolation.ts';
import { campaignAccounting, outstandingCommitment } from '../src/server/ledger.ts';
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
import { decideQuote, proposeQuote } from '../src/server/repairs.ts';
import {
  authorizeResourceCeiling,
  purchaseResource,
  type ResourceAdapter,
  reconcilePurchase,
  remainingAllowance,
} from '../src/server/resources.ts';
import { authenticateRun, isolationProfile, startRun } from '../src/server/runner.ts';
import {
  dispatchPayout,
  type SettlementAdapter,
  type SettlementResult,
  unconfiguredAdapter,
} from '../src/server/settlement.ts';
import { digestOf, getObject } from '../src/server/storage.ts';
import { disposableDatabase } from '../tests/helpers/database.ts';

const started = new Date();
const stamp = started.toISOString().replace(/[:.]/g, '-');
const directory = resolve('artifacts/loop', stamp);
const transcript: { phase: string; step: string; detail: string }[] = [];
let phase = 'setup';
function note(step: string, detail: string) {
  transcript.push({ phase, step, detail });
  console.log(`  ${step}: ${detail}`);
}
function heading(name: string) {
  phase = name;
  console.log(`\n${name}`);
}

const db = await disposableDatabase();
const password = randomBytes(24).toString('base64url');
const target = 'https://preview.example.com/';
const baseRevision = 'baseline-1';
const candidateRevision = 'candidate-2';
const publicDns = async () => ['93.184.215.14'];
const settledProbe = async () => ({ status: 200, location: null, revision: baseRevision });
const archiveBytes = () =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0xff, 0xfe]), randomBytes(24)]);
const hashFor = (seed: string) =>
  `0x${createHash('sha256').update(seed).digest('hex').slice(0, 64)}`;
const scopes = [
  'work:read',
  'assignments:read',
  'assignments:claim',
  'runs:execute',
  'decisions:read',
  'appeals:submit',
  'payouts:read',
  'resources:purchase',
];
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
  'regression-pins-revision': {
    defectPresent: true,
    baselineResult: 'failed',
    candidateResult: 'passed',
  },
};

/** A provider with a durable journal: it never pays the same key twice. */
function recordingSettlement(script: SettlementResult[]): SettlementAdapter & { sends: number } {
  const sent = new Map<string, string>();
  const confirmed = new Map<string, number>();
  let index = 0;
  const adapter = {
    name: 'loop-fixture',
    sends: 0,
    async send(request: { operationKey: string }) {
      adapter.sends += 1;
      const result = script[Math.min(index, script.length - 1)];
      index += 1;
      if (result.transactionHash) sent.set(request.operationKey, result.transactionHash);
      if (result.status === 'uncertain') {
        // The money moved; the answer did not come back.
        sent.set(request.operationKey, hashFor(request.operationKey));
        throw new Error('connection reset after broadcast');
      }
      return result;
    },
    async confirm(request: { operationKey: string }) {
      const hash = sent.get(request.operationKey);
      if (!hash) return { status: 'unknown' as const, detail: 'No record of that key.' };
      // Inclusion before finality, so the loop exercises both states rather
      // than skipping the one the ledger does not act on.
      const seen = (confirmed.get(request.operationKey) ?? 0) + 1;
      confirmed.set(request.operationKey, seen);
      return {
        status: seen === 1 ? ('included' as const) : ('finalized' as const),
        transactionHash: hash,
        detail: seen === 1 ? 'In a block.' : 'Reconciled the original payment.',
      };
    },
  };
  return adapter;
}
const resourceProvider: ResourceAdapter = {
  name: 'loop-fixture',
  async quote() {
    return {
      status: 'quoted',
      amountUnits: '3606',
      chainId: 42220,
      tokenAddress: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
      tokenDecimals: 6,
      payee: '0x2222222222222222222222222222222222222222',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  },
  async purchase() {
    return {
      status: 'usable',
      costUnits: '3606',
      transactionHash: hashFor('resource'),
      receipt: { session: 'browser-1' },
      detail: 'Session provisioned.',
    };
  },
  async resolve() {
    return { status: 'unknown', detail: 'The provider already reported this cost.' };
  },
};

/** Leases one job by its own key, so a phase settles the payment it means to. */
async function leaseFor(key: string) {
  return (
    await db.pool.query(
      `UPDATE outbox_jobs SET state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+interval '30 seconds',available_at=clock_timestamp()
      WHERE dedupe_key=$1 AND state IN ('pending','leased')
      RETURNING id,topic,lease_token,attempts,payload`,
      [key],
    )
  ).rows[0];
}
async function settle(adapter: SettlementAdapter, key: string, rounds = 4) {
  const outcomes: string[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const lease = await leaseFor(key);
    if (!lease) break;
    outcomes.push(await dispatchPayout(db.pool, lease, adapter).catch((error) => `error:${error}`));
  }
  return outcomes;
}
const payablesFor = async (assignmentId: string) =>
  (
    await db.pool.query('SELECT * FROM payables WHERE assignment_id=$1 ORDER BY kind,created_at', [
      assignmentId,
    ])
  ).rows;

type Operator = Awaited<ReturnType<typeof qualifiedOperator>>;
// Assigned in the first phase, before anything reads it.
let owner!: { id: string; name: string; email: string };
let workspaceId = '';
let projectId = '';
let buildId = '';

async function actorFor(email: string) {
  return (await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [email]))
    .rows[0];
}
async function qualifiedOperator(handle: string) {
  const email = `${handle}@example.test`;
  const invitation = await createInvitation(db.pool, owner, workspaceId, {
    email,
    role: 'operator',
  });
  await acceptInvitation(db.pool, { token: invitation.token, name: handle, password }, null);
  const actor = await actorFor(email);
  const operator = await registerOperator(db.pool, actor, { handle });
  for (const [task, report] of Object.entries(qualifications))
    await submitAttempt(db.pool, operator, { task, report });
  // An operator proves control of a payout address the way the product does:
  // a single-use challenge, signed outside the application.
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = await issueWalletChallenge(db.pool, actor, { address: account.address });
  await proveWallet(db.pool, actor, {
    nonce: challenge.nonce,
    signature: await account.signMessage({ message: challenge.message }),
    designatePayout: true,
  });
  const credential = await createCredential(db.pool, actor, {
    name: 'Runner',
    scopes,
    expiresInDays: 7,
  });
  return {
    actor,
    operator,
    address: account.address,
    session: await authenticateAgent(db.pool, credential.secret),
  };
}
function termsFor(service: string, overrides: Record<string, unknown> = {}) {
  return {
    buildId,
    expectedVersion: 0,
    service,
    scope: 'Exercise the seeded invitation journey on the pinned build',
    allowedActions: ['Create sandbox invitations'],
    exclusions: ['No real emails', 'No production data'],
    acceptanceCriteria: 'Reports must replay from the exported trace on the pinned build',
    rewardRubric: 'One discovery reward per distinct accepted defect',
    artifactRights: 'Builder retains reports, patches and regression tests',
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
async function brief(
  name: string,
  service: string,
  slots = 3,
  terms: Record<string, unknown> = {},
) {
  const campaign = await createCampaign(db.pool, owner, workspaceId, projectId, {
    name,
    terms: termsFor(service, terms),
  });
  return {
    campaign,
    publish: () =>
      publishCampaign(db.pool, owner, workspaceId, projectId, campaign.campaignId, {
        termsVersionId: campaign.id,
        slots,
        maxConcurrent: slots,
        authorizeUnits: '40000000',
        spendingAuthorization: 'remesso-policy-loop-fixture',
        authorizationConfirmed: true,
      }),
  };
}
/** Claims a slot and opens a run grant against the revalidated target. */
async function startWork(operator: Operator, campaignId: string, hostId?: string) {
  const assignment = await claim(db.pool, operator.session, { campaignId });
  const run = await startRun(
    db.pool,
    operator.session,
    assignment.assignmentId,
    { attemptToken: assignment.attemptToken, ...(hostId ? { hostId } : {}) },
    { resolver: publicDns, probe: settledProbe },
  );
  return { assignment, run, grant: await authenticateRun(db.pool, run.runToken) };
}
function envelope(
  assignment: Awaited<ReturnType<typeof claim>>,
  contentHash: string,
  extra: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    campaignId: assignment.campaignId,
    assignmentId: assignment.assignmentId,
    termsVersionId: assignment.termsVersionId,
    termsContentHash: contentHash,
    build: {
      id: assignment.buildId,
      revision: baseRevision,
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
    ...extra,
  };
}

try {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  process.env.TRIALOOM_EVIDENCE_DIR = resolve(directory, 'evidence');
  await migrate(db.pool);
  note('database', 'migrated a disposable database and isolated the evidence store');

  heading('1. A builder sets up a project and publishes work');
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Seeded loop workspace',
  });
  workspaceId = bootstrap.workspaceId;
  await acceptInvitation(db.pool, { token: bootstrap.token, name: 'Owner', password }, null);
  owner = await actorFor('owner@example.test');
  for (const [role, email] of [
    ['reviewer', 'reviewer@example.test'],
    ['member', 'member@example.test'],
  ]) {
    const invite = await createInvitation(db.pool, owner, workspaceId, { email, role });
    await acceptInvitation(db.pool, { token: invite.token, name: role, password }, null);
  }
  const reviewer = await actorFor('reviewer@example.test');
  note('workspace', 'invited an owner, a reviewer and a project member; no open sign-up exists');
  const project = await createProject(
    db.pool,
    owner,
    workspaceId,
    {
      name: 'Seeded preview project',
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
      { revision: baseRevision, fixtureVersion: 'invitation-1', targetUrl: target },
      publicDns,
    )
  ).id;
  note('project', `authorized ${target} and pinned build ${baseRevision}`);

  const discovery = await brief('Find invitation defects', 'bug_discovery');
  const published = await discovery.publish();
  assert.equal(published.status, 'open');
  assert.equal(published.perAssignmentUnits, '3800000');
  note(
    'publication',
    `offered terms v${published.termsVersion} with ${published.slots} slots, reserving ${published.perAssignmentUnits} base units each from a ${published.ceilingUnits} ceiling`,
  );

  heading('2. Two independent operators execute and report the same failure');
  const first = await qualifiedOperator('loop-first');
  const second = await qualifiedOperator('loop-second');
  const reports = [];
  for (const operator of [first, second]) {
    const work = await startWork(operator, discovery.campaign.campaignId);
    const archive = archiveBytes();
    await storeArtifact(
      db.pool,
      work.grant,
      { name: 'replay.trace.zip', kind: 'trace', sha256: digestOf(archive) },
      'application/zip',
      archive,
    );
    const report = Buffer.from(
      `{"reporter":"${operator.operator.handle}@example.test","token":"Bearer abcdefghijklmnopqrstuvwxyz012345"}`,
      'utf8',
    );
    await storeArtifact(
      db.pool,
      work.grant,
      { name: 'report.json', kind: 'report', sha256: digestOf(report) },
      'application/json',
      report,
    );
    const assertions = Buffer.from('{"invitationAccepted":false}', 'utf8');
    await storeArtifact(
      db.pool,
      work.grant,
      { name: 'assertions.json', kind: 'assertions', sha256: digestOf(assertions) },
      'application/json',
      assertions,
    );
    const result = await submitEvidence(
      db.pool,
      work.grant,
      envelope(work.assignment, discovery.campaign.contentHash, {
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
          { name: 'invitation.create', passed: false, detail: 'Expected 201, observed 400' },
        ],
        outcome: 'product_failed',
        summary: 'The seeded validator rejects a plus alias on the pinned build.',
        artifacts: [
          { name: 'replay.trace.zip', sha256: digestOf(archive) },
          { name: 'report.json', sha256: digestOf(report) },
          { name: 'assertions.json', sha256: digestOf(assertions) },
        ],
      }),
    );
    reports.push({ operator, work, result });
    note(
      `report by @${operator.operator.handle}`,
      `${result.finding?.match} match, independent: ${result.finding?.independent}, decision: ${result.decision}`,
    );
  }
  assert.equal(reports[0].result.finding?.match, 'first');
  assert.equal(reports[1].result.finding?.match, 'exact');
  assert.equal(reports[0].result.finding?.defectId, reports[1].result.finding?.defectId);
  const defectId = reports[0].result.finding?.defectId as string;
  const defect = (await db.pool.query('SELECT * FROM defects WHERE id=$1', [defectId])).rows[0];
  assert.equal(defect.state, 'confirmed');
  note('reproduction', 'two independent reports of the same signature confirmed one defect');
  const leakedArtifact = (
    await db.pool.query(
      "SELECT reviewable,redaction,redacted_key FROM evidence_artifacts WHERE name='report.json' LIMIT 1",
    )
  ).rows[0];
  assert.equal(leakedArtifact.reviewable, true);
  assert.equal(leakedArtifact.redaction.verified, true);
  const caught = Object.keys(leakedArtifact.redaction.findings ?? {});
  assert.ok(caught.length > 0, 'the leaked credential must have been recognized');
  // The guarantee is about the copy a reader gets, not about which rule fired.
  const readable = strFromU8(
    new Uint8Array(await getObject(leakedArtifact.redacted_key as string)),
  );
  assert.ok(!readable.includes('abcdefghijklmnopqrstuvwxyz012345'));
  note(
    'redaction',
    `the report an operator uploaded carried ${caught.join(', ')}; the only readable copy has none of it`,
  );

  heading('3. A person decides, and only that authorizes money');
  const accepted = [];
  for (const entry of reports) {
    const decision = await decideExecution(
      db.pool,
      owner,
      workspaceId,
      projectId,
      entry.work.assignment.assignmentId,
      {
        outcome: 'accepted',
        reason: 'Every assigned step ran and the exported trace replays on the pinned build.',
        evidenceRefs: [],
      },
    );
    accepted.push(decision);
    note(
      `execution for @${entry.operator.operator.handle}`,
      `accepted, moving ${decision.movedUnits} base units into accepted liability`,
    );
  }
  const award = await decideDiscovery(
    db.pool,
    owner,
    workspaceId,
    projectId,
    reports[0].result.finding?.findingId as string,
    {
      outcome: 'awarded',
      amountUnits: '1000000',
      reason: 'First complete report of a confirmed in-scope defect.',
      evidenceRefs: [],
    },
  );
  note('discovery', `awarded ${award.movedUnits} base units to the earliest complete report`);
  let refused = '';
  await decideDiscovery(
    db.pool,
    owner,
    workspaceId,
    projectId,
    reports[1].result.finding?.findingId as string,
    { outcome: 'awarded', reason: 'Same defect, reported second.', evidenceRefs: [] },
  ).catch((error) => {
    refused = (error as { code?: string }).code ?? '';
  });
  assert.equal(refused, 'DISCOVERY_ALREADY_AWARDED');
  note(
    'duplicate reward',
    'the second report of the same defect was refused the reward and keeps its execution payment (R03)',
  );

  heading('4. Acceptance writes a payable, and with no payment authority it stays owed');
  const owed = await payablesFor(reports[0].work.assignment.assignmentId);
  // Each decision writes its own operator transfer and its own fee, so the two
  // acceptances on this assignment owe four separate payments.
  assert.deepEqual(owed.map((row) => `${row.kind}:${row.category}`).sort(), [
    'operator:discovery',
    'operator:execution',
    'platform_fee:fee',
    'platform_fee:fee',
  ]);
  assert.equal(new Set(owed.map((row) => row.operation_key)).size, owed.length);
  note(
    'payables',
    `${owed.length} separate transfers for two acceptances, each with its own operation key`,
  );
  const execution = owed.find((row) => row.category === 'execution');
  const discoveryPayable = owed.find((row) => row.category === 'discovery');
  assert.ok(execution.recipient_address, 'the proven payout wallet was fixed on the payable');
  const blocked = await settle(unconfiguredAdapter, execution.operation_key, 2);
  const stayed = (await db.pool.query('SELECT * FROM payables WHERE id=$1', [execution.id]))
    .rows[0];
  assert.equal(stayed.state, 'blocked');
  assert.equal(stayed.blocked_reason, 'payment_authority_unavailable');
  assert.equal(stayed.transaction_hash, null);
  note(
    'settlement, as configured',
    `${blocked.join(', ')} — no funded payment authority exists, so the amount is owed and visibly blocked`,
  );

  heading('5. With a payment authority, inclusion and finality are separate facts');
  const fixture = recordingSettlement([
    { status: 'submitted', transactionHash: hashFor('one'), detail: 'Broadcast.' },
    { status: 'included', transactionHash: hashFor('one'), detail: 'In a block.' },
    { status: 'finalized', transactionHash: hashFor('one'), detail: 'Final.' },
  ]);
  const beforeFinality = await campaignAccounting(db.pool, discovery.campaign.campaignId);
  const states = await settle(fixture, discoveryPayable.operation_key, 4);
  const settledRow = (
    await db.pool.query('SELECT * FROM payables WHERE id=$1', [discoveryPayable.id])
  ).rows[0];
  assert.equal(settledRow.state, 'finalized');
  assert.equal(fixture.sends, 1);
  assert.ok(settledRow.included_at !== null && settledRow.finalized_at !== null);
  const afterFinality = await campaignAccounting(db.pool, discovery.campaign.campaignId);
  assert.equal(
    BigInt(afterFinality?.finalizedUnits ?? '0') - BigInt(beforeFinality?.finalizedUnits ?? '0'),
    BigInt(discoveryPayable.amount_units),
  );
  note(
    'settlement, with authority',
    `${states.join(' → ')}; the ledger moved ${discoveryPayable.amount_units} base units to finalized, and only at finality`,
  );

  heading('6. Recovery: a crash after broadcast pays once, not twice');
  const crashing = recordingSettlement([
    { status: 'uncertain', detail: 'The answer never came back.' },
  ]);
  const lost = (await payablesFor(reports[1].work.assignment.assignmentId)).find(
    (row) => row.category === 'execution',
  );
  const recovery = await settle(crashing, lost.operation_key, 4);
  const recovered = (await db.pool.query('SELECT * FROM payables WHERE id=$1', [lost.id])).rows[0];
  assert.equal(crashing.sends, 1, 'the same key must never be sent twice');
  assert.equal(recovered.state, 'finalized');
  const attempts = (
    await db.pool.query(
      'SELECT action,result FROM payout_attempts WHERE payable_id=$1 ORDER BY created_at',
      [lost.id],
    )
  ).rows;
  assert.equal(attempts.filter((row) => row.action === 'send').length, 1);
  note(
    'crash after broadcast',
    `${recovery.join(' → ')}; one send and ${attempts.length - 1} reconciliation(s) against the same operation key (R06)`,
  );

  heading('7. Recovery: an expired claim is fenced and its reservation returns');
  const lapsing = await qualifiedOperator('loop-lapsed');
  const before = await campaignAccounting(db.pool, discovery.campaign.campaignId);
  const lapsed = await startWork(lapsing, discovery.campaign.campaignId);
  const reserved = await campaignAccounting(db.pool, discovery.campaign.campaignId);
  assert.equal(
    BigInt(reserved?.committedUnits ?? '0') - BigInt(before?.committedUnits ?? '0'),
    3_800_000n,
    "the claim reserved this assignment's whole maximum liability",
  );
  // The operator finishes its work and uploads evidence, and only then does the
  // lease lapse: what is fenced is a complete attempt, not an empty one.
  const lateArchive = archiveBytes();
  const lateAssertions = Buffer.from('{"invitationAccepted":false}', 'utf8');
  for (const [name, kind, mediaType, bytes] of [
    ['replay.trace.zip', 'trace', 'application/zip', lateArchive],
    ['assertions.json', 'assertions', 'application/json', lateAssertions],
  ] as const)
    await storeArtifact(
      db.pool,
      lapsed.grant,
      { name, kind, sha256: digestOf(bytes) },
      mediaType,
      bytes,
    );
  await db.pool.query(
    `UPDATE assignments SET lease_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
    [lapsed.assignment.assignmentId],
  );
  const swept = await sweepExpiredAssignments(db.pool);
  assert.ok(swept >= 1);
  const fenced = (
    await db.pool.query('SELECT state,closed_reason FROM assignments WHERE id=$1', [
      lapsed.assignment.assignmentId,
    ])
  ).rows[0];
  assert.equal(fenced.state, 'expired');
  const retiredRun = (await db.pool.query('SELECT state FROM runs WHERE id=$1', [lapsed.run.runId]))
    .rows[0];
  assert.equal(retiredRun.state, 'expired');
  let fencedSubmission = '';
  await submitEvidence(
    db.pool,
    lapsed.grant,
    envelope(lapsed.assignment, discovery.campaign.contentHash, {
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
        { name: 'invitation.create', passed: false, detail: 'Expected 201, observed 400' },
      ],
      outcome: 'product_failed',
      summary: 'A late attempt that the lease no longer covers.',
      artifacts: [
        { name: 'replay.trace.zip', sha256: digestOf(lateArchive) },
        { name: 'assertions.json', sha256: digestOf(lateAssertions) },
      ],
    }),
  ).catch((error) => {
    fencedSubmission = (error as { code?: string }).code ?? String(error);
  });
  assert.ok(
    ['ATTEMPT_CLOSED', 'RUN_CLOSED', 'CLAIM_EXPIRED'].includes(fencedSubmission),
    `a lapsed attempt was refused with ${fencedSubmission}`,
  );
  const after = await campaignAccounting(db.pool, discovery.campaign.campaignId);
  assert.equal(after?.committedUnits, before?.committedUnits);
  assert.equal(after?.reconciled, true);
  note(
    'expired claim',
    `the attempt was fenced with ${fencedSubmission} and its reservation returned to the campaign (R12)`,
  );

  heading('8. A confirmed defect is quoted, repaired and independently verified');
  const repair = await brief('Repair the invitation validator', 'repair', 2);
  const author = await qualifiedOperator('loop-author');
  const quote = await proposeQuote(db.pool, owner, workspaceId, projectId, {
    campaignId: repair.campaign.campaignId,
    defectId,
    operatorId: author.operator.id,
    baseBuildId: buildId,
    amountUnits: '2000000',
    scopePaths: ['src/invitations'],
  });
  await decideQuote(db.pool, owner, workspaceId, projectId, quote.quoteId, {
    outcome: 'approved',
    reason: 'The defect is confirmed and the scope is the validator alone.',
  });
  await repair.publish();
  note('quote', `approved ${quote.quoteId.slice(0, 8)} against revision ${quote.baseRevision}`);
  const replays = (assertion: string) => ({
    baseline: [
      { assertion, passed: false, cleanSession: true as const },
      { assertion, passed: false, cleanSession: true as const },
    ],
    candidate: [
      { assertion, passed: true, cleanSession: true as const },
      { assertion, passed: true, cleanSession: true as const },
    ],
  });
  const delivery = await startWork(author, repair.campaign.campaignId);
  const patch = Buffer.from('--- a/src/invitations/validate.ts\n+++ b/x\n@@\n-strict\n+rfc5322\n');
  const regression = Buffer.from('test("plus alias is accepted", () => {})\n');
  const repairAssertions = Buffer.from(`{"candidate":"${candidateRevision}"}`);
  for (const [name, kind, mediaType, bytes] of [
    ['fix.patch', 'patch', 'text/x-diff', patch],
    ['regression.test.txt', 'test', 'text/plain', regression],
    ['assertions.json', 'assertions', 'application/json', repairAssertions],
  ] as const)
    await storeArtifact(
      db.pool,
      delivery.grant,
      { name, kind, sha256: digestOf(bytes) },
      mediaType,
      bytes,
    );
  const delivered = await submitEvidence(
    db.pool,
    delivery.grant,
    envelope(delivery.assignment, repair.campaign.contentHash, {
      steps: [
        {
          index: 1,
          action: 'Replay the regression test on both revisions',
          expected: 'Fails on the original, passes on the candidate',
          actual: 'Fails on the original, passes on the candidate',
          status: 'passed',
        },
      ],
      assertions: [
        { name: 'regression.replayed', passed: true, detail: 'Both revisions replayed cleanly' },
      ],
      outcome: 'executed',
      summary: 'Repairs the plus-alias validator and pins the failure with a regression test.',
      repair: {
        baseRevision,
        candidateRevision,
        changedFiles: [
          {
            path: 'src/invitations/validate.ts',
            beforeSha256: 'a'.repeat(64),
            afterSha256: 'b'.repeat(64),
          },
        ],
        patchSha256: digestOf(patch),
        testSha256: digestOf(regression),
        regression: replays('invitation.create'),
        requiredChecks: [{ label: 'unit', baselinePassed: true, candidatePassed: true }],
      },
      artifacts: [
        { name: 'fix.patch', sha256: digestOf(patch) },
        { name: 'regression.test.txt', sha256: digestOf(regression) },
        { name: 'assertions.json', sha256: digestOf(repairAssertions) },
      ],
    }),
  );
  assert.equal(delivered.repairRole, 'author');
  note('repair delivered', `gate passed and returned ${JSON.stringify(delivered.repair)}`);
  let unverified = '';
  await decideExecution(db.pool, owner, workspaceId, projectId, delivery.assignment.assignmentId, {
    outcome: 'accepted',
    reason: 'The patch looks right.',
    evidenceRefs: [],
  }).catch((error) => {
    unverified = (error as { code?: string }).code ?? '';
  });
  assert.equal(unverified, 'VERIFICATION_PENDING');
  note(
    'acceptance refused',
    "a repair cannot be accepted on the builder's own say-so before an independent confirmation (R11)",
  );
  const verifier = await qualifiedOperator('loop-verifier');
  const verification = await startWork(verifier, repair.campaign.campaignId);
  const verifyArchive = archiveBytes();
  const verifyAssertions = Buffer.from('{"reproduced":true}');
  for (const [name, kind, mediaType, bytes] of [
    ['verify.trace.zip', 'trace', 'application/zip', verifyArchive],
    ['assertions.json', 'assertions', 'application/json', verifyAssertions],
  ] as const)
    await storeArtifact(
      db.pool,
      verification.grant,
      { name, kind, sha256: digestOf(bytes) },
      mediaType,
      bytes,
    );
  const confirmed = await submitEvidence(
    db.pool,
    verification.grant,
    envelope(verification.assignment, repair.campaign.contentHash, {
      steps: [
        {
          index: 1,
          action: 'Replay the delivered regression test on both revisions',
          expected: 'Fails on the original, passes on the candidate',
          actual: 'Fails on the original, passes on the candidate',
          status: 'passed',
        },
      ],
      assertions: [
        { name: 'regression.replayed', passed: true, detail: 'Reproduced independently' },
      ],
      outcome: 'executed',
      summary: 'Independently replayed the delivered regression test on both revisions.',
      repairVerification: {
        outcome: 'confirmed',
        baseRevision,
        candidateRevision,
        regression: replays('invitation.create'),
        detail: 'Replayed the delivered test twice on each revision from a clean session.',
      },
      artifacts: [
        { name: 'verify.trace.zip', sha256: digestOf(verifyArchive) },
        { name: 'assertions.json', sha256: digestOf(verifyAssertions) },
      ],
    }),
  );
  assert.equal(confirmed.repairRole, 'verifier');
  const paidAuthor = await decideExecution(
    db.pool,
    owner,
    workspaceId,
    projectId,
    delivery.assignment.assignmentId,
    {
      outcome: 'accepted',
      reason: 'The regression replays cleanly on both revisions and was independently confirmed.',
      evidenceRefs: [],
    },
  );
  await decideExecution(
    db.pool,
    owner,
    workspaceId,
    projectId,
    verification.assignment.assignmentId,
    {
      outcome: 'accepted',
      amountUnits: '400000',
      reason: 'An independent replay of the delivered regression test.',
      evidenceRefs: [],
    },
  );
  const repairState = (
    await db.pool.query('SELECT repair_state FROM defects WHERE id=$1', [defectId])
  ).rows[0];
  assert.equal(repairState.repair_state, 'accepted');
  note(
    'repair accepted',
    `after confirmation, ${paidAuthor.movedUnits} base units became owed; the patch is delivered for review and Trialoom merges nothing`,
  );

  heading('9. A run buys a capped resource and the eligible cost is reimbursed');
  await authorizeResourceCeiling(db.pool, 1_000_000n, 'loop-fixture-funding');
  const buyer = await qualifiedOperator('loop-buyer');
  const buying = await startWork(buyer, discovery.campaign.campaignId);
  const bought = await purchaseResource(
    db.pool,
    buyer.session,
    buying.run.runId,
    'loop-resource-1',
    {
      attemptToken: buying.assignment.attemptToken,
      provider: 'buy',
      sku: 'browser.session',
      request: { durationMinutes: 1 },
      maxAmountUnits: '10000',
    },
    resourceProvider,
  );
  assert.equal(bought.purchase.state, 'usable');
  note(
    'resource bought',
    `authorized up to ${bought.purchase.ceiling_units} base units and cost ${bought.purchase.cost_units}`,
  );
  const reconcileLease = await leaseFor(bought.purchase.intent_key);
  const reconciled = await reconcilePurchase(db.pool, reconcileLease, resourceProvider);
  assert.equal(reconciled, 'reimbursed');
  const reimbursement = (
    await db.pool.query('SELECT * FROM payables WHERE resource_purchase_id=$1', [
      bought.purchase.id,
    ])
  ).rows[0];
  assert.equal(reimbursement.amount_units, '3606');
  assert.equal(reimbursement.blocked_reason, 'resource_recipient_unconfigured');
  note(
    'resource reimbursed',
    'one itemized reimbursement for the eligible actual cost, owed to a platform wallet that is not configured',
  );
  // A retry of the same request must never authorize a second purchase.
  const retried = await purchaseResource(
    db.pool,
    buyer.session,
    buying.run.runId,
    'loop-resource-1',
    {
      attemptToken: buying.assignment.attemptToken,
      provider: 'buy',
      sku: 'browser.session',
      request: { durationMinutes: 1 },
      maxAmountUnits: '10000',
    },
    resourceProvider,
  );
  assert.equal(retried.replayed, true);
  assert.equal(retried.purchase.id, bought.purchase.id);
  note('resource retry', 'a repeated request returned the purchase it had already started');

  // R07: a purchase whose settlement is unknown holds its reservation and is
  // never bought again; it is reconciled by asking whether the transfer landed.
  const uncertainProvider: ResourceAdapter = {
    ...resourceProvider,
    name: 'loop-uncertain',
    async purchase() {
      return {
        status: 'uncertain',
        reason: 'settlement_uncertain',
        detail: 'The provider answered 500 settle_uncertain.',
      };
    },
    async resolve() {
      return { status: 'unknown', detail: 'The token has recorded no transfer yet.' };
    },
  };
  const allowanceBefore = await transaction(db.pool, (client) =>
    remainingAllowance(client, buying.assignment.assignmentId),
  );
  const unresolved = await purchaseResource(
    db.pool,
    buyer.session,
    buying.run.runId,
    'loop-resource-2',
    {
      attemptToken: buying.assignment.attemptToken,
      provider: 'buy',
      sku: 'vm.micro',
      request: { machine: 'e2-micro' },
      maxAmountUnits: '20000',
    },
    uncertainProvider,
  );
  assert.equal(unresolved.purchase.state, 'uncertain');
  assert.equal(unresolved.purchase.charge, 'pending');
  const retryOutcome = await reconcilePurchase(
    db.pool,
    await leaseFor(unresolved.purchase.intent_key),
    uncertainProvider,
  );
  assert.equal(retryOutcome, 'unresolved');
  const allowanceAfter = await transaction(db.pool, (client) =>
    remainingAllowance(client, buying.assignment.assignmentId),
  );
  assert.equal(allowanceBefore - allowanceAfter, 20_000n);
  // Releasing the assignment cannot give that reservation back either.
  await releaseAssignment(db.pool, buyer.session, buying.assignment.assignmentId, {
    attemptToken: buying.assignment.attemptToken,
  });
  const stillHeld = await transaction(db.pool, (client) =>
    outstandingCommitment(client, buying.assignment.assignmentId),
  );
  assert.equal(stillHeld.resource, 20_000n);
  note(
    'uncertain resource',
    'the settlement is unknown, so the purchase was not bought again and its 20000 base units stayed reserved through the release (R07)',
  );

  heading('10. A witnessed run is held to what its egress proxy saw');
  // Terms are immutable once written, so the requirement is part of the brief
  // from the start rather than something set on it afterwards.
  const witnessed = await brief('Witnessed invitation journey', 'bug_discovery', 2, {
    minimumIsolation: 'witnessed',
  });
  // The brief demands a witness, so an unwitnessed run cannot satisfy it.
  const host = await registerHost(db.pool, owner, workspaceId, {
    name: 'Loop sandboxed host',
    contractVersion: 'runner-host-v1',
    sandbox: 'gvisor',
    egressEnforced: true,
    ephemeralFilesystem: true,
    isolationLevel: 'witnessed',
    contractAccepted: true,
  });
  await witnessed.publish();
  note('host registered', `${host.isolationLevel} under ${host.contract.version}`);
  const watched = await qualifiedOperator('loop-watched');
  // The requirement is checked when the grant is issued, not when the slot is
  // claimed, so one claim tries both ways.
  const claimed = await claim(db.pool, watched.session, {
    campaignId: witnessed.campaign.campaignId,
  });
  const openRun = (hostId?: string) =>
    startRun(
      db.pool,
      watched.session,
      claimed.assignmentId,
      { attemptToken: claimed.attemptToken, ...(hostId ? { hostId } : {}) },
      { resolver: publicDns, probe: settledProbe },
    );
  let unwitnessedRefusal = '';
  await openRun().catch((error) => {
    unwitnessedRefusal = (error as { code?: string }).code ?? '';
  });
  assert.equal(unwitnessedRefusal, 'ISOLATION_REQUIRED');
  note(
    'unwitnessed refused',
    'a brief that requires a witness will not issue a grant that cannot provide one',
  );
  const run = await openRun(host.hostId);
  const supervised = {
    assignment: claimed,
    run,
    grant: await authenticateRun(db.pool, run.runToken),
  };
  assert.equal(run.isolationLevel, 'witnessed');
  const proxy = await authenticateHost(db.pool, host.credential);
  const seenAt = new Date().toISOString();
  await recordEgress(db.pool, proxy, supervised.run.runId, {
    batch: 1,
    observations: [
      {
        origin: 'https://preview.example.com',
        decision: 'allowed',
        requests: 9,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      },
      {
        origin: 'https://exfil.example.net',
        decision: 'denied',
        requests: 3,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      },
    ],
  });
  // A proxy that reports allowing what the manifest forbids is not enforcing.
  let notEnforced = '';
  await recordEgress(db.pool, proxy, supervised.run.runId, {
    batch: 2,
    observations: [
      {
        origin: 'https://exfil.example.net',
        decision: 'allowed',
        requests: 1,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      },
    ],
  }).catch((error) => {
    notEnforced = (error as { code?: string }).code ?? '';
  });
  assert.equal(notEnforced, 'EGRESS_NOT_ENFORCED');
  const watchedTrace = archiveBytes();
  const watchedAssertions = Buffer.from('{"invitationAccepted":false}', 'utf8');
  for (const [name, kind, mediaType, bytes] of [
    ['replay.trace.zip', 'trace', 'application/zip', watchedTrace],
    ['assertions.json', 'assertions', 'application/json', watchedAssertions],
  ] as const)
    await storeArtifact(
      db.pool,
      supervised.grant,
      { name, kind, sha256: digestOf(bytes) },
      mediaType,
      bytes,
    );
  const supervisedEvidence = envelope(supervised.assignment, witnessed.campaign.contentHash, {
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
      { name: 'invitation.witnessed', passed: false, detail: 'Expected 201, observed 400' },
    ],
    outcome: 'product_failed',
    summary: 'The seeded validator rejects a plus alias on the pinned build.',
    artifacts: [
      { name: 'replay.trace.zip', sha256: digestOf(watchedTrace) },
      { name: 'assertions.json', sha256: digestOf(watchedAssertions) },
    ],
  });
  // A claim the proxy never saw does not describe this run.
  let unseen = '';
  await submitEvidence(db.pool, supervised.grant, {
    ...supervisedEvidence,
    observedOrigins: ['https://exfil.example.net'],
  }).catch((error) => {
    unseen = (error as { code?: string }).code ?? '';
  });
  assert.ok(['EGRESS_VIOLATION', 'EGRESS_UNWITNESSED'].includes(unseen));
  const agreed = await submitEvidence(db.pool, supervised.grant, supervisedEvidence);
  assert.equal(agreed.egress.witnessed, true);
  assert.equal(agreed.egress.deniedAttempts, 3);
  note(
    'witnessed submission',
    `the proxy saw ${agreed.egress.allowedOrigins.join(', ')} and denied ${agreed.egress.deniedAttempts} attempt(s) to leave the allowlist; the agent's claim had to agree`,
  );

  heading('11. The work instruments itself, and the targets say what they rest on');
  const stream = (
    await db.pool.query<{ topic: string; n: number }>(
      'SELECT topic,count(*)::int AS n FROM events GROUP BY topic ORDER BY topic',
    )
  ).rows;
  const topics = stream.map((row) => row.topic);
  for (const expected of [
    'campaign.published',
    'assignment.claimed',
    'run.started',
    'evidence.submitted',
    'reproduction.outcome',
    'decision.accepted',
    'resource.settled',
    'payout.included',
    'payout.finalized',
  ])
    assert.ok(topics.includes(expected), `${expected} was never recorded`);
  note('events', `${stream.length} topics recorded: ${topics.join(', ')}`);
  const leaked = await db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM events
    WHERE payload::text ~* '(trun_|trh_|trp_|Bearer )'`,
  );
  assert.equal(leaked.rows[0].n, 0);
  note('no credentials in the stream', 'no event payload carries a grant, a key or a bearer token');
  const targets = await transaction(db.pool, (client) => pilotMetrics(client, workspaceId));
  assert.equal(targets.length, 8);
  for (const target of targets)
    if (!target.complete) assert.ok(target.missing.length > 0, `${target.id} must say why`);
  note(
    'targets',
    targets
      .map((target) => `${target.id}=${target.complete ? (target.value ?? 'none') : 'no input'}`)
      .join(', '),
  );

  heading('12. The builder sees what is waiting and exports the record');
  const queue = await workspaceAttention(db.pool, owner, workspaceId);
  const queued = queue.campaigns.find((row) => row.id === discovery.campaign.campaignId);
  note(
    'queue',
    `${queue.totals.awaitingDecision} submission(s) awaiting a decision, ${queue.totals.blockedPayouts} blocked payout(s), ${queue.totals.resourcesUnreconciled} resource reservation(s) held, ${queue.totals.owedUnits} base units owed`,
  );
  assert.ok(queued);
  const reviewerQueue = await workspaceAttention(db.pool, reviewer, workspaceId);
  assert.equal(reviewerQueue.campaigns.length, queue.campaigns.length);
  note('reviewer', 'a reviewer reads the same queue, and the read is recorded');

  const archive = await campaignExport(
    db.pool,
    owner,
    workspaceId,
    projectId,
    discovery.campaign.campaignId,
  );
  const files = unzipSync(archive.bytes);
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  const { contentHash, ...body } = manifest;
  assert.equal(contentHash, createHash('sha256').update(canonicalJson(body)).digest('hex'));
  const everything = Object.values(files)
    .map((bytes) => strFromU8(bytes))
    .join('\n');
  assert.ok(!everything.includes('abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(!Object.keys(files).includes('artifacts/replay.trace.zip'));
  await writeFile(resolve(directory, archive.filename), archive.bytes, { mode: 0o600 });
  note(
    'export',
    `${Object.keys(files).length} files, hash ${contentHash.slice(0, 12)} verified from the file itself, no raw archive and no leaked credential`,
  );

  heading('13. The ledger still replays, and what is owed is visible');
  const final = await campaignAccounting(db.pool, discovery.campaign.campaignId);
  assert.equal(final?.reconciled, true);
  const repairLedger = await campaignAccounting(db.pool, repair.campaign.campaignId);
  assert.equal(repairLedger?.reconciled, true);
  const held = await transaction(db.pool, (client) =>
    outstandingCommitment(client, buying.assignment.assignmentId),
  );
  note(
    'accounting',
    `every entry replays to the stored balances; ${final?.acceptedUnits} base units accepted and unpaid, ${final?.finalizedUnits} finalized, ${held.resource} still reserved for resources`,
  );
  const openPayables = (
    await db.pool.query(
      "SELECT state,count(*)::int AS n FROM payables WHERE state<>'finalized' GROUP BY state ORDER BY state",
    )
  ).rows;
  note(
    'what is owed',
    openPayables.map((row) => `${row.n} ${row.state}`).join(', ') || 'nothing outstanding',
  );

  const summary = {
    schemaVersion: 1,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    steps: transcript.length,
    phases: [...new Set(transcript.map((entry) => entry.phase))],
    export: archive.filename,
    exportHash: contentHash,
    accounting: {
      discovery: final,
      repair: repairLedger,
    },
    openPayables,
    limits: [
      'Evidence is produced by this harness, not by a hosted sandboxed runner.',
      'No funded payment authority is configured: the truthful end state is an owed, blocked payable, and finality here is a recording fixture.',
      'No resource wallet is configured: the provider is a fixture and nothing was bought.',
      'The loop drives the server modules directly; the HTTP surface is covered by the browser checks.',
    ],
  };
  await writeFile(
    resolve(directory, 'transcript.json'),
    `${JSON.stringify({ summary, transcript }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  console.log(`\nArtifacts: ${directory}`);
  console.log(`Steps recorded: ${transcript.length}`);
} catch (error) {
  console.error('\nThe loop stopped:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.close();
}
