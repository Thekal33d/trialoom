import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { AppError } from '../src/domain/errors.ts';
import type { Actor } from '../src/server/access.ts';
import { type AgentSession, authenticateAgent } from '../src/server/agents.ts';
import {
  claim,
  heartbeatAssignment,
  publishCampaign,
  sweepExpiredAssignments,
} from '../src/server/assignments.ts';
import {
  campaignSubmissions,
  readArtifact,
  storeArtifact,
  submitEvidence,
} from '../src/server/evidence.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { campaignAccounting } from '../src/server/ledger.ts';
import { migrate } from '../src/server/migrations.ts';
import { createCredential, registerOperator } from '../src/server/operators.ts';
import { addBuild, createCampaign, createProject } from '../src/server/projects.ts';
import { submitAttempt } from '../src/server/qualification.ts';
import { redactText, scanText } from '../src/server/redaction.ts';
import {
  abandonRun,
  authenticateRun,
  isolationProfile,
  type ProbeTarget,
  type RunSession,
  revalidateTarget,
  runLimits,
  startRun,
} from '../src/server/runner.ts';
import { digestOf } from '../src/server/storage.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let owner: Actor, reviewer: Actor;
let workspaceId: string, projectId: string, buildId: string, evidenceDir: string;
const password = randomBytes(24).toString('base64url');
const code = (name: string) => (error: unknown) => error instanceof AppError && error.code === name;
const scopes = [
  'work:read',
  'qualification:submit',
  'assignments:read',
  'assignments:claim',
  'runs:execute',
];
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
const target = 'https://preview.example.com/';
const origin = 'https://preview.example.com';
const publicDns = async () => ['93.184.215.14'];
const buildRow = {
  target_url: target,
  revision: 'baseline-1',
  admission_addresses: ['93.184.215.14'],
};
const projectRow = { authorized_origin: origin };
const settled =
  (status = 200, revision: string | null = 'baseline-1'): ProbeTarget =>
  async () => ({
    status,
    location: null,
    revision,
  });

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
type Claimed = Awaited<ReturnType<typeof claim>> & { contentHash: string };
async function claimed(
  handle: string,
  overrides: Record<string, unknown> = {},
): Promise<{
  session: AgentSession;
  assignment: Claimed;
}> {
  const session = await qualifiedOperator(handle);
  const campaign = await createCampaign(db.pool, owner, workspaceId, projectId, {
    name: `Campaign ${handle}`,
    terms: termsInput(overrides),
  });
  await publishCampaign(db.pool, owner, workspaceId, projectId, campaign.campaignId, {
    termsVersionId: campaign.id,
    slots: 2,
    maxConcurrent: 2,
    authorizeUnits: '20000000',
    spendingAuthorization: 'remesso-policy-local-fixture',
    authorizationConfirmed: true,
  });
  const assignment = await claim(db.pool, session, { campaignId: campaign.campaignId });
  return { session, assignment: { ...assignment, contentHash: campaign.contentHash } };
}
async function runFor(handle: string, probe: ProbeTarget = settled()) {
  const { session, assignment } = await claimed(handle);
  const run = await startRun(
    db.pool,
    session,
    assignment.assignmentId,
    { attemptToken: assignment.attemptToken },
    { resolver: publicDns, probe },
  );
  return { session, assignment, run, grant: await authenticateRun(db.pool, run.runToken) };
}
async function upload(
  grant: RunSession,
  name: string,
  kind: string,
  mediaType: string,
  body: string | Uint8Array,
) {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return storeArtifact(db.pool, grant, { name, kind, sha256: digestOf(bytes) }, mediaType, bytes);
}
/** Invalid UTF-8 on purpose: an archive is not text this policy can clean. */
const archiveBytes = () =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0xff, 0xfe]), randomBytes(32)]);
async function completeEvidence(grant: RunSession) {
  await upload(grant, 'replay.trace.zip', 'trace', 'application/zip', archiveBytes());
  await upload(
    grant,
    'assertions.json',
    'assertions',
    'application/json',
    JSON.stringify({ invitationAccepted: false }),
  );
}
function evidenceFor(assignment: Claimed, overrides: Record<string, unknown> = {}) {
  const finishedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    campaignId: assignment.campaignId,
    assignmentId: assignment.assignmentId,
    termsVersionId: assignment.termsVersionId,
    termsContentHash: assignment.contentHash,
    build: {
      id: assignment.buildId,
      revision: 'baseline-1',
      fixtureVersion: 'invitation-1',
      targetUrl: target,
    },
    environment: 'preview',
    agent: {
      runtime: 'node 24.19.2',
      browser: 'chromium 141',
      viewport: '1280x800',
      configurationHash: 'a'.repeat(64),
    },
    isolation: isolationProfile,
    startedAt: finishedAt,
    finishedAt,
    observedOrigins: [origin],
    steps: [
      {
        index: 1,
        action: 'Invite teammate+qa@example.test',
        expected: 'Invitation created',
        actual: 'Rejected with 400',
        status: 'failed',
      },
    ],
    assertions: [{ name: 'invitation.create', passed: false, detail: 'Expected 201, saw 400' }],
    outcome: 'product_failed',
    summary: 'The seeded validator rejects a plus alias on the pinned build.',
    artifacts: [
      { name: 'replay.trace.zip', sha256: '' },
      { name: 'assertions.json', sha256: '' },
    ],
    ...overrides,
  };
}
async function declared<T extends Record<string, unknown>>(grant: RunSession, document: T) {
  const stored = (
    await db.pool.query<{ name: string; sha256: string }>(
      'SELECT name,sha256 FROM evidence_artifacts WHERE run_id=$1 ORDER BY created_at',
      [grant.run.id],
    )
  ).rows;
  return {
    ...document,
    artifacts: stored.map((row) => ({ name: row.name, sha256: row.sha256 })),
  };
}

before(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), 'trialoom-evidence-'));
  process.env.TRIALOOM_EVIDENCE_DIR = evidenceDir;
  db = await disposableDatabase();
  await migrate(db.pool);
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Runner workspace',
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
  await acceptInvitation(db.pool, { token: invite.token, name: 'Reviewer', password }, null);
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
      name: 'Runner preview project',
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

test('a redirect off the approved origin is refused at execution time', async () => {
  const hops: ProbeTarget = async (url) =>
    url === target
      ? { status: 302, location: 'https://attacker.example.net/', revision: null }
      : { status: 200, location: null, revision: null };
  await assert.rejects(
    revalidateTarget(buildRow, projectRow, { resolver: publicDns, probe: hops }),
    code('TARGET_REDIRECTED'),
  );
});

test('a redirect inside the approved origin is followed and every hop recorded', async () => {
  const hops: ProbeTarget = async (url) =>
    url === target
      ? { status: 307, location: '/app/', revision: null }
      : { status: 200, location: null, revision: null };
  const check = await revalidateTarget(buildRow, projectRow, { resolver: publicDns, probe: hops });
  assert.deepEqual(
    check.hops.map((hop) => hop.status),
    [307, 200],
  );
  assert.equal(check.finalUrl, 'https://preview.example.com/app/');
  // A target that exposes no revision is never recorded as a confirmed match.
  assert.equal(check.revision, null);
  assert.equal(check.revisionConfirmed, false);
});

test('an endless redirect stops at the hop limit', async () => {
  const loop: ProbeTarget = async () => ({ status: 302, location: '/next/', revision: null });
  await assert.rejects(
    revalidateTarget(buildRow, projectRow, { resolver: publicDns, probe: loop }),
    code('TARGET_REDIRECT_LOOP'),
  );
});

test('a target that no longer resolves to an admitted address is refused', async () => {
  await assert.rejects(
    revalidateTarget(buildRow, projectRow, {
      resolver: async () => ['93.184.216.34'],
      probe: settled(),
    }),
    code('TARGET_REBOUND'),
  );
});

test('a target that resolves into private space is refused before any probe', async () => {
  let probed = 0;
  await assert.rejects(
    revalidateTarget(buildRow, projectRow, {
      resolver: async () => ['10.0.0.5'],
      probe: async () => {
        probed += 1;
        return { status: 200, location: null, revision: null };
      },
    }),
    code('TARGET_PRIVATE'),
  );
  assert.equal(probed, 0);
});

test('a target reporting a different revision refuses the run', async () => {
  await assert.rejects(
    revalidateTarget(buildRow, projectRow, {
      resolver: publicDns,
      probe: settled(200, 'baseline-2'),
    }),
    code('BUILD_MISMATCH'),
  );
  const matched = await revalidateTarget(buildRow, projectRow, {
    resolver: publicDns,
    probe: settled(200, 'baseline-1'),
  });
  assert.equal(matched.revisionConfirmed, true);
});

test('a failing target is recorded unhealthy rather than judged a product defect', async () => {
  const check = await revalidateTarget(buildRow, projectRow, {
    resolver: publicDns,
    probe: settled(503, null),
  });
  assert.equal(check.targetHealthy, false);
  assert.equal(check.policy, 'target-revalidation-v1');
});

test('a run grant is scoped to one run, expires with the lease, and signs nothing', async () => {
  const { assignment, run, grant } = await runFor('runner-scope');
  assert.match(run.runToken, /^trun_[A-Za-z0-9_-]{20,}$/);
  assert.equal(run.manifest.payoutSigning, 'never_delegated');
  assert.equal(run.manifest.grant.scope, 'evidence:submit');
  assert.deepEqual(run.manifest.egressAllowlist, [origin]);
  assert.equal(grant.run.grant_scope, 'evidence:submit');
  // The grant never outlives the lease that justifies it.
  assert.equal(
    new Date(grant.run.grant_expires_at).getTime(),
    new Date(assignment.leaseExpiresAt).getTime(),
  );
  assert.ok(new Date(grant.run.grant_expires_at) <= new Date(assignment.deadline));
  const stored = (await db.pool.query('SELECT grant_hash FROM runs WHERE id=$1', [run.runId]))
    .rows[0];
  // Only the digest is kept; the token itself is never stored.
  assert.notEqual(stored.grant_hash, run.runToken);
  assert.equal(stored.grant_hash, digestOf(Buffer.from(run.runToken, 'utf8')));
  const scopeRule = (
    await db.pool.query(
      `SELECT pg_get_constraintdef(oid) AS rule FROM pg_constraint
      WHERE conname='agent_credentials_scopes_check'`,
    )
  ).rows[0].rule as string;
  // No scope in the allowlist can sign a payout, name a recipient, or pay an
  // operator: each one reads, submits work, claims work, or runs it, and none
  // names a wallet, a signer or a transfer.
  const scopes = [...scopeRule.matchAll(/'([a-z]+:[a-z]+)'/g)].map((match) => match[1]);
  assert.ok(scopes.length >= 10);
  assert.ok(!/\b(wallet\w*|signer|sign|transfer\w*|send|settle\w*|withdraw\w*)\b/i.test(scopeRule));
  assert.ok(scopes.includes('runs:execute'));
  // One scope spends: a resource purchase, capped by the allowance the builder
  // published and funded by the platform's own wallet toward a payee the
  // platform validated. Every other scope's verb only reads or does work.
  assert.deepEqual(
    scopes.filter((scope) => !/^[a-z]+:(read|submit|claim|execute)$/.test(scope)),
    ['resources:purchase'],
  );
});

test('an agent credential cannot authenticate as a run grant', async () => {
  const { session } = await runFor('runner-credential');
  await assert.rejects(authenticateRun(db.pool, session.credential.id), code('RUN_GRANT_INVALID'));
  await assert.rejects(
    authenticateRun(db.pool, `trun_${randomBytes(32).toString('base64url')}`),
    code('RUN_GRANT_INVALID'),
  );
});

test('one live run per assignment, and abandoning releases the slot', async () => {
  const { session, assignment, run } = await runFor('runner-single');
  await assert.rejects(
    startRun(
      db.pool,
      session,
      assignment.assignmentId,
      { attemptToken: assignment.attemptToken },
      { resolver: publicDns, probe: settled() },
    ),
    code('RUN_IN_PROGRESS'),
  );
  const abandoned = await abandonRun(db.pool, session, run.runId, {
    attemptToken: assignment.attemptToken,
  });
  assert.equal(abandoned.state, 'abandoned');
  const second = await startRun(
    db.pool,
    session,
    assignment.assignmentId,
    { attemptToken: assignment.attemptToken },
    { resolver: publicDns, probe: settled() },
  );
  assert.notEqual(second.runId, run.runId);
  // The abandoned grant is dead; the assignment kept its lease and reservation.
  await assert.rejects(authenticateRun(db.pool, run.runToken), code('RUN_CLOSED'));
  const assignmentState = (
    await db.pool.query('SELECT state FROM assignments WHERE id=$1', [assignment.assignmentId])
  ).rows[0].state;
  assert.equal(assignmentState, 'claimed');
});

test('a run cannot start without enough lease left to use it', async () => {
  const { session, assignment } = await claimed('runner-shortlease');
  await db.pool.query(
    `UPDATE assignments SET lease_expires_at=clock_timestamp()+interval '20 seconds' WHERE id=$1`,
    [assignment.assignmentId],
  );
  await assert.rejects(
    startRun(
      db.pool,
      session,
      assignment.assignmentId,
      { attemptToken: assignment.attemptToken },
      { resolver: publicDns, probe: settled() },
    ),
    code('LEASE_TOO_SHORT'),
  );
});

test('a stale attempt token cannot start a run', async () => {
  const { session, assignment } = await claimed('runner-stale');
  await assert.rejects(
    startRun(
      db.pool,
      session,
      assignment.assignmentId,
      { attemptToken: crypto.randomUUID() },
      { resolver: publicDns, probe: settled() },
    ),
    code('STALE_ATTEMPT'),
  );
});

test('a lapsed lease retires the run grant and returns the reservation', async () => {
  const { assignment, run } = await runFor('runner-expiry');
  const before = await db.pool.query(
    'SELECT committed_units FROM campaign_accounts WHERE campaign_id=$1',
    [assignment.campaignId],
  );
  assert.notEqual(before.rows[0].committed_units, '0');
  await db.pool.query(
    `UPDATE assignments SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [assignment.assignmentId],
  );
  assert.equal(await sweepExpiredAssignments(db.pool), 1);
  const closed = (
    await db.pool.query('SELECT state,closed_reason FROM runs WHERE id=$1', [run.runId])
  ).rows[0];
  assert.equal(closed.state, 'expired');
  await assert.rejects(authenticateRun(db.pool, run.runToken), code('RUN_CLOSED'));
  const after = await db.pool.query(
    'SELECT committed_units FROM campaign_accounts WHERE campaign_id=$1',
    [assignment.campaignId],
  );
  assert.equal(after.rows[0].committed_units, '0');
});

test('a heartbeat extends the grant with the lease and never past the deadline', async () => {
  const { session, assignment, run, grant } = await runFor('runner-heartbeat');
  const beat = await heartbeatAssignment(db.pool, session, assignment.assignmentId, {
    attemptToken: assignment.attemptToken,
  });
  const extended = (
    await db.pool.query('SELECT grant_expires_at FROM runs WHERE id=$1', [run.runId])
  ).rows[0];
  assert.equal(
    new Date(extended.grant_expires_at).getTime(),
    new Date(beat.leaseExpiresAt).getTime(),
  );
  assert.ok(new Date(extended.grant_expires_at) > new Date(grant.run.grant_expires_at));
  assert.ok(new Date(extended.grant_expires_at) <= new Date(assignment.deadline));
});

test('the redaction policy clears known secret shapes and never re-flags its own output', () => {
  const raw = [
    'authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    'set-cookie: session=9f8e7d6c5b4a; Path=/',
    '{"password":"hunter2hunter2","apiKey":"k-1234567890abcdef"}',
    'operator teammate+qa@example.test asked for help',
    // A deliberately synthetic key-shaped value, not a real key.
    `key 0x${'deadbeef'.repeat(8)}`,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.Ry2bQOXrOaMQX1nNSA1JNlQ8eDbmYkKqIiHhB6Hgnp0',
    'trun_wZr6qkDQv8sSpOcB6nFhVhKxqJZ0t2m9aYbQ3cEdFgI',
    'https://admin:s3cret@preview.example.com/',
    '/Users/builder/private/trace.zip',
    '-----BEGIN EC PRIVATE KEY-----\nnot-a-key\n-----END EC PRIVATE KEY-----',
  ].join('\n');
  const first = redactText(raw, ['literal-shared-secret']);
  assert.ok(!first.text.includes('hunter2hunter2'));
  assert.ok(!first.text.includes('teammate+qa@example.test'));
  assert.ok(!first.text.includes('trun_wZr6qkDQv8sSpOcB6nFhVhKxqJZ0t2m9aYbQ3cEdFgI'));
  assert.ok(!first.text.includes('/Users/builder'));
  assert.ok(first.text.includes('[REDACTED:'));
  // Verification of the redacted copy must come back clean, not flag placeholders.
  assert.deepEqual(scanText(first.text), {});
  const literal = redactText('the value literal-shared-secret appears', ['literal-shared-secret']);
  assert.equal(literal.findings.known_secret, 1);
  assert.deepEqual(scanText(literal.text, ['literal-shared-secret']), {});
});

test('text evidence is redacted and only the redacted copy is readable', async () => {
  const { assignment, grant } = await runFor('runner-redaction');
  const report = JSON.stringify({
    note: 'Replayed with authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    reporter: 'teammate+qa@example.test',
  });
  const stored = await upload(grant, 'report.json', 'report', 'application/json', report);
  assert.equal(stored.reviewable, true);
  assert.equal((stored.redaction as { mode: string }).mode, 'text');
  const row = (
    await db.pool.query(
      'SELECT storage_key,redacted_key FROM evidence_artifacts WHERE run_id=$1 AND name=$2',
      [grant.run.id, 'report.json'],
    )
  ).rows[0];
  // The raw bytes are kept under a different key and are never what a reader gets.
  assert.notEqual(row.storage_key, row.redacted_key);
  assert.equal(row.storage_key, digestOf(Buffer.from(report, 'utf8')));
  await completeEvidence(grant);
  const document = await declared(grant, evidenceFor(assignment));
  await submitEvidence(db.pool, grant, document);
  const served = await readArtifact(
    db.pool,
    owner,
    workspaceId,
    projectId,
    assignment.campaignId,
    (
      await db.pool.query('SELECT id FROM evidence_artifacts WHERE run_id=$1 AND name=$2', [
        grant.run.id,
        'report.json',
      ])
    ).rows[0].id,
  );
  const text = served.bytes.toString('utf8');
  assert.ok(!text.includes('abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(!text.includes('teammate+qa@example.test'));
  assert.ok(text.includes('[REDACTED:'));
});

test('archived evidence is stored private and refused to readers', async () => {
  const { assignment, grant } = await runFor('runner-binary');
  const stored = await upload(
    grant,
    'replay.trace.zip',
    'trace',
    'application/zip',
    archiveBytes(),
  );
  assert.equal(stored.reviewable, false);
  assert.equal((stored.redaction as { decision: string }).decision, 'private_only');
  const id = (
    await db.pool.query('SELECT id FROM evidence_artifacts WHERE run_id=$1', [grant.run.id])
  ).rows[0].id;
  await assert.rejects(
    readArtifact(db.pool, owner, workspaceId, projectId, assignment.campaignId, id),
    code('ARTIFACT_PRIVATE'),
  );
});

test('artifact uploads refuse corrupt bytes, wrong media types, and duplicates', async () => {
  const { grant } = await runFor('runner-artifacts');
  const bytes = Buffer.from('step log', 'utf8');
  await assert.rejects(
    storeArtifact(
      db.pool,
      grant,
      { name: 'log.txt', kind: 'log', sha256: 'b'.repeat(64) },
      'text/plain',
      bytes,
    ),
    code('ARTIFACT_CORRUPT'),
  );
  await assert.rejects(
    upload(grant, 'log.txt', 'log', 'application/json', bytes),
    code('MEDIA_TYPE_REJECTED'),
  );
  await assert.rejects(upload(grant, 'log.txt', 'log', 'text/plain', ''), code('ARTIFACT_EMPTY'));
  await assert.rejects(
    upload(
      grant,
      'big.txt',
      'log',
      'text/plain',
      Buffer.alloc(runLimits.maxArtifactBytes + 1, 0x61),
    ),
    code('ARTIFACT_TOO_LARGE'),
  );
  await upload(grant, 'log.txt', 'log', 'text/plain', bytes);
  await assert.rejects(
    upload(grant, 'log.txt', 'log', 'text/plain', 'different bytes'),
    code('ARTIFACT_DUPLICATE'),
  );
  // The same bytes under another name are the same artifact.
  await assert.rejects(
    upload(grant, 'copy.txt', 'log', 'text/plain', bytes),
    code('ARTIFACT_DUPLICATE'),
  );
});

test('a run cannot exceed its issued artifact count', async () => {
  const { grant } = await runFor('runner-count');
  for (let index = 0; index < runLimits.maxArtifacts; index += 1)
    await upload(grant, `log-${index}.txt`, 'log', 'text/plain', `entry ${index}`);
  await assert.rejects(
    upload(grant, 'one-more.txt', 'log', 'text/plain', 'overflow'),
    code('TOO_MANY_ARTIFACTS'),
  );
  const usage = (await db.pool.query('SELECT artifact_count FROM runs WHERE id=$1', [grant.run.id]))
    .rows[0];
  assert.equal(usage.artifact_count, runLimits.maxArtifacts);
});

test('a submission restating different identities is refused and the reason names the field', async () => {
  const { assignment, grant } = await runFor('runner-identity');
  await completeEvidence(grant);
  const base = await declared(grant, evidenceFor(assignment));
  await assert.rejects(
    submitEvidence(db.pool, grant, { ...base, campaignId: crypto.randomUUID() }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'IDENTITY_MISMATCH' &&
      error.message.includes('campaign'),
  );
  await assert.rejects(
    submitEvidence(db.pool, grant, { ...base, termsContentHash: 'c'.repeat(64) }),
    code('TERMS_MISMATCH'),
  );
  await assert.rejects(
    submitEvidence(db.pool, grant, {
      ...base,
      build: { ...base.build, revision: 'baseline-2' },
    }),
    code('BUILD_MISMATCH'),
  );
  await assert.rejects(
    submitEvidence(db.pool, grant, { ...base, environment: 'staging' }),
    code('IDENTITY_MISMATCH'),
  );
  await assert.rejects(
    submitEvidence(db.pool, grant, {
      ...base,
      isolation: { ...isolationProfile, clearedStorage: true, ephemeralProfile: true },
      observedOrigins: [origin, 'https://cdn.example.net/'],
    }),
    code('EGRESS_VIOLATION'),
  );
});

test('a submission outside its issued time budget is refused', async () => {
  const { assignment, grant } = await runFor('runner-timing');
  await completeEvidence(grant);
  const base = await declared(grant, evidenceFor(assignment));
  await assert.rejects(
    submitEvidence(db.pool, grant, {
      ...base,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    }),
    code('TIMESTAMPS_INVALID'),
  );
  // The budget comes from the manifest this run was issued, not from a constant.
  await db.pool.query(
    `UPDATE runs SET manifest=jsonb_set(manifest,'{limits,wallClockSeconds}','1') WHERE id=$1`,
    [grant.run.id],
  );
  const issued = new Date(grant.run.issued_at).getTime();
  await assert.rejects(
    submitEvidence(db.pool, await authenticateRun(db.pool, grant.secret), {
      ...base,
      startedAt: new Date(issued).toISOString(),
      finishedAt: new Date(issued + 2000).toISOString(),
    }),
    code('TIMEOUT_EXCEEDED'),
  );
});

test('incomplete evidence and unsupported outcomes are refused', async () => {
  const { assignment, grant } = await runFor('runner-incomplete');
  await upload(grant, 'shot.png', 'screenshot', 'image/png', archiveBytes());
  const screenshotOnly = await declared(grant, evidenceFor(assignment));
  // A screenshot does not establish that a workflow ran.
  await assert.rejects(submitEvidence(db.pool, grant, screenshotOnly), code('EVIDENCE_INCOMPLETE'));
  await completeEvidence(grant);
  const base = await declared(grant, evidenceFor(assignment));
  await assert.rejects(
    submitEvidence(db.pool, grant, { ...base, outcome: 'executed' }),
    code('OUTCOME_UNSUPPORTED'),
  );
  await assert.rejects(
    submitEvidence(db.pool, grant, {
      ...base,
      outcome: 'blocked',
      blockedReason: 'infrastructure_unavailable',
    }),
    code('OUTCOME_UNSUPPORTED'),
  );
  await assert.rejects(
    submitEvidence(db.pool, grant, {
      ...base,
      artifacts: [...base.artifacts, { name: 'absent.json', sha256: 'd'.repeat(64) }],
    }),
    code('ARTIFACT_MISSING'),
  );
  await assert.rejects(
    submitEvidence(db.pool, grant, { ...base, artifacts: [base.artifacts[0]] }),
    code('ARTIFACT_UNDECLARED'),
  );
});

test('an expired claim refuses a submission even from a grant already in hand', async () => {
  const { assignment, grant } = await runFor('runner-expired-claim');
  await completeEvidence(grant);
  const document = await declared(grant, evidenceFor(assignment));
  await db.pool.query(
    `UPDATE assignments SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [assignment.assignmentId],
  );
  await assert.rejects(submitEvidence(db.pool, grant, document), code('CLAIM_EXPIRED'));
});

test('a valid submission records work, holds the reservation, and decides nothing', async () => {
  const { assignment, grant } = await runFor('runner-submit');
  await completeEvidence(grant);
  const document = await declared(grant, evidenceFor(assignment));
  const committedBefore = (await campaignAccounting(db.pool, assignment.campaignId))
    ?.committedUnits;
  const result = await submitEvidence(db.pool, grant, document);
  assert.equal(result.state, 'submitted');
  assert.equal(result.outcome, 'product_failed');
  assert.equal(result.decision, 'pending_review');
  assert.equal(result.artifactCount, 2);
  const states = (
    await db.pool.query(
      `SELECT a.state AS assignment,r.state AS run,
        (SELECT count(*)::int FROM decisions d WHERE d.assignment_id=a.id) AS decisions
      FROM assignments a JOIN runs r ON r.id=$2 JOIN evidence_submissions s ON s.run_id=r.id
      WHERE a.id=$1`,
      [assignment.assignmentId, grant.run.id],
    )
  ).rows[0];
  assert.equal(states.assignment, 'submitted');
  assert.equal(states.run, 'submitted');
  // Evidence is recorded; no decision exists yet.
  assert.equal(states.decisions, 0);
  // The claim's reservation is still committed: review has not happened.
  const accounting = await campaignAccounting(db.pool, assignment.campaignId);
  assert.equal(accounting?.committedUnits, committedBefore);
  assert.equal(accounting?.acceptedUnits, '0');
  assert.equal(accounting?.finalizedUnits, '0');
  assert.equal(accounting?.reconciled, true);
  // The grant is spent; a second submission cannot arrive.
  await assert.rejects(authenticateRun(db.pool, grant.secret), code('RUN_CLOSED'));
  await assert.rejects(submitEvidence(db.pool, grant, document), code('ATTEMPT_CLOSED'));
  await assert.rejects(
    db.pool.query("UPDATE evidence_submissions SET outcome='executed' WHERE run_id=$1", [
      grant.run.id,
    ]),
    /immutable/,
  );
});

test('builders and reviewers read submissions, and a reviewer read is audited', async () => {
  const { assignment, grant } = await runFor('runner-review');
  await completeEvidence(grant);
  await submitEvidence(db.pool, grant, await declared(grant, evidenceFor(assignment)));
  const view = await campaignSubmissions(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    assignment.campaignId,
  );
  assert.equal(view.submissions.length, 1);
  const submission = view.submissions[0];
  assert.equal(submission.outcome, 'product_failed');
  assert.equal(submission.decisions, null);
  assert.equal(submission.artifacts.length, 2);
  assert.deepEqual(
    submission.artifacts.map((artifact: { kind: string; reviewable: boolean }) => [
      artifact.kind,
      artifact.reviewable,
    ]),
    [
      ['trace', false],
      ['assertions', true],
    ],
  );
  assert.equal(view.runs[0].target_check.policy, 'target-revalidation-v1');
  const audited = await db.pool.query(
    "SELECT action FROM audit_events WHERE actor_id=$1 AND action='reviewer.submissions_read'",
    [reviewer.id],
  );
  assert.equal(audited.rowCount, 1);
  const assertions = submission.artifacts.find(
    (artifact: { kind: string }) => artifact.kind === 'assertions',
  );
  await readArtifact(
    db.pool,
    reviewer,
    workspaceId,
    projectId,
    assignment.campaignId,
    assertions.id,
  );
  const read = await db.pool.query(
    "SELECT action FROM audit_events WHERE actor_id=$1 AND action='reviewer.artifact_read'",
    [reviewer.id],
  );
  assert.equal(read.rowCount, 1);
});
