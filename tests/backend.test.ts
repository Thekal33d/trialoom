import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { createPool, databaseUrl, transaction } from '../src/server/database.ts';
import { claimJob, completePing, enqueuePing } from '../src/server/jobs.ts';
import { migrate, migrationFiles } from '../src/server/migrations.ts';

const adminUrl = new URL(databaseUrl());
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname) ||
  adminUrl.pathname !== '/trialoom_dev'
) {
  throw new Error('Database tests require the isolated loopback trialoom_dev database');
}
const name = `trialoom_test_${randomUUID().replaceAll('-', '')}`;
const admin = createPool(adminUrl.href);
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${name}`;
let pool: Pool;
before(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  pool = createPool(testUrl.href);
});
after(async () => {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
});

test('concurrent migrations serialize, then rerun without changes', async () => {
  const results = await Promise.all([migrate(pool), migrate(pool)]);
  const count = (await migrationFiles()).length;
  assert.equal(results.flat().length, count);
  assert.deepEqual(await migrate(pool), []);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count,
    count,
  );
});

test('applied migration checksum drift refuses further migration', async () => {
  const [file] = await migrationFiles();
  await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE name = $2', [
    'altered',
    file.name,
  ]);
  try {
    await assert.rejects(migrate(pool), /Applied migration modified/);
  } finally {
    await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE name = $2', [
      file.checksum,
      file.name,
    ]);
  }
});

test('transaction rollback cannot leave an outbox job behind', async () => {
  await assert.rejects(
    transaction(pool, async (client) => {
      await enqueuePing(client, 'rollback');
      throw new Error('abort');
    }),
    /abort/,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS count FROM outbox_jobs WHERE dedupe_key = $1', [
        'rollback',
      ])
    ).rows[0].count,
    0,
  );
});

test('concurrent duplicate enqueue creates one durable identity and effect', async () => {
  const ids = await Promise.all(Array.from({ length: 12 }, () => enqueuePing(pool, 'same-event')));
  assert.equal(new Set(ids).size, 1);
  const claims = await Promise.all([claimJob(pool), claimJob(pool)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const lease = claims.find(Boolean);
  assert.ok(lease);
  assert.equal(await completePing(pool, lease), true);
  assert.equal(await completePing(pool, lease), false);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS count FROM worker_effects WHERE job_id = $1', [
        ids[0],
      ])
    ).rows[0].count,
    1,
  );
});

test('expired lease is reclaimed and old worker cannot write an effect', async () => {
  const id = await enqueuePing(pool, 'stale-worker');
  const old = await claimJob(pool);
  assert.ok(old);
  await pool.query(
    `UPDATE outbox_jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1`,
    [id],
  );
  const replacement = await claimJob(pool);
  assert.ok(replacement);
  assert.notEqual(old.lease_token, replacement.lease_token);
  assert.equal(await completePing(pool, old), false);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS count FROM worker_effects WHERE job_id = $1', [id]))
      .rows[0].count,
    0,
  );
  assert.equal(await completePing(pool, replacement), true);
});

test('worker restart consumes a saved job in a fresh process', async () => {
  const id = await enqueuePing(pool, 'restart-worker');
  await promisify(execFile)(process.execPath, ['workers/main.ts', '--once'], {
    env: { ...process.env, DATABASE_URL: testUrl.href },
    timeout: 15000,
  });
  const result = await pool.query('SELECT state FROM outbox_jobs WHERE id = $1', [id]);
  assert.equal(result.rows[0].state, 'done');
});

test('exhausted expired jobs remain recorded as dead', async () => {
  const id = await enqueuePing(pool, 'exhausted');
  await pool.query(
    `UPDATE outbox_jobs SET state = 'leased', attempts = 5, lease_token = gen_random_uuid(),
    lease_until = clock_timestamp() - interval '1 second' WHERE id = $1`,
    [id],
  );
  assert.equal(await claimJob(pool), null);
  assert.equal(
    (await pool.query('SELECT state FROM outbox_jobs WHERE id = $1', [id])).rows[0].state,
    'dead',
  );
});
