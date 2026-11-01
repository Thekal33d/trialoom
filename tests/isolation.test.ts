import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { decide, ledger, type Observation, originOf, startProxy } from '../runners/egress-proxy.ts';
import { AppError } from '../src/domain/errors.ts';
import type { Actor } from '../src/server/access.ts';
import { type AgentSession, authenticateAgent } from '../src/server/agents.ts';
import { claim, publishCampaign, releaseAssignment } from '../src/server/assignments.ts';
import { transaction } from '../src/server/database.ts';
import { storeArtifact, submitEvidence } from '../src/server/evidence.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import {
  authenticateHost,
  hostContract,
  hostRunView,
  recordEgress,
  registerHost,
  revokeHost,
  runIsolation,
  verifyEgress,
  workspaceHosts,
} from '../src/server/isolation.ts';
import { migrate } from '../src/server/migrations.ts';
import { createCredential, registerOperator } from '../src/server/operators.ts';
import { addBuild, createCampaign, createProject } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import { abandonRun, authenticateRun, isolationProfile, startRun } from '../src/server/runner.ts';
import { digestOf } from '../src/server/storage.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let owner: Actor;
let workspaceId: string, projectId: string, buildId: string, evidenceDir: string;
const password = randomBytes(24).toString('base64url');
const code = (name: string) => (error: unknown) => error instanceof AppError && error.code === name;
const target = 'https://preview.example.com/';
const allowed = 'https://preview.example.com';
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
const conforming = {
  name: 'Sandboxed host',
  contractVersion: 'runner-host-v1' as const,
  sandbox: 'gvisor' as const,
  egressEnforced: true,
  ephemeralFilesystem: true,
  isolationLevel: 'witnessed' as const,
  contractAccepted: true as const,
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
    scopes: ['work:read', 'assignments:read', 'assignments:claim', 'runs:execute'],
    expiresInDays: 7,
  });
  return { actor, operator, session: await authenticateAgent(db.pool, credential.secret) };
}
/** Claims, starts a run on the named host, and uploads the usual evidence. */
async function runOn(session: AgentSession, campaignId: string, hostId?: string) {
  const assignment = await claim(db.pool, session, { campaignId });
  const run = await startRun(
    db.pool,
    session,
    assignment.assignmentId,
    { attemptToken: assignment.attemptToken, ...(hostId ? { hostId } : {}) },
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
  return {
    assignment,
    run,
    grant,
    document(origins: string[]) {
      const now = new Date().toISOString();
      return {
        schemaVersion: 1,
        campaignId: assignment.campaignId,
        assignmentId: assignment.assignmentId,
        termsVersionId: assignment.termsVersionId,
        termsContentHash: '',
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
        observedOrigins: origins,
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
          { name: 'assertions.json', sha256: digestOf(assertions) },
        ],
      };
    },
  };
}
const witness = async (credential: string, runId: string, batch: number, observations: unknown[]) =>
  recordEgress(db.pool, await authenticateHost(db.pool, credential), runId, {
    batch,
    observations,
  });
const seen = (origin: string, decision: 'allowed' | 'denied', requests = 1) => ({
  origin,
  decision,
  requests,
  firstSeenAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
});

before(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), 'trialoom-isolation-'));
  process.env.TRIALOOM_EVIDENCE_DIR = evidenceDir;
  db = await disposableDatabase();
  await migrate(db.pool);
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Isolation workspace',
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
      name: 'Isolation preview project',
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

test('a host cannot claim the witnessed level without implementing it', async () => {
  // The contract is published rather than implied.
  assert.equal(hostContract.version, 'runner-host-v1');
  assert.ok(hostContract.requirements.length >= 6);
  assert.ok(hostContract.stillAttested.length >= 1, 'what is still asserted is named');
  await assert.rejects(
    registerHost(db.pool, owner, workspaceId, {
      ...conforming,
      name: 'Unenforced host',
      egressEnforced: false,
    }),
    code('CONTRACT_INCOHERENT'),
  );
  await assert.rejects(
    registerHost(db.pool, owner, workspaceId, {
      ...conforming,
      name: 'No sandbox',
      sandbox: 'none',
    }),
    code('CONTRACT_INCOHERENT'),
  );
  // An attested host is allowed to say so plainly; that is the honest claim.
  const attested = await registerHost(db.pool, owner, workspaceId, {
    ...conforming,
    name: 'Local harness',
    sandbox: 'none',
    egressEnforced: false,
    ephemeralFilesystem: false,
    isolationLevel: 'attested',
  });
  assert.equal(attested.isolationLevel, 'attested');
  assert.match(attested.credential, /^trh_/);
  // Only an owner admits a host, because it decides where customer code runs.
  const operator = await qualifiedOperator('iso-outsider');
  await assert.rejects(
    registerHost(db.pool, operator.actor, workspaceId, conforming),
    code('ACCESS_DENIED'),
  );
});

test('terms requiring a witness refuse an unwitnessed run', async () => {
  const campaign = await newCampaign('Witnessed', { minimumIsolation: 'witnessed' });
  const operator = await qualifiedOperator('iso-required');
  const assignment = await claim(db.pool, operator.session, { campaignId: campaign.campaignId });
  const start = (hostId?: string) =>
    startRun(
      db.pool,
      operator.session,
      assignment.assignmentId,
      { attemptToken: assignment.attemptToken, ...(hostId ? { hostId } : {}) },
      { resolver: publicDns, probe: settledProbe },
    );
  // No host named at all.
  await assert.rejects(start(), code('ISOLATION_REQUIRED'));
  // A host that only attests cannot satisfy terms that demand a witness.
  const weak = await registerHost(db.pool, owner, workspaceId, {
    ...conforming,
    name: 'Attested only',
    sandbox: 'none',
    egressEnforced: false,
    ephemeralFilesystem: false,
    isolationLevel: 'attested',
  });
  await assert.rejects(start(weak.hostId), code('ISOLATION_INSUFFICIENT'));
  const host = await registerHost(db.pool, owner, workspaceId, conforming);
  const run = await start(host.hostId);
  // The level is recorded with the run, not claimed in the evidence later.
  assert.equal(run.isolationLevel, 'witnessed');
  const stored = (
    await db.pool.query('SELECT isolation_level,host_id FROM runs WHERE id=$1', [run.runId])
  ).rows[0];
  assert.equal(stored.isolation_level, 'witnessed');
  assert.equal(stored.host_id, host.hostId);
  assert.equal(run.manifest.requiredIsolation, 'witnessed');
  assert.equal(run.manifest.hostContract.version, 'runner-host-v1');
});

test('a revoked host cannot take new work, and only its own runs', async () => {
  const campaign = await newCampaign('Revoked', { minimumIsolation: 'witnessed' });
  const host = await registerHost(db.pool, owner, workspaceId, { ...conforming, name: 'Retiring' });
  const other = await registerHost(db.pool, owner, workspaceId, { ...conforming, name: 'Other' });
  const operator = await qualifiedOperator('iso-revoked');
  const work = await runOn(operator.session, campaign.campaignId, host.hostId);
  // A host reads only the runs issued to it.
  const view = await hostRunView(
    db.pool,
    await authenticateHost(db.pool, host.credential),
    work.run.runId,
  );
  assert.deepEqual(view.egressAllowlist, [allowed]);
  await assert.rejects(
    hostRunView(db.pool, await authenticateHost(db.pool, other.credential), work.run.runId),
    code('RUN_MISMATCH'),
  );
  await assert.rejects(
    witness(other.credential, work.run.runId, 1, [seen(allowed, 'allowed')]),
    code('RUN_MISMATCH'),
  );
  await revokeHost(db.pool, owner, workspaceId, host.hostId);
  await assert.rejects(authenticateHost(db.pool, host.credential), code('HOST_CREDENTIAL_INVALID'));
  const next = await qualifiedOperator('iso-revoked-next');
  await assert.rejects(
    runOn(next.session, campaign.campaignId, host.hostId),
    code('HOST_UNUSABLE'),
  );
});

test('the witness, not the agent, decides where a run went', async () => {
  const campaign = await newCampaign('Compared', { minimumIsolation: 'witnessed' });
  const host = await registerHost(db.pool, owner, workspaceId, { ...conforming, name: 'Watching' });
  const terms = (
    await db.pool.query('SELECT content_hash FROM terms_versions WHERE campaign_id=$1', [
      campaign.campaignId,
    ])
  ).rows[0];

  // A run whose host reported nothing is refused: the promise of a witness is
  // worth nothing if evidence is accepted without one.
  const silent = await runOn(
    (await qualifiedOperator('iso-silent')).session,
    campaign.campaignId,
    host.hostId,
  );
  await assert.rejects(
    submitEvidence(db.pool, silent.grant, {
      ...silent.document([allowed]),
      termsContentHash: terms.content_hash,
    }),
    code('EGRESS_UNWITNESSED'),
  );

  // A claim the proxy never saw does not describe this run.
  const invented = await runOn(
    (await qualifiedOperator('iso-invented')).session,
    campaign.campaignId,
    host.hostId,
  );
  await witness(host.credential, invented.run.runId, 1, [seen(allowed, 'denied', 2)]);
  await assert.rejects(
    submitEvidence(db.pool, invented.grant, {
      ...invented.document([allowed]),
      termsContentHash: terms.content_hash,
    }),
    code('EGRESS_UNWITNESSED'),
  );
});

test('a run that conceals traffic the proxy saw is refused', async () => {
  // A run manifest publishes exactly one allowed origin today, so the only
  // disagreement reachable end to end is a claim the proxy never saw. The rule
  // that catches the other direction is checked here directly, because it
  // becomes reachable as soon as an allowlist names more than one origin --- a
  // fixture host or an identity provider, say.
  const campaign = await newCampaign('Concealed', { minimumIsolation: 'witnessed' });
  const host = await registerHost(db.pool, owner, workspaceId, { ...conforming, name: 'Counting' });
  const work = await runOn(
    (await qualifiedOperator('iso-conceal')).session,
    campaign.campaignId,
    host.hostId,
  );
  const fixture = 'https://fixtures.example.com';
  await witness(host.credential, work.run.runId, 1, [seen(allowed, 'allowed', 3)]);
  // The witness route refuses to record an allowed origin the manifest forbids,
  // which is why the second observation is written as the record a run with a
  // two-origin allowlist would already hold.
  await db.pool.query(
    `INSERT INTO egress_observations (run_id,host_id,batch,origin,decision,requests,
    first_seen_at,last_seen_at)
    VALUES ($1,$2,2,$3,'allowed',1,clock_timestamp(),clock_timestamp())`,
    [work.run.runId, host.hostId, fixture],
  );
  const run = { id: work.run.runId, host_id: host.hostId, isolation_level: 'witnessed' as const };
  await assert.rejects(
    transaction(db.pool, (client) => verifyEgress(client, run, [allowed], [allowed, fixture])),
    code('EGRESS_CONCEALED'),
  );
  // Declaring both is accepted, and both counts are kept.
  const verified = await transaction(db.pool, (client) =>
    verifyEgress(client, run, [allowed, fixture], [allowed, fixture]),
  );
  assert.deepEqual(verified.allowedOrigins, [fixture, allowed].sort());
  assert.deepEqual(verified.claimedOrigins, [fixture, allowed].sort());
});

test('a host reporting that it allowed a forbidden origin is not enforcing', async () => {
  const campaign = await newCampaign('Notenforced', { minimumIsolation: 'witnessed' });
  const host = await registerHost(db.pool, owner, workspaceId, { ...conforming, name: 'Leaky' });
  const work = await runOn(
    (await qualifiedOperator('iso-leaky')).session,
    campaign.campaignId,
    host.hostId,
  );
  await assert.rejects(
    witness(host.credential, work.run.runId, 1, [seen('https://exfil.example.net', 'allowed')]),
    code('EGRESS_NOT_ENFORCED'),
  );
  // A denial outside the allowlist is exactly what a proxy should report.
  const denial = await witness(host.credential, work.run.runId, 1, [
    seen('https://exfil.example.net', 'denied', 4),
    seen(allowed, 'allowed', 2),
  ]);
  assert.equal(denial.recorded, 2);
  // A batch cannot be rewritten once it is in.
  await assert.rejects(
    witness(host.credential, work.run.runId, 1, [seen(allowed, 'allowed', 99)]),
    code('EGRESS_BATCH_REPLAYED'),
  );
  const record = await runIsolation(db.pool, work.run.runId);
  assert.equal(record?.level, 'witnessed');
  assert.deepEqual(
    record?.observations.map((row) => `${row.decision} ${row.origin} ${row.requests}`).sort(),
    ['allowed https://preview.example.com 2', 'denied https://exfil.example.net 4'],
  );
});

test('a witnessed submission records what the platform checked', async () => {
  const campaign = await newCampaign('Verified', { minimumIsolation: 'witnessed' });
  const host = await registerHost(db.pool, owner, workspaceId, { ...conforming, name: 'Verifier' });
  const terms = (
    await db.pool.query('SELECT content_hash FROM terms_versions WHERE campaign_id=$1', [
      campaign.campaignId,
    ])
  ).rows[0];
  const work = await runOn(
    (await qualifiedOperator('iso-verified')).session,
    campaign.campaignId,
    host.hostId,
  );
  await witness(host.credential, work.run.runId, 1, [
    seen(allowed, 'allowed', 7),
    seen('https://tracker.example.net', 'denied', 2),
  ]);
  const result = await submitEvidence(db.pool, work.grant, {
    ...work.document([allowed]),
    termsContentHash: terms.content_hash,
  });
  assert.equal(result.egress.level, 'witnessed');
  assert.equal(result.egress.witnessed, true);
  assert.deepEqual(result.egress.allowedOrigins, [allowed]);
  assert.deepEqual(result.egress.claimedOrigins, [allowed]);
  // The attempt to leave the allowlist is kept beside the evidence.
  assert.deepEqual(result.egress.deniedOrigins, ['https://tracker.example.net']);
  assert.equal(result.egress.deniedAttempts, 2);
  const stored = (
    await db.pool.query('SELECT egress_verification FROM evidence_submissions WHERE id=$1', [
      result.submissionId,
    ])
  ).rows[0];
  assert.equal(stored.egress_verification.witnessed, true);
  assert.equal(stored.egress_verification.batches, 1);
});

test('an attested run still works and is labelled as only attested', async () => {
  const campaign = await newCampaign('Attested');
  const terms = (
    await db.pool.query('SELECT content_hash FROM terms_versions WHERE campaign_id=$1', [
      campaign.campaignId,
    ])
  ).rows[0];
  const work = await runOn((await qualifiedOperator('iso-attested')).session, campaign.campaignId);
  const result = await submitEvidence(db.pool, work.grant, {
    ...work.document([allowed]),
    termsContentHash: terms.content_hash,
  });
  // No witness exists, and the record says so rather than implying one.
  assert.equal(result.egress.level, 'attested');
  assert.equal(result.egress.witnessed, false);
  assert.equal(result.egress.hostId, null);
  // The allowlist is still enforced against the claim itself.
  const other = await runOn(
    (await qualifiedOperator('iso-attested-two')).session,
    campaign.campaignId,
  );
  await assert.rejects(
    submitEvidence(db.pool, other.grant, {
      ...other.document(['https://exfil.example.net']),
      termsContentHash: terms.content_hash,
    }),
    code('EGRESS_VIOLATION'),
  );
  const hosts = await workspaceHosts(db.pool, owner, workspaceId);
  assert.ok(hosts.hosts.length >= 1);
  assert.equal(hosts.contract.version, 'runner-host-v1');
});

test('lost witness acknowledgements retry exactly once, including after run closure', async () => {
  const campaign = await newCampaign('Retry-safe witness', { minimumIsolation: 'witnessed' });
  const host = await registerHost(db.pool, owner, workspaceId, {
    ...conforming,
    name: 'Retry host',
  });
  const operator = await qualifiedOperator('iso-retry');
  const work = await runOn(operator.session, campaign.campaignId, host.hostId);
  const report = [seen(allowed, 'allowed', 3)];
  const receipts = await Promise.all(
    [1, 2].map(() => witness(host.credential, work.run.runId, 1, report)),
  );
  assert.deepEqual(receipts.map((r) => r.replayed).sort(), [false, true]);
  await witness(host.credential, work.run.runId, 2, [
    { ...seen(allowed, 'denied', 2), origin: null, reason: 'ORIGIN_DENIED' },
  ]);
  const isolation = await runIsolation(db.pool, work.run.runId);
  assert.equal(isolation?.observations.find((row) => row.decision === 'allowed').requests, '3');
  await abandonRun(db.pool, operator.session, work.run.runId, {
    attemptToken: work.assignment.attemptToken,
  });
  assert.equal((await witness(host.credential, work.run.runId, 1, report)).replayed, true);
  await assert.rejects(
    witness(host.credential, work.run.runId, 1, [seen(allowed, 'allowed', 4)]),
    code('EGRESS_BATCH_REPLAYED'),
  );
  await assert.rejects(witness(host.credential, work.run.runId, 3, []), code('RUN_CLOSED'));
});

test('released assignments and revoked hosts stop polling and stale-session writes', async () => {
  for (const mode of ['release', 'revoke', 'expire', 'abandon'] as const) {
    const campaign = await newCampaign(`Permission ${mode}`, { minimumIsolation: 'witnessed' });
    const host = await registerHost(db.pool, owner, workspaceId, {
      ...conforming,
      name: `Permission ${mode}`,
    });
    const operator = await qualifiedOperator(`iso-stop-${mode}`);
    const work = await runOn(operator.session, campaign.campaignId, host.hostId);
    const hostSession = await authenticateHost(db.pool, host.credential);
    let refusal: string;
    if (mode === 'release') {
      await releaseAssignment(db.pool, operator.session, work.assignment.assignmentId, {
        attemptToken: work.assignment.attemptToken,
      });
      refusal = 'ATTEMPT_CLOSED';
    } else if (mode === 'revoke') {
      await revokeHost(db.pool, owner, workspaceId, host.hostId);
      refusal = 'HOST_UNUSABLE';
    } else if (mode === 'expire') {
      await db.pool.query(
        "UPDATE runs SET issued_at=clock_timestamp()-interval '2 seconds',grant_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [work.run.runId],
      );
      refusal = 'RUN_EXPIRED';
    } else {
      await abandonRun(db.pool, operator.session, work.run.runId, {
        attemptToken: work.assignment.attemptToken,
      });
      refusal = 'RUN_CLOSED';
    }
    await assert.rejects(authenticateRun(db.pool, work.run.runToken), code(refusal));
    await assert.rejects(hostRunView(db.pool, hostSession, work.run.runId), code(refusal));
    await assert.rejects(
      recordEgress(db.pool, hostSession, work.run.runId, { batch: 1, observations: [] }),
      code(refusal),
    );
    const bytes = Buffer.from('stale permission artifact');
    await assert.rejects(
      storeArtifact(
        db.pool,
        work.grant,
        { name: 'late.md', kind: 'report', sha256: digestOf(bytes) },
        'text/markdown',
        bytes,
      ),
      code(refusal),
    );
    await assert.rejects(
      submitEvidence(db.pool, work.grant, {
        ...work.document([allowed]),
        termsContentHash: work.run.manifest.binding.termsContentHash,
      }),
      code(refusal),
    );
  }
});

test('the reference proxy denies what the allowlist forbids and counts both', async () => {
  assert.equal(decide([allowed], allowed), 'allowed');
  assert.equal(decide([allowed], 'https://exfil.example.net'), 'denied');
  // A CONNECT tunnel carries host and port, never a path.
  assert.equal(originOf('preview.example.com:443', true), 'https://preview.example.com');
  assert.equal(
    originOf('http://preview.example.com/journey', false),
    'https://preview.example.com'.replace('https', 'http'),
  );
  const book = ledger();
  book.record(allowed, 'allowed');
  book.record(allowed, 'allowed');
  book.record('https://exfil.example.net', 'denied');
  const batch = book.drain();
  assert.equal(batch.length, 2);
  assert.equal(batch.find((row) => row.decision === 'allowed')?.requests, 2);
  assert.equal(book.size, 0, 'a drained batch is not reported twice');

  // A real proxied request. A client sends an HTTP proxy an absolute-form
  // request line, which fetch does not do, so this speaks the protocol
  // directly: one allowed destination is relayed and one forbidden one is not.
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('fixture');
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const port = (upstream.address() as { port: number }).port;
  const reported: Observation[] = [];
  const proxy = await startProxy({
    allowlist: [`http://127.0.0.1:${port}`],
    report: async (observations) => {
      reported.push(...observations);
    },
    reportEveryMs: 60_000,
  });
  const through = (target: string) =>
    new Promise<string>((done, fail) => {
      const socket = createConnection({ host: '127.0.0.1', port: proxy.port }, () => {
        socket.write(
          `GET ${target} HTTP/1.1\r\nHost: ${new URL(target).host}\r\nConnection: close\r\n\r\n`,
        );
      });
      let answer = '';
      socket.setTimeout(5000, () => fail(new Error('the proxy did not answer')));
      socket.on('data', (chunk) => {
        answer += chunk.toString();
      });
      socket.on('end', () => done(answer));
      socket.on('error', fail);
    });
  try {
    const permitted = await through(`http://127.0.0.1:${port}/journey`);
    assert.match(permitted, /^HTTP\/1\.1 200/);
    assert.match(permitted, /fixture/);
    // A forbidden origin is refused by the proxy; the upstream is never reached.
    const refused = await through('http://127.0.0.1:1/exfil');
    assert.match(refused, /^HTTP\/1\.1 403/);
    await proxy.flush();
  } finally {
    await proxy.stop();
    await new Promise<void>((done) => upstream.close(() => done()));
  }
  // Both decisions reach the platform, so a denial is evidence rather than a
  // line in a log the operator controls.
  assert.deepEqual(
    reported.map((row) => `${row.decision} ${row.origin}`).sort(),
    [`allowed http://127.0.0.1:${port}`, 'denied http://127.0.0.1:1'].sort(),
  );
});
