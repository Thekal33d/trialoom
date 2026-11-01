import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { afterEach, beforeEach } from 'node:test';
import { AppError } from '../src/domain/errors.ts';
import type { FreeTestResult } from '../src/domain/free-tests.ts';
import { prepareBuyReport } from '../src/server/buy-report.ts';
import { dispatchFreeTest, freeRunnerHeartbeat } from '../src/server/free-test-dispatch.ts';
import {
  prepareFreeTestReport,
  prepareNextFreeTestReport,
  projectFreeTestReport,
} from '../src/server/free-test-reports.ts';
import { cancelFreeTest, requestFreeTest } from '../src/server/free-tests.ts';
import { migrate } from '../src/server/migrations.ts';
import { disposableDatabase } from './helpers/database.ts';
import { seedFreeAccount } from './helpers/free-account.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let account: Awaited<ReturnType<typeof seedFreeAccount>>;
const image = `sha256:${'a'.repeat(64)}`;
const result: FreeTestResult = {
  schemaVersion: 1,
  outcome: 'blocked',
  startedAt: '2026-11-01T10:00:00.000Z',
  finishedAt: '2026-11-01T10:00:01.000Z',
  browser: 'Chromium 1.0',
  revisionConfirmed: false,
  checks: [
    { check: 'homepage', passed: true },
    { check: 'navigation', passed: false },
    { check: 'scope', passed: true },
    { check: 'infrastructure', passed: true },
  ],
  replay: null,
};
const request = () =>
  requestFreeTest(
    db.pool,
    account.actor,
    account.workspaceId,
    { kind: 'sample', requestId: randomUUID() },
    true,
  );
const prepare = (id: string) =>
  prepareFreeTestReport(db.pool, account.actor, account.workspaceId, id);
async function execute(value = result, cleanup = async () => {}) {
  return dispatchFreeTest(db.pool, {
    image,
    allowedOrigins: [],
    run: async () => value,
    cleanup,
  });
}
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
beforeEach(async () => {
  db = await disposableDatabase();
  await migrate(db.pool);
  account = await seedFreeAccount(db.pool);
  await freeRunnerHeartbeat(db.pool, []);
});
afterEach(async () => db?.close());

test('completed evidence produces one exact request across concurrent owner retries', async () => {
  const run = await request();
  await execute();
  const receipts = await Promise.all(Array.from({ length: 6 }, () => prepare(run.id)));
  assert.equal(new Set(receipts.map((receipt) => receipt.id)).size, 1);
  const stored = (await db.pool.query('SELECT * FROM buy_report_inputs')).rows[0];
  const source = (await db.pool.query('SELECT result_hash FROM free_tests WHERE id=$1', [run.id]))
    .rows[0];
  const prepared = prepareBuyReport(projectFreeTestReport('sample', result).observations);
  assert.equal(stored.result_hash, source.result_hash);
  assert.equal(stored.request_hash, prepared.bodyHash);
  assert.equal(stored.evidence_hash, prepared.evidenceHash);
  assert.equal(stored.request_body, prepared.body);
  assert.equal(stored.status, 'prepared');
  assert.equal(
    (await db.pool.query("SELECT count(*) FROM audit_events WHERE action='free_report.prepared'"))
      .rows[0].count,
    '1',
  );
  assert.deepEqual(await prepare(run.id), receipts[0]);
  for (const table of ['campaigns', 'assignments', 'payables', 'resource_purchases'])
    assert.equal((await db.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
});

test('all-passing results are durably skipped without a provider request', async () => {
  const run = await request();
  await execute({
    ...result,
    outcome: 'completed',
    checks: result.checks.map((check) => ({ ...check, passed: true })),
  });
  const receipt = await prepareNextFreeTestReport(db.pool);
  assert.equal(receipt?.status, 'skipped');
  assert.equal(receipt?.skipReason, 'all_checks_passed');
  assert.equal(receipt?.requestHash, null);
  assert.equal(
    (await db.pool.query('SELECT request_body FROM buy_report_inputs')).rows[0].request_body,
    null,
  );
  assert.deepEqual(await prepare(run.id), receipt);
  assert.equal(await prepareNextFreeTestReport(db.pool), null);
});

test('unfinished capture is refused; recovered original evidence prepares without another browser run', async () => {
  const run = await request();
  await assert.rejects(prepare(run.id), code('REPORT_NOT_READY'));
  await assert.rejects(
    execute(result, async () => {
      throw new Error('host offline');
    }),
  );
  await assert.rejects(prepare(run.id), code('REPORT_NOT_READY'));
  assert.equal(await prepareNextFreeTestReport(db.pool), null);
  await dispatchFreeTest(db.pool, {
    image,
    allowedOrigins: [],
    run: async () => {
      throw new Error('Must not run captured browser again');
    },
    cleanup: async () => {},
  });
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () => prepareNextFreeTestReport(db.pool)),
  );
  assert.equal(attempts.filter(Boolean).length, 1);
  const receipt = attempts.find(Boolean);
  assert.equal(receipt?.status, 'prepared');
  assert.deepEqual(await prepare(run.id), receipt);
});

test('cancelled and interrupted runs never become report requests', async () => {
  const cancelled = await request();
  await cancelFreeTest(db.pool, account.actor, account.workspaceId, cancelled.id);
  const interrupted = await request();
  await dispatchFreeTest(db.pool, {
    image,
    allowedOrigins: [],
    run: async () => {
      throw new Error('interrupted');
    },
    cleanup: async () => {},
  });
  for (const run of [cancelled, interrupted])
    await assert.rejects(prepare(run.id), code('REPORT_NOT_READY'));
  assert.equal(await prepareNextFreeTestReport(db.pool), null);
});

test('owner access is checked on every retry without exposing another account’s evidence', async () => {
  const run = await request();
  await execute();
  await prepare(run.id);
  const other = await seedFreeAccount(db.pool);
  await assert.rejects(
    prepareFreeTestReport(db.pool, other.actor, account.workspaceId, run.id),
    code('ACCESS_DENIED'),
  );
  await assert.rejects(
    prepareFreeTestReport(db.pool, other.actor, other.workspaceId, run.id),
    code('NOT_FOUND'),
  );
  await db.pool.query("UPDATE memberships SET role='member' WHERE user_id=$1", [account.actor.id]);
  await assert.rejects(prepare(run.id), code('ACCESS_DENIED'));
});

test('request identity is immutable and database binding refuses substituted owners and source hashes', async () => {
  const run = await request();
  await execute();
  await prepare(run.id);
  await assert.rejects(db.pool.query("UPDATE buy_report_inputs SET request_body='{}'"));
  await assert.rejects(db.pool.query('DELETE FROM buy_report_inputs'));
  const other = await seedFreeAccount(db.pool);
  for (const [owner, hash] of [
    [other.actor.id, null],
    [account.actor.id, 'f'.repeat(64)],
  ])
    await assert.rejects(
      db.pool.query(
        `INSERT INTO buy_report_inputs (free_test_id,user_id,workspace_id,result_hash,service,template_version,status,skip_reason,observations,evidence_hash,request_body,request_hash)
      SELECT free_test_id,$1,workspace_id,COALESCE($2,result_hash),service,'invalid-fixture',status,skip_reason,observations,evidence_hash,request_body,request_hash FROM buy_report_inputs`,
        [owner, hash],
      ),
    );
});

test('closed projection omits private fields and never invents failure details', () => {
  const projected = projectFreeTestReport('sample', {
    ...result,
    replay: { private: 'PRIVATE_TRACE' },
    url: 'https://private.example/',
    email: 'private@example.test',
    prompt: 'PRIVATE_PROMPT',
  });
  const prepared = prepareBuyReport(projected.observations);
  for (const canary of [
    'PRIVATE_TRACE',
    'private.example',
    'private@example.test',
    'PRIVATE_PROMPT',
  ])
    assert(!prepared.body.includes(canary));
  const observations = JSON.parse(JSON.parse(prepared.body).messages[1].content).observations;
  assert.deepEqual(observations[1], {
    ref: 'step-2',
    check: 'recorded_browser_check',
    name: 'navigation',
    passed: false,
  });
  for (const item of observations)
    for (const field of ['expected', 'observed', 'reason', 'deniedRequests', 'outcome'])
      assert.equal(field in item, false);
  for (const checks of [
    result.checks.slice(1),
    [...result.checks.slice(0, 3), result.checks[0]],
    result.checks.map((check) => ({ ...check, detail: 'PRIVATE_DETAIL' })),
    result.checks.map((check) => ({ ...check, passed: 'yes' })),
  ])
    assert.throws(() => projectFreeTestReport('sample', { ...result, checks }));
  assert.throws(() => projectFreeTestReport('sample', { ...result, outcome: 'completed' }));
  assert.throws(() => projectFreeTestReport('homepage', result));
  assert.equal(
    projectFreeTestReport('homepage', {
      ...result,
      checks: result.checks.filter((check) => check.check !== 'navigation'),
    }).observations.steps.length,
    3,
  );
});

test('invalid persisted evidence is refused instead of preparing a guessed report', async () => {
  const run = await request();
  await execute({ ...result, checks: result.checks.slice(1) });
  await assert.rejects(prepare(run.id), /FREE_REPORT_CHECKS_INVALID|Too small/);
  assert.equal((await db.pool.query('SELECT count(*) FROM buy_report_inputs')).rows[0].count, '0');
});

test('a corrupted source hash is refused before any report is stored', async () => {
  const run = await request();
  await execute();
  const corrupt = (
    await db.pool.query(
      `INSERT INTO free_tests (user_id,workspace_id,request_id,kind,target,environment,container_prefix,phase,cleanup_at,result,result_hash)
      SELECT user_id,workspace_id,gen_random_uuid(),kind,target,environment,
      'trialoom-run-'||substr(md5(gen_random_uuid()::text),1,24),phase,cleanup_at,result,$2
      FROM free_tests WHERE id=$1 RETURNING id`,
      [run.id, 'f'.repeat(64)],
    )
  ).rows[0];
  await assert.rejects(prepare(corrupt.id), /FREE_REPORT_SOURCE_CORRUPT/);
  assert.equal((await db.pool.query('SELECT count(*) FROM buy_report_inputs')).rows[0].count, '0');
});
