import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { AppError } from '../src/domain/errors.ts';
import { dispatchHostedTest } from '../src/server/hosted-test-dispatch.ts';
import { hostedRunToken, hostedTestStatus, requestHostedTest } from '../src/server/hosted-tests.ts';
import { migrate } from '../src/server/migrations.ts';
import { revokeCredential } from '../src/server/operators.ts';
import { revokeTargetVerification } from '../src/server/target-verification.ts';
import { disposableDatabase } from './helpers/database.ts';
import { seedPublicMarketplace } from './helpers/public-marketplace.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let fixture: Awaited<ReturnType<typeof seedPublicMarketplace>>;
const previousKey = process.env.TRIALOOM_RUNNER_DISPATCH_KEY;
const code = (expected: string) => (e: unknown) => e instanceof AppError && e.code === expected;
beforeEach(async () => {
  process.env.TRIALOOM_RUNNER_DISPATCH_KEY = 'ab'.repeat(32);
  db = await disposableDatabase();
  await migrate(db.pool);
  fixture = await seedPublicMarketplace(db.pool);
});
afterEach(async () => {
  await db?.close();
  if (previousKey) process.env.TRIALOOM_RUNNER_DISPATCH_KEY = previousKey;
  else delete process.env.TRIALOOM_RUNNER_DISPATCH_KEY;
});
const request = (a: Awaited<ReturnType<typeof fixture.assignment>>) =>
  requestHostedTest(db.pool, fixture.session, a.assignmentId, { attemptToken: a.attemptToken });
test('racing execution requests keep one identity and refuse expanded scope', async () => {
  const assignment = await fixture.assignment();
  const jobs = await Promise.all(Array.from({ length: 4 }, () => request(assignment)));
  assert.equal(new Set(jobs.map((x) => x.id)).size, 1);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM runs')).rows[0].n, 0);
  const unsupported = await fixture.assignment(['Submit a real payment']);
  await assert.rejects(request(unsupported), code('HOSTED_SCOPE_UNSUPPORTED'));
});
test('offline or mismatched dispatch runtime cannot accept new execution', async () => {
  const assignment = await fixture.assignment();
  await db.pool.query(
    "UPDATE paid_runner_runtime SET heartbeat_at=clock_timestamp()-interval '61 seconds'",
  );
  await assert.rejects(request(assignment), code('HOSTED_TESTING_UNAVAILABLE'));
  await db.pool.query(
    'UPDATE paid_runner_runtime SET heartbeat_at=clock_timestamp(),dispatch_key_hash=$1',
    ['f'.repeat(64)],
  );
  await assert.rejects(request(assignment), code('HOSTED_TESTING_UNAVAILABLE'));
});
test('permission withdrawal and credential revocation prevent queued browser execution', async () => {
  const assignment = await fixture.assignment();
  await request(assignment);
  await revokeTargetVerification(
    db.pool,
    fixture.builder.actor,
    fixture.builder.workspaceId,
    fixture.project.id,
  );
  let executed = false;
  await dispatchHostedTest(
    db.pool,
    fixture.host.hostId,
    async () => {
      executed = true;
    },
    undefined,
    fixture.deps,
  );
  assert.equal(executed, false);
  assert.equal(
    (await hostedTestStatus(db.pool, fixture.session, assignment.assignmentId)).reason,
    'TARGET_VERIFICATION_REQUIRED',
  );
});
test('a revoked queued credential fails before a run is issued', async () => {
  const assignment = await fixture.assignment();
  await request(assignment);
  await revokeCredential(db.pool, fixture.account.actor, fixture.session.credential.id);
  await dispatchHostedTest(
    db.pool,
    fixture.host.hostId,
    async () => {
      assert.fail('must not execute');
    },
    undefined,
    fixture.deps,
  );
  assert.equal(
    (await hostedTestStatus(db.pool, fixture.session, assignment.assignmentId)).reason,
    'CREDENTIAL_INVALID',
  );
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM runs')).rows[0].n, 0);
});
test('recovery reuses one run and grant, and a returned result cannot authorize payment', async () => {
  const assignment = await fixture.assignment();
  const queued = await request(assignment);
  const runs: string[] = [];
  const tokens: string[] = [];
  const execute = async (job: { run_id: string }, token: string) => {
    runs.push(job.run_id);
    tokens.push(token);
    throw new Error('simulated delivery outage');
  };
  await dispatchHostedTest(db.pool, fixture.host.hostId, execute, undefined, fixture.deps);
  await db.pool.query('UPDATE hosted_test_jobs SET retry_at=clock_timestamp()');
  await dispatchHostedTest(db.pool, fixture.host.hostId, execute, undefined, fixture.deps);
  assert.equal(new Set(runs).size, 1);
  assert.equal(runs.length, 2);
  assert.equal(
    tokens[0],
    hostedRunToken(queued.id, assignment.assignmentId, assignment.attemptToken),
  );
  assert.equal(tokens[1], tokens[0]);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM payables')).rows[0].n, 0);
  assert.equal(
    (
      await db.pool.query('SELECT committed_units FROM campaign_accounts WHERE campaign_id=$1', [
        assignment.campaignId,
      ])
    ).rows[0].committed_units,
    '1000000',
  );
  const status = await hostedTestStatus(db.pool, fixture.session, assignment.assignmentId);
  assert.equal(status.state, 'running');
  assert.equal(status.reason, 'RECOVERY_PENDING');
});
