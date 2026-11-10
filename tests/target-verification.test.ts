import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { afterEach, beforeEach } from 'node:test';
import { AppError } from '../src/domain/errors.ts';
import { dispatchFreeTest, freeRunnerHeartbeat } from '../src/server/free-test-dispatch.ts';
import { freeTestsView, requestFreeTest } from '../src/server/free-tests.ts';
import { migrate } from '../src/server/migrations.ts';
import { createProject } from '../src/server/projects.ts';
import {
  issueTargetChallenge,
  revokeTargetVerification,
  targetVerificationView,
  targetVerified,
  verifyTargetChallenge,
} from '../src/server/target-verification.ts';
import { disposableDatabase } from './helpers/database.ts';
import { seedFreeAccount } from './helpers/free-account.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let account: Awaited<ReturnType<typeof seedFreeAccount>>;
let projectId: string;
const resolve = async () => ['93.184.216.34'];
const code = (expected: string) => (e: unknown) => e instanceof AppError && e.code === expected;
beforeEach(async () => {
  db = await disposableDatabase();
  await migrate(db.pool);
  account = await seedFreeAccount(db.pool);
  projectId = (
    await createProject(
      db.pool,
      account.actor,
      account.workspaceId,
      {
        name: 'Verified site',
        targetUrl: 'https://example.com',
        environment: 'preview',
        authorizationConfirmed: true,
      },
      resolve,
    )
  ).id;
});
afterEach(async () => {
  await db?.close();
});
const issue = () => issueTargetChallenge(db.pool, account.actor, account.workspaceId, projectId);
const check = (challenge: Awaited<ReturnType<typeof issue>>, overrides = {}) =>
  verifyTargetChallenge(
    db.pool,
    account.actor,
    account.workspaceId,
    projectId,
    { challengeId: challenge.id },
    { resolver: resolve, txt: async () => [[challenge.record.value]], ...overrides },
  );
async function verified() {
  const challenge = await issue();
  await check(challenge);
  return challenge;
}
const request = () =>
  requestFreeTest(
    db.pool,
    account.actor,
    account.workspaceId,
    { requestId: randomUUID(), kind: 'homepage', projectId, authorizationConfirmed: true },
    true,
  );

test('exact TXT proof enables only its project and cannot be consumed twice', async () => {
  const challenge = await issue();
  assert.equal(challenge.record.name, '_trialoom.example.com');
  assert.equal(await targetVerified(db.pool, projectId), false);
  await assert.rejects(
    check(challenge, { txt: async () => [['prefix', challenge.record.value]] }),
    code('VERIFICATION_NOT_FOUND'),
  );
  await check(challenge, {
    txt: async () => [[challenge.record.value.slice(0, 20), challenge.record.value.slice(20)]],
  });
  assert.equal(await targetVerified(db.pool, projectId), true);
  await assert.rejects(check(challenge), code('CHALLENGE_UNUSABLE'));
  const other = (
    await createProject(
      db.pool,
      account.actor,
      account.workspaceId,
      {
        name: 'Same domain different project',
        targetUrl: 'https://example.com',
        environment: 'preview',
        authorizationConfirmed: true,
      },
      resolve,
    )
  ).id;
  assert.equal(await targetVerified(db.pool, other), false);
});
test('owner access is checked before DNS and another project cannot use this challenge', async () => {
  const challenge = await issue();
  const stranger = await seedFreeAccount(db.pool);
  let looked = false;
  await assert.rejects(
    verifyTargetChallenge(
      db.pool,
      stranger.actor,
      account.workspaceId,
      projectId,
      { challengeId: challenge.id },
      {
        txt: async () => {
          looked = true;
          return [[challenge.record.value]];
        },
      },
    ),
    code('ACCESS_DENIED'),
  );
  assert.equal(looked, false);
  await assert.rejects(
    issueTargetChallenge(db.pool, account.actor, stranger.workspaceId, projectId),
    code('ACCESS_DENIED'),
  );
});
test('rotated, expired and revoked challenges cannot grant permission', async () => {
  const old = await issue();
  const current = await issue();
  await assert.rejects(check(old), code('CHALLENGE_UNUSABLE'));
  await db.pool.query(
    "UPDATE target_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [current.id],
  );
  await assert.rejects(check(current), code('CHALLENGE_UNUSABLE'));
  const revoked = await issue();
  await revokeTargetVerification(db.pool, account.actor, account.workspaceId, projectId);
  await assert.rejects(check(revoked), code('CHALLENGE_UNUSABLE'));
});
test('matching TXT cannot approve mixed public and private DNS answers', async () => {
  const challenge = await issue();
  await assert.rejects(
    check(challenge, { resolver: async () => ['93.184.216.34', '127.0.0.1'] }),
    code('TARGET_PRIVATE'),
  );
  assert.equal(await targetVerified(db.pool, projectId), false);
});
test('challenge replacement during a DNS check invalidates the old response', async () => {
  const old = await issue();
  await assert.rejects(
    check(old, {
      txt: async () => {
        await issue();
        return [[old.record.value]];
      },
    }),
    code('CHALLENGE_UNUSABLE'),
  );
  assert.equal(await targetVerified(db.pool, projectId), false);
});
test('verification expiry and explicit revocation remove test eligibility', async () => {
  await verified();
  await db.pool.query(
    "UPDATE target_verifications SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
    [projectId],
  );
  assert.equal(await targetVerified(db.pool, projectId), false);
  await verified();
  await revokeTargetVerification(db.pool, account.actor, account.workspaceId, projectId);
  assert.equal(
    (await targetVerificationView(db.pool, account.actor, account.workspaceId, projectId)).verified,
    false,
  );
});
test('verified sites need a capable runner; permission is rechecked before dispatch', async () => {
  await verified();
  await freeRunnerHeartbeat(db.pool, []);
  await assert.rejects(request(), code('TARGET_NOT_ENABLED'));
  await freeRunnerHeartbeat(db.pool, [], true);
  assert.deepEqual(
    (await freeTestsView(db.pool, account.actor, account.workspaceId, true)).allowedOrigins,
    ['https://example.com'],
  );
  const requested = await request();
  await revokeTargetVerification(db.pool, account.actor, account.workspaceId, projectId);
  let executed = false;
  await dispatchFreeTest(db.pool, {
    image: `sha256:${'a'.repeat(64)}`,
    allowedOrigins: [],
    acceptsVerifiedTargets: true,
    run: async () => {
      executed = true;
      throw new Error('must not execute');
    },
    cleanup: async () => {},
  });
  assert.equal(executed, false);
  assert.equal(
    (await db.pool.query('SELECT phase FROM free_tests WHERE id=$1', [requested.id])).rows[0].phase,
    'cancelled',
  );
});
test('a fresh verified target executes through the durable free dispatcher without an allowlist', async () => {
  await verified();
  await freeRunnerHeartbeat(db.pool, [], true);
  const requested = await request();
  let executions = 0;
  await dispatchFreeTest(db.pool, {
    image: `sha256:${'a'.repeat(64)}`,
    allowedOrigins: [],
    acceptsVerifiedTargets: true,
    run: async (row) => {
      executions++;
      assert.equal(row.project_id, projectId);
      return {
        schemaVersion: 1,
        outcome: 'completed',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        browser: 'Chromium 1.0',
        revisionConfirmed: false,
        checks: [{ check: 'homepage', passed: true }],
        replay: null,
      };
    },
    cleanup: async () => {},
  });
  assert.equal(executions, 1);
  assert.equal(
    (await db.pool.query('SELECT phase FROM free_tests WHERE id=$1', [requested.id])).rows[0].phase,
    'completed',
  );
});

test('a record published under a doubled domain is named, not blamed on propagation', async () => {
  const challenge = await issue();
  // example.com is the project's origin, so this is what a provider that
  // appends the zone produces when the fully qualified name is pasted in.
  const doubled = `${challenge.record.name}.example.com`;
  await assert.rejects(
    check(challenge, { txt: async (name: string) => (name === doubled ? [[challenge.record.value]] : []) }),
    (error: unknown) => {
      assert.ok(error instanceof AppError && error.code === 'VERIFICATION_NOT_FOUND');
      assert.match((error as AppError).message, new RegExp(doubled.replace(/\./g, '\\.')));
      assert.match((error as AppError).message, /only "_trialoom"/);
      return true;
    },
  );
  // Absent everywhere still reads as propagation, because that is what it is.
  await assert.rejects(
    check(challenge, { txt: async () => [] }),
    (error: unknown) => {
      assert.ok(error instanceof AppError && error.code === 'VERIFICATION_NOT_FOUND');
      assert.match((error as AppError).message, /not visible yet/);
      return true;
    },
  );
});
