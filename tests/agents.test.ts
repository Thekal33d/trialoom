import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import { AppError } from '../src/domain/errors.ts';
import { canonicalJson } from '../src/domain/values.ts';
import type { Actor } from '../src/server/access.ts';
import {
  type AgentSession,
  authenticateAgent,
  bearerToken,
  listEligibleWork,
  requireScope,
  withIdempotency,
} from '../src/server/agents.ts';
import { claim } from '../src/server/assignments.ts';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { migrate } from '../src/server/migrations.ts';
import { createCredential, registerOperator } from '../src/server/operators.ts';
import { addBuild, createCampaign, createProject } from '../src/server/projects.ts';
import {
  gradeSubmission,
  qualificationStatus,
  recordAttempt,
  submitAttempt,
} from '../src/server/qualification.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let owner: Actor;
let workspaceId: string;
const password = randomBytes(24).toString('base64url');
const code = (name: string) => (error: unknown) => error instanceof AppError && error.code === name;
const correctReports: Record<string, Record<string, unknown>> = {
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
  'journey-step-accuracy': {
    defectPresent: true,
    stepsExecuted: 4,
    failingStep: 'invitation.create',
  },
};

async function operatorFor(handle: string, role = 'operator') {
  const email = `${handle}@example.test`;
  const invitation = await createInvitation(db.pool, owner, workspaceId, { email, role });
  await acceptInvitation(db.pool, { token: invitation.token, name: handle, password }, null);
  const actor: Actor = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [email])
  ).rows[0];
  const operator = await registerOperator(db.pool, actor, { handle });
  return { actor, operator };
}
async function sessionFor(
  handle: string,
  scopes = ['operator:read', 'work:read', 'qualification:submit'],
) {
  const { actor, operator } = await operatorFor(handle);
  const credential = await createCredential(db.pool, actor, {
    name: 'Runner',
    scopes,
    expiresInDays: 7,
  });
  return {
    actor,
    operator,
    secret: credential.secret,
    session: await authenticateAgent(db.pool, credential.secret),
  };
}
before(async () => {
  db = await disposableDatabase();
  await migrate(db.pool);
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'owner@example.test',
    name: 'Agent workspace',
  });
  workspaceId = bootstrap.workspaceId;
  await acceptInvitation(db.pool, { token: bootstrap.token, name: 'Owner', password }, null);
  owner = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', [
      'owner@example.test',
    ])
  ).rows[0];
});
after(async () => {
  await db?.close();
});

test('grading separates accuracy failures from false reports', () => {
  const key = {
    gradedFields: { defectPresent: true, failingStep: 'invitation.create', observedStatus: 400 },
  };
  assert.equal(
    gradeSubmission(key, {
      defectPresent: true,
      failingStep: 'invitation.create',
      observedStatus: 400,
    }).outcome,
    'correct',
  );
  assert.equal(
    gradeSubmission(key, { defectPresent: false, failingStep: null, observedStatus: 201 }).outcome,
    'incorrect',
  );
  const wrong = gradeSubmission(key, {
    defectPresent: true,
    failingStep: 'invitation.accept',
    observedStatus: 500,
  });
  assert.equal(wrong.outcome, 'incorrect');
  assert.equal(wrong.reason, 'Graded fields did not match: failingStep, observedStatus');
  // Asserting a defect on a clean control build is a false report, not an error.
  const control = { gradedFields: { defectPresent: false, observedStatus: 201 } };
  assert.equal(
    gradeSubmission(control, { defectPresent: true, observedStatus: 400 }).outcome,
    'false_report',
  );
  assert.equal(
    gradeSubmission(control, { defectPresent: false, observedStatus: 201 }).outcome,
    'correct',
  );
});

test('answer keys never leave the server', async () => {
  const { operator } = await sessionFor('key-privacy');
  const status = await qualificationStatus(db.pool, operator.id);
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('gradedFields'));
  assert.ok(!serialized.includes('answer_key'));
  assert.equal(status.tasks.length, 4);
  for (const task of status.tasks) {
    assert.ok(task.brief.instructions);
    assert.equal(task.attempts_used, 0);
    assert.equal(task.passed, null);
  }
});

test('passing every seeded task for a service grants eligibility', async () => {
  const { actor, operator } = await operatorFor('qualifies');
  for (const slug of ['invite-alias-defect', 'invite-alias-repaired'])
    await submitAttempt(db.pool, operator, { task: slug, report: correctReports[slug] });
  const status = await qualificationStatus(db.pool, operator.id);
  const discovery = status.eligibility.find((row) => row.service === 'bug_discovery');
  assert.deepEqual(
    { state: discovery.state, reason: discovery.reason, passed: discovery.tasks_passed },
    { state: 'eligible', reason: 'qualified', passed: 2 },
  );
  assert.equal(discovery.attempts, 2);
  // Other services stay ineligible until their own tasks are cleared.
  await submitAttempt(db.pool, operator, {
    task: 'regression-pins-revision',
    report: { defectPresent: true, baselineResult: 'passed', candidateResult: 'passed' },
  });
  const repair = (await qualificationStatus(db.pool, operator.id)).eligibility.find(
    (row) => row.service === 'repair',
  );
  assert.equal(repair.state, 'ineligible');
  assert.equal(repair.reason, 'incomplete');
  assert.ok(actor.id);
});

test('a false report makes a service ineligible and later passes do not clear it', async () => {
  const { operator } = await operatorFor('false-reporter');
  await submitAttempt(db.pool, operator, {
    task: 'invite-alias-repaired',
    report: {
      defectPresent: true,
      failingStep: 'invitation.create',
      expectedStatus: 201,
      observedStatus: 400,
    },
  });
  let discovery = (await qualificationStatus(db.pool, operator.id)).eligibility[0];
  assert.deepEqual(
    [discovery.state, discovery.reason, discovery.false_reports],
    ['ineligible', 'false_report', 1],
  );
  for (const slug of ['invite-alias-defect', 'invite-alias-repaired'])
    await submitAttempt(db.pool, operator, { task: slug, report: correctReports[slug] });
  discovery = (await qualificationStatus(db.pool, operator.id)).eligibility[0];
  assert.equal(discovery.tasks_passed, 2);
  assert.deepEqual([discovery.state, discovery.reason], ['ineligible', 'false_report']);
});

test('accuracy below the floor blocks eligibility even after a pass', async () => {
  const { operator } = await operatorFor('inaccurate');
  const wrong = { defectPresent: true, stepsExecuted: 9, failingStep: 'invitation.accept' };
  await submitAttempt(db.pool, operator, { task: 'journey-step-accuracy', report: wrong });
  await submitAttempt(db.pool, operator, { task: 'journey-step-accuracy', report: wrong });
  await submitAttempt(db.pool, operator, {
    task: 'journey-step-accuracy',
    report: correctReports['journey-step-accuracy'],
  });
  const row = (await qualificationStatus(db.pool, operator.id)).eligibility.find(
    (entry) => entry.service === 'test',
  );
  assert.deepEqual([row.tasks_passed, row.tasks_total, row.correct, row.attempts], [1, 1, 1, 3]);
  assert.deepEqual([row.state, row.reason], ['ineligible', 'accuracy_below_threshold']);
  // A fourth attempt is refused; the limit is not an accuracy workaround.
  await assert.rejects(
    submitAttempt(db.pool, operator, {
      task: 'journey-step-accuracy',
      report: correctReports['journey-step-accuracy'],
    }),
    code('ATTEMPTS_EXHAUSTED'),
  );
});

test('malformed submissions are refused with the exact required fields and record no attempt', async () => {
  const { operator } = await operatorFor('malformed');
  for (const report of [
    { defectPresent: true },
    { ...correctReports['invite-alias-defect'], extra: 'note' },
  ])
    await assert.rejects(
      submitAttempt(db.pool, operator, { task: 'invite-alias-defect', report }),
      code('REPORT_FIELDS_INVALID'),
    );
  await assert.rejects(
    submitAttempt(db.pool, operator, { task: 'no-such-task', report: { defectPresent: true } }),
    code('TASK_NOT_FOUND'),
  );
  const attempts = await db.pool.query(
    'SELECT 1 FROM qualification_attempts WHERE operator_id=$1',
    [operator.id],
  );
  assert.equal(attempts.rowCount, 0);
});

test('agent credentials authenticate by digest and refuse anything unusable', async () => {
  const { actor, secret, session } = await sessionFor('authenticates');
  assert.equal(session.operator.handle, 'authenticates');
  assert.deepEqual(session.credential.scopes, [
    'operator:read',
    'qualification:submit',
    'work:read',
  ]);
  const used = (
    await db.pool.query('SELECT last_used_at FROM agent_credentials WHERE id=$1', [
      session.credential.id,
    ])
  ).rows[0];
  assert.ok(used.last_used_at);
  await assert.rejects(
    authenticateAgent(db.pool, randomBytes(32).toString('base64url')),
    code('CREDENTIAL_INVALID'),
  );
  await db.pool.query(
    `UPDATE agent_credentials SET created_at=clock_timestamp()-interval '2 hours',
    expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
    [session.credential.id],
  );
  await assert.rejects(authenticateAgent(db.pool, secret), code('CREDENTIAL_INVALID'));
  await db.pool.query(
    "UPDATE agent_credentials SET expires_at=clock_timestamp()+interval '1 day',revoked_at=clock_timestamp() WHERE id=$1",
    [session.credential.id],
  );
  await assert.rejects(authenticateAgent(db.pool, secret), code('CREDENTIAL_INVALID'));
  // A suspended operator's live credentials stop working.
  await db.pool.query('UPDATE agent_credentials SET revoked_at=NULL WHERE id=$1', [
    session.credential.id,
  ]);
  await db.pool.query("UPDATE operators SET status='suspended' WHERE user_id=$1", [actor.id]);
  await assert.rejects(authenticateAgent(db.pool, secret), code('CREDENTIAL_INVALID'));
});

test('the agent API takes bearer credentials only, and scopes are enforced', async () => {
  const headers = (init: Record<string, string>) =>
    new Request('http://127.0.0.1:3100/api/agent/v1/work', { headers: init });
  assert.equal(bearerToken(headers({ authorization: 'Bearer abc123' })), 'abc123');
  assert.throws(() => bearerToken(headers({})), code('CREDENTIAL_REQUIRED'));
  assert.throws(
    () => bearerToken(headers({ authorization: 'Basic abc' })),
    code('CREDENTIAL_REQUIRED'),
  );
  assert.throws(
    () => bearerToken(headers({ authorization: 'Bearer abc', cookie: 'session=1' })),
    code('COOKIE_REJECTED'),
  );
  const { session } = await sessionFor('scoped', ['work:read']);
  requireScope(session, 'work:read');
  for (const scope of ['operator:read', 'qualification:submit'] as const)
    assert.throws(() => requireScope(session, scope), code('SCOPE_REQUIRED'));
});

test('a retried mutation runs once and a different request with the same key is refused', async () => {
  const { session } = await sessionFor('idempotent');
  const body = { task: 'invite-alias-defect', report: correctReports['invite-alias-defect'] };
  const run = (payload: unknown, key: string) =>
    withIdempotency(db.pool, session, 'qualification/attempts', payload, key, (client) =>
      recordAttempt(client, session.operator, session.credential.id, payload),
    );
  const first = await run(body, 'attempt-key-0001');
  const replay = await run(body, 'attempt-key-0001');
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(first.body)), replay.body);
  const attempts = await db.pool.query(
    'SELECT 1 FROM qualification_attempts WHERE operator_id=$1',
    [session.operator.id],
  );
  assert.equal(attempts.rowCount, 1);
  await assert.rejects(
    run(
      { task: 'invite-alias-repaired', report: correctReports['invite-alias-repaired'] },
      'attempt-key-0001',
    ),
    code('IDEMPOTENCY_MISMATCH'),
  );
  // A refused request stores no key, so a corrected retry is still possible.
  const bad = { task: 'invite-alias-repaired', report: { defectPresent: false } };
  await assert.rejects(run(bad, 'attempt-key-0002'), code('REPORT_FIELDS_INVALID'));
  assert.equal(
    (
      await db.pool.query('SELECT 1 FROM agent_idempotency WHERE operator_id=$1 AND key=$2', [
        session.operator.id,
        'attempt-key-0002',
      ])
    ).rowCount,
    0,
  );
  const fixed = await run(
    { task: 'invite-alias-repaired', report: correctReports['invite-alias-repaired'] },
    'attempt-key-0002',
  );
  assert.equal(fixed.replayed, false);
  assert.equal(fixed.body.attempt.outcome, 'correct');
});

test('an unfinished key is refused rather than replayed as a new mutation', async () => {
  const { session } = await sessionFor('in-progress');
  await db.pool.query(
    'INSERT INTO agent_idempotency (operator_id,key,credential_id,request_hash) VALUES ($1,$2,$3,$4)',
    [
      session.operator.id,
      'stalled-key-01',
      session.credential.id,
      // The hash this exact request produces, with no stored response.
      createHash('sha256')
        .update(canonicalJson({ route: 'qualification/attempts', body: { any: 'body' } }))
        .digest('hex'),
    ],
  );
  const replay = (key: string) =>
    withIdempotency(db.pool, session, 'qualification/attempts', { any: 'body' }, key, async () => ({
      ran: true,
    }));
  await assert.rejects(replay('stalled-key-01'), code('IDEMPOTENCY_IN_PROGRESS'));
  // A different request under the same key is a mismatch, not a replay.
  await assert.rejects(
    withIdempotency(db.pool, session, 'work', { any: 'body' }, 'stalled-key-01', async () => ({})),
    code('IDEMPOTENCY_MISMATCH'),
  );
});

test('an unpublished draft brief is never offered to a qualified operator', async () => {
  const { actor, operator } = await operatorFor('work-reader');
  for (const slug of ['invite-alias-defect', 'invite-alias-repaired'])
    await submitAttempt(db.pool, operator, { task: slug, report: correctReports[slug] });
  const credential = await createCredential(db.pool, actor, {
    name: 'Reader',
    scopes: ['work:read'],
    expiresInDays: 1,
  });
  const session: AgentSession = await authenticateAgent(db.pool, credential.secret);
  const work = await listEligibleWork(db.pool, session);
  assert.deepEqual(work.items, []);
  assert.deepEqual(work.eligibleServices, ['bug_discovery']);
  assert.ok(work.admissions.some((row) => row.id === workspaceId));
  // A qualified, admitted operator with nothing published sees that reason alone.
  assert.deepEqual(
    work.unavailable.map((entry) => entry.code),
    ['NO_OPEN_CAMPAIGN'],
  );
  // A real draft brief for a service this operator qualified for stays invisible
  // until its owner publishes it against an authorized budget.
  const project = await createProject(
    db.pool,
    owner,
    workspaceId,
    {
      name: 'Agent preview project',
      targetUrl: 'https://preview.example.com/',
      environment: 'preview',
      authorizationConfirmed: true,
    },
    async () => ['93.184.215.14'],
  );
  const build = await addBuild(
    db.pool,
    owner,
    workspaceId,
    project.id,
    {
      revision: 'baseline-1',
      fixtureVersion: 'invitation-1',
      targetUrl: 'https://preview.example.com/',
    },
    async () => ['93.184.215.14'],
  );
  const campaign = await createCampaign(db.pool, owner, workspaceId, project.id, {
    name: 'Find invitation defects',
    terms: {
      buildId: build.id,
      expectedVersion: 0,
      service: 'bug_discovery',
      scope: 'Exercise the invitation journey',
      allowedActions: ['Create sandbox invitations'],
      exclusions: ['No real emails'],
      acceptanceCriteria: 'Reports must replay from the exported trace',
      rewardRubric: 'One reward per distinct accepted defect',
      artifactRights: 'Builder retains reports and regression tests',
      deadline: new Date(Date.now() + 86_400_000).toISOString(),
      reviewWindowHours: 48,
      priceUnits: '2500000',
      discoveryRewardCapUnits: '1000000',
      resourceAllowanceUnits: '0',
      platformFeeBps: 1000,
      paymentTerms: 'Authorized spending is not escrow; accepted work remains owed.',
      scopeApproved: true,
    },
  });
  assert.equal(
    (await db.pool.query('SELECT status FROM campaigns WHERE id=$1', [campaign.campaignId])).rows[0]
      .status,
    'draft',
  );
  // Forcing the status open without an authorized budget still offers nothing:
  // both the listing and the claim path require a campaign account.
  await db.pool.query(
    `UPDATE campaigns SET status='open',slots=1,max_concurrent=1,published_terms_id=$2,
    published_by=$3,published_at=clock_timestamp(),spending_authorization='forced-without-budget'
    WHERE id=$1`,
    [campaign.campaignId, campaign.id, owner.id],
  );
  assert.deepEqual((await listEligibleWork(db.pool, session)).items, []);
  await assert.rejects(
    claim(db.pool, session, { campaignId: campaign.campaignId }),
    code('CAMPAIGN_UNFUNDED'),
  );
});

test('an operator with no admission or qualification is told which gate applies', async () => {
  const bootstrap = await bootstrapWorkspace(db.pool, {
    email: 'solo@example.test',
    name: 'Solo workspace',
  });
  await acceptInvitation(db.pool, { token: bootstrap.token, name: 'Solo', password }, null);
  const actor: Actor = (
    await db.pool.query('SELECT id,name,email FROM auth_user WHERE email=$1', ['solo@example.test'])
  ).rows[0];
  await registerOperator(db.pool, actor, { handle: 'unadmitted' });
  const credential = await createCredential(db.pool, actor, {
    name: 'Reader',
    scopes: ['work:read'],
    expiresInDays: 1,
  });
  const work = await listEligibleWork(db.pool, await authenticateAgent(db.pool, credential.secret));
  assert.deepEqual(
    work.unavailable.map((entry) => entry.code),
    ['NO_WORKSPACE_ADMISSION', 'NOT_QUALIFIED'],
  );
});

test('concurrent submissions cannot exceed the attempt limit', async () => {
  const { operator } = await operatorFor('races');
  const report = { defectPresent: true, stepsExecuted: 2, failingStep: 'invitation.accept' };
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      submitAttempt(db.pool, operator, { task: 'journey-step-accuracy', report }),
    ),
  );
  const accepted = results.filter((entry) => entry.status === 'fulfilled');
  assert.equal(accepted.length, 3);
  for (const entry of results.filter((item) => item.status === 'rejected'))
    assert.ok(code('ATTEMPTS_EXHAUSTED')((entry as PromiseRejectedResult).reason));
  const numbers = (
    await db.pool.query<{ attempt_number: number }>(
      'SELECT attempt_number FROM qualification_attempts WHERE operator_id=$1 ORDER BY attempt_number',
      [operator.id],
    )
  ).rows.map((row) => row.attempt_number);
  assert.deepEqual(numbers, [1, 2, 3]);
});

test('a concurrent retry of the same key runs the mutation once', async () => {
  const { session } = await sessionFor('concurrent-retry');
  const body = { task: 'invite-alias-defect', report: correctReports['invite-alias-defect'] };
  const run = () =>
    withIdempotency(db.pool, session, 'qualification/attempts', body, 'parallel-key-01', (client) =>
      recordAttempt(client, session.operator, session.credential.id, body),
    );
  const [first, second] = await Promise.all([run(), run()]);
  assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);
  assert.equal(
    (
      await db.pool.query('SELECT 1 FROM qualification_attempts WHERE operator_id=$1', [
        session.operator.id,
      ])
    ).rowCount,
    1,
  );
  const stored = first.replayed ? first.body : second.body;
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), JSON.parse(JSON.stringify(first.body)));
});
