import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { afterEach, beforeEach } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../src/domain/errors.ts';
import type { FreeTestResult } from '../src/domain/free-tests.ts';
import {
  dispatchFreeTest,
  executionFailureClass,
  type FreeRunner,
  freeRunnerHeartbeat,
} from '../src/server/free-test-dispatch.ts';
import { projectFreeTestResult } from '../src/server/free-test-results.ts';
import { cancelFreeTest, freeTestsView, requestFreeTest } from '../src/server/free-tests.ts';
import { migrate } from '../src/server/migrations.ts';
import { createProject } from '../src/server/projects.ts';
import { disposableDatabase } from './helpers/database.ts';
import { seedFreeAccount } from './helpers/free-account.ts';
import { traceCanary, traceFixture } from './helpers/trace.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let account: Awaited<ReturnType<typeof seedFreeAccount>>;
const image = `sha256:${'a'.repeat(64)}`;
const result: FreeTestResult = {
  schemaVersion: 1,
  outcome: 'completed',
  startedAt: '2026-11-01T10:00:00.000Z',
  finishedAt: '2026-11-01T10:00:01.000Z',
  browser: 'Chromium 1.0',
  revisionConfirmed: false,
  checks: [{ check: 'homepage', passed: true }],
  replay: null,
};
const runner = (overrides: Partial<FreeRunner> = {}): FreeRunner => ({
  image,
  allowedOrigins: [],
  run: async () => result,
  cleanup: async () => {},
  ...overrides,
});
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;
const request = (requestId = randomUUID()) =>
  requestFreeTest(db.pool, account.actor, account.workspaceId, { kind: 'sample', requestId }, true);
const state = async (id: string) =>
  (await db.pool.query('SELECT * FROM free_tests WHERE id=$1', [id])).rows[0];
beforeEach(async () => {
  db = await disposableDatabase();
  await migrate(db.pool);
  account = await seedFreeAccount(db.pool);
  await freeRunnerHeartbeat(db.pool, []);
});
afterEach(async () => {
  await db?.close();
});

test('request retries are one durable identity, even when offline; changed payload is rejected', async () => {
  const requestId = randomUUID();
  const receipts = await Promise.all(Array.from({ length: 5 }, () => request(requestId)));
  assert.equal(new Set(receipts.map((r) => r.id)).size, 1);
  assert.deepEqual(
    await requestFreeTest(
      db.pool,
      account.actor,
      account.workspaceId,
      { kind: 'sample', requestId },
      false,
    ),
    receipts[0],
  );
  await assert.rejects(
    requestFreeTest(
      db.pool,
      account.actor,
      account.workspaceId,
      { kind: 'homepage', requestId, projectId: randomUUID(), authorizationConfirmed: true },
      true,
    ),
    code('REQUEST_CONFLICT'),
  );
});
test('concurrent starts obey one-active and three-per-UTC-day limits; cancellation does not refund quota', async () => {
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => request()));
  assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1);
  const first = attempts.find((a) => a.status === 'fulfilled');
  assert(first?.status === 'fulfilled');
  await cancelFreeTest(db.pool, account.actor, account.workspaceId, first.value.id);
  for (let n = 0; n < 2; n++) {
    const next = await request();
    await cancelFreeTest(db.pool, account.actor, account.workspaceId, next.id);
  }
  await assert.rejects(request(), code('DAILY_TEST_LIMIT'));
  assert.equal(
    (await freeTestsView(db.pool, account.actor, account.workspaceId, true)).remaining,
    0,
  );
});
test('disabled or stale runner refuses a new request without consuming allowance', async () => {
  await assert.rejects(
    requestFreeTest(
      db.pool,
      account.actor,
      account.workspaceId,
      { kind: 'sample', requestId: randomUUID() },
      false,
    ),
    code('RUNNER_UNAVAILABLE'),
  );
  await db.pool.query(
    "UPDATE free_test_runtime SET heartbeat_at=clock_timestamp()-interval '61 seconds'",
  );
  await assert.rejects(request(), code('RUNNER_UNAVAILABLE'));
  assert.equal(
    (await freeTestsView(db.pool, account.actor, account.workspaceId, true)).tests.length,
    0,
  );
});
test('tenant boundaries apply to request, history, cancellation and project selection', async () => {
  const other = await seedFreeAccount(db.pool);
  const first = await request();
  await assert.rejects(
    freeTestsView(db.pool, other.actor, account.workspaceId, true),
    code('ACCESS_DENIED'),
  );
  await assert.rejects(
    cancelFreeTest(db.pool, other.actor, other.workspaceId, first.id),
    code('NOT_FOUND'),
  );
  await assert.rejects(
    requestFreeTest(
      db.pool,
      other.actor,
      account.workspaceId,
      { kind: 'sample', requestId: randomUUID() },
      true,
    ),
    code('ACCESS_DENIED'),
  );
  const project = await createProject(
    db.pool,
    other.actor,
    other.workspaceId,
    {
      name: 'Other',
      targetUrl: 'https://example.com',
      environment: 'preview',
      authorizationConfirmed: true,
    },
    async () => ['93.184.216.34'],
  );
  await assert.rejects(
    requestFreeTest(
      db.pool,
      account.actor,
      account.workspaceId,
      {
        kind: 'homepage',
        requestId: randomUUID(),
        projectId: project.id,
        authorizationConfirmed: true,
      },
      true,
    ),
    code('NOT_FOUND'),
  );
});
test('public page scope requires operator enablement, explicit authorization, and preserves DNS pins', async () => {
  const project = await createProject(
    db.pool,
    account.actor,
    account.workspaceId,
    {
      name: 'Owned',
      targetUrl: 'https://example.com',
      environment: 'staging',
      authorizationConfirmed: true,
    },
    async () => ['93.184.216.34'],
  );
  const input = {
    kind: 'homepage',
    requestId: randomUUID(),
    projectId: project.id,
    authorizationConfirmed: true,
  };
  await assert.rejects(
    requestFreeTest(db.pool, account.actor, account.workspaceId, input, true),
    code('TARGET_NOT_ENABLED'),
  );
  await freeRunnerHeartbeat(db.pool, ['https://example.com']);
  await assert.rejects(
    requestFreeTest(
      db.pool,
      account.actor,
      account.workspaceId,
      { ...input, authorizationConfirmed: false },
      true,
    ),
  );
  await assert.rejects(
    requestFreeTest(
      db.pool,
      account.actor,
      account.workspaceId,
      { ...input, target: 'https://127.0.0.1' },
      true,
    ),
  );
  const queued = await requestFreeTest(db.pool, account.actor, account.workspaceId, input, true);
  assert.deepEqual((await state(queued.id)).target.addresses, ['93.184.216.34']);
  assert.equal((await state(queued.id)).environment, 'staging');
  await dispatchFreeTest(db.pool, runner());
  assert.equal((await state(queued.id)).phase, 'cancelled'); // withdrawn operator permission
});
test('global queue ceiling is atomic across different accounts', async () => {
  const accounts = await Promise.all(Array.from({ length: 14 }, () => seedFreeAccount(db.pool)));
  const attempts = await Promise.allSettled(
    accounts.map((a) =>
      requestFreeTest(
        db.pool,
        a.actor,
        a.workspaceId,
        { kind: 'sample', requestId: randomUUID() },
        true,
      ),
    ),
  );
  assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 10);
  assert.equal(
    attempts.filter((a) => a.status === 'rejected' && code('TEST_CAPACITY')(a.reason)).length,
    4,
  );
});
test('global daily ceiling includes terminal requests from all accounts', async () => {
  for (let n = 0; n < 10; n++) {
    const a = await seedFreeAccount(db.pool);
    for (let i = 0; i < 3; i++) {
      const t = await requestFreeTest(
        db.pool,
        a.actor,
        a.workspaceId,
        { kind: 'sample', requestId: randomUUID() },
        true,
      );
      await cancelFreeTest(db.pool, a.actor, a.workspaceId, t.id);
    }
  }
  await assert.rejects(request(), code('TEST_CAPACITY'));
});
test('two dispatchers cannot execute concurrently; captured delivery creates no payment records', async () => {
  const queued = await request();
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const ready = new Promise<void>((done) => {
    started = done;
  });
  const first = dispatchFreeTest(
    db.pool,
    runner({
      run: async () => {
        started?.();
        await new Promise<void>((done) => {
          release = done;
        });
        return result;
      },
    }),
  );
  await ready;
  assert.equal(
    await dispatchFreeTest(
      db.pool,
      runner({
        run: async () => {
          assert.fail('Duplicate dispatch');
        },
      }),
    ),
    false,
  );
  release?.();
  await first;
  assert.equal((await state(queued.id)).phase, 'completed');
  assert.equal((await state(queued.id)).result_hash.length, 64);
  for (const table of [
    'campaigns',
    'assignments',
    'payables',
    'payment_authorities',
    'resource_purchases',
  ])
    assert.equal((await db.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
  await assert.rejects(
    db.pool.query("UPDATE free_tests SET phase='queued' WHERE id=$1", [queued.id]),
  );
  await assert.rejects(db.pool.query("UPDATE free_tests SET result='{}' WHERE id=$1", [queued.id]));
});

test('target allowance is shared across accounts without exposing other enabled origins', async () => {
  await freeRunnerHeartbeat(db.pool, [
    'https://example.com',
    'https://private-customer.example.com',
  ]);
  for (let n = 0; n < 6; n++) {
    const a = await seedFreeAccount(db.pool);
    const project = await createProject(
      db.pool,
      a.actor,
      a.workspaceId,
      {
        name: 'Authorized page',
        targetUrl: 'https://example.com',
        environment: 'preview',
        authorizationConfirmed: true,
      },
      async () => ['93.184.216.34'],
    );
    const attempt = () =>
      requestFreeTest(
        db.pool,
        a.actor,
        a.workspaceId,
        {
          kind: 'homepage',
          projectId: project.id,
          requestId: randomUUID(),
          authorizationConfirmed: true,
        },
        true,
      );
    assert.deepEqual((await freeTestsView(db.pool, a.actor, a.workspaceId, true)).allowedOrigins, [
      'https://example.com',
    ]);
    if (n === 5) await assert.rejects(attempt(), code('TEST_CAPACITY'));
    else {
      const queued = await attempt();
      await cancelFreeTest(db.pool, a.actor, a.workspaceId, queued.id);
    }
  }
});

test('prior UTC-day requests do not consume today’s allowance', async () => {
  for (let n = 0; n < 3; n++)
    await db.pool.query(
      `INSERT INTO free_tests (user_id,workspace_id,request_id,kind,target,environment,container_prefix,phase,cleanup_at,created_at)
    VALUES ($1,$2,$3,'sample',$4,'preview',$5,'cancelled',clock_timestamp(),(date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-interval '1 millisecond')`,
      [
        account.actor.id,
        account.workspaceId,
        randomUUID(),
        JSON.stringify({
          url: 'https://preview.example.com/',
          origin: 'https://preview.example.com',
          addresses: ['127.0.0.1'],
        }),
        `trialoom-run-${randomUUID().replaceAll('-', '').slice(0, 24)}`,
      ],
    );
  assert.equal(
    (await freeTestsView(db.pool, account.actor, account.workspaceId, true)).remaining,
    3,
  );
  await request();
  assert.equal(
    (await freeTestsView(db.pool, account.actor, account.workspaceId, true)).remaining,
    2,
  );
});
test('capture survives cleanup failure; next dispatcher delivers it without executing again', async () => {
  const queued = await request();
  await assert.rejects(
    dispatchFreeTest(
      db.pool,
      runner({
        cleanup: async () => {
          throw new Error('host offline');
        },
      }),
    ),
  );
  assert.equal((await state(queued.id)).phase, 'captured');
  await assert.rejects(request(), code('TEST_ACTIVE'));
  await dispatchFreeTest(
    db.pool,
    runner({
      run: async () => {
        assert.fail('Captured run repeated');
      },
    }),
  );
  assert.equal((await state(queued.id)).phase, 'completed');
});
test('uncaptured interruption retains its slot until cleanup; recovery never dispatches it again', async () => {
  const queued = await request();
  await assert.rejects(
    dispatchFreeTest(
      db.pool,
      runner({
        run: async () => {
          throw new Error('private target detail');
        },
        cleanup: async () => {
          throw new Error('host offline');
        },
      }),
    ),
  );
  assert.equal((await state(queued.id)).phase, 'running');
  await dispatchFreeTest(
    db.pool,
    runner({
      run: async () => {
        assert.fail('Interrupted run repeated');
      },
    }),
  );
  const row = await state(queued.id);
  assert.equal(row.phase, 'interrupted');
  assert.equal(row.result, null);
  assert(!JSON.stringify(row).includes('private target detail'));
});
test('running cancellation aborts the runner and holds account capacity until cleanup', async () => {
  const queued = await request();
  const job = dispatchFreeTest(
    db.pool,
    runner({
      run: async (_row, signal) => {
        await cancelFreeTest(db.pool, account.actor, account.workspaceId, queued.id);
        await delay(10000, undefined, { signal });
        return result;
      },
      cleanup: async () => {
        await assert.rejects(request(), code('TEST_ACTIVE'));
      },
    }),
  );
  await job;
  assert.equal((await state(queued.id)).phase, 'cancelled');
});
test('result projection drops private trace/page strings and distinguishes scope blockage', () => {
  const trace = Buffer.from(traceFixture()).toString('base64');
  const raw = {
    ...result,
    outcome: 'executed',
    assertions: [
      { name: 'homepage.rendered', passed: true, detail: 'PRIVATE_CUSTOMER' },
      { name: 'navigation.rendered', passed: true },
    ],
    trace,
  };
  const witness = {
    closed: true,
    budgetExceeded: null,
    observations: [{ reason: 'ALLOWED', count: 1 }],
  };
  const clean = projectFreeTestResult(raw, witness, true);
  assert.equal(clean.outcome, 'completed');
  assert(clean.replay);
  assert(!JSON.stringify(clean).includes('PRIVATE_CUSTOMER'));
  assert(!JSON.stringify(clean).includes(traceCanary));
  assert.equal(
    projectFreeTestResult(
      raw,
      { ...witness, observations: [{ reason: 'ORIGIN_DENIED', count: 1 }] },
      true,
    ).outcome,
    'blocked',
  );
  assert.equal(projectFreeTestResult({ ...raw, trace: 'AAAA' }, witness, true).replay, null);
});

test('an execution failure is reported as a fixed class and never echoes the error', () => {
  assert.equal(
    executionFailureClass(new Error('PREVIEW_PROCESS_STOPPED')),
    'PREVIEW_PROCESS_STOPPED',
  );
  // A target's own text, a stack, or anything the runner did not raise itself
  // must not survive this boundary.
  for (const raised of [
    new Error('https://customer.example.com returned 500: secret-token=abc'),
    new Error(''),
    Object.assign(new Error('PREVIEW_PROCESS_STOPPED extra detail'), { code: 'X' }),
    'PREVIEW_PROCESS_STOPPED',
    undefined,
    null,
  ])
    assert.equal(executionFailureClass(raised), 'UNCLASSIFIED');
});
