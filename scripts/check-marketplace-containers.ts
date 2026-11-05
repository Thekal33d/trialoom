import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { disposableDatabase } from '../tests/helpers/database.ts';

// Smoke the exact web/worker images against owned disposable data. No signer,
// production connection, customer target or provider purchase is inherited.
const run = promisify(execFile);
const db = await disposableDatabase();
const directory = await mkdtemp(join(tmpdir(), 'trialoom-images-'));
const envFile = join(directory, 'fixture.env');
const name = `trialoom-check-${randomBytes(6).toString('hex')}`;
const migrationName = `${name}-migrate`;
const workerName = `${name}-worker`;
const storageName = `${name}-storage`;
const incompleteName = `${name}-incomplete`;
try {
  const url = new URL(db.url);
  url.hostname = 'host.docker.internal';
  await writeFile(
    envFile,
    [
      `DATABASE_URL=${url.href}`,
      `BETTER_AUTH_SECRET=${randomBytes(32).toString('hex')}`,
      'BETTER_AUTH_URL=http://127.0.0.1:3000',
      'TRIALOOM_WALLET_LOGIN=true',
      'TRIALOOM_PUBLIC_WALLET_SIGNUP=true',
      'TRIALOOM_PUBLIC_SIGNUP=true',
      'TRIALOOM_FREE_TESTS=false',
      'TRIALOOM_REMESSO_AGENT_KEY=',
      'TRIALOOM_SPONSOR_AGENT_KEY=',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  const docker = (args: string[]) =>
    run('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 });
  // Startup validation uses fixture credentials and id only: no S3 request.
  const storage = await docker([
    'run',
    '--rm',
    '--name',
    storageName,
    '--user',
    '0',
    '-e',
    'TRIALOOM_S3_ENDPOINT=https://fixture.invalid',
    '-e',
    'TRIALOOM_S3_BUCKET=fixture-private',
    '-e',
    'TRIALOOM_S3_ACCESS_KEY_ID=fixture',
    '-e',
    'TRIALOOM_S3_SECRET_ACCESS_KEY=fixture',
    '-e',
    'TRIALOOM_EVIDENCE_DIR=/proc/unwritable',
    'trialoom-worker:marketplace-check',
    'id',
    '-u',
  ]);
  assert.match(storage.stdout, /"event":"container.evidence_shared"/);
  assert.match(storage.stdout, /\n1000\s*$/);
  await assert.rejects(
    docker([
      'run',
      '--rm',
      '--name',
      incompleteName,
      '-e',
      'TRIALOOM_S3_BUCKET=fixture-private',
      'trialoom-worker:marketplace-check',
      'true',
    ]),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      return (
        failure.code === 1 && Boolean(failure.stderr?.includes('container.evidence_incomplete'))
      );
    },
  );
  const migration = await docker([
    'run',
    '--rm',
    '--name',
    migrationName,
    '--env-file',
    envFile,
    'trialoom-worker:marketplace-check',
    'node',
    'scripts/migrate.ts',
  ]);
  const migrationLine = migration.stdout
    .split('\n')
    .find((line) => line.includes('"event":"migrations.complete"'));
  assert(migrationLine);
  const applied = JSON.parse(migrationLine).applied as string[];
  assert.equal(applied.at(-1), '0030_settlement_runtime.sql');
  const worker = await docker([
    'run',
    '--rm',
    '--name',
    workerName,
    '--env-file',
    envFile,
    'trialoom-worker:marketplace-check',
    'node',
    'workers/main.ts',
    '--once',
  ]);
  assert.match(worker.stdout, /"adapter":"unconfigured"/);
  await docker([
    'run',
    '-d',
    '--name',
    name,
    '--env-file',
    envFile,
    '-p',
    '127.0.0.1::3000',
    'trialoom-web:marketplace-check',
  ]);
  const port = (await docker(['port', name, '3000/tcp'])).stdout.trim().split(':').at(-1);
  assert.match(port ?? '', /^\d+$/);
  const origin = `http://127.0.0.1:${port}`;
  let health: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      /* The container may still be starting. */
    }
    await delay(300);
  }
  assert.equal(health?.privileged, false);
  assert.equal(health?.walletSignup, 'enabled');
  assert.equal(
    (await fetch(`${origin}/api/ready`, { signal: AbortSignal.timeout(10000) })).status,
    200,
  );
  assert.equal((await fetch(`${origin}/`, { signal: AbortSignal.timeout(10000) })).status, 200);
  // An image with only the old schema must not pass the new traffic gate.
  await db.pool.query("DELETE FROM schema_migrations WHERE name='0030_settlement_runtime.sql'");
  assert.equal(
    (await fetch(`${origin}/api/ready`, { signal: AbortSignal.timeout(10000) })).status,
    503,
  );
  console.log(
    JSON.stringify({
      event: 'containers.verified',
      migrations: applied.length,
      worker: 'signer-disabled',
      privileged: false,
      sharedStorageStartup: 'checked-without-egress',
      latestSchemaRequired: true,
      productionChanged: false,
    }),
  );
} finally {
  // A timed-out Docker client can lose the acknowledgement after creation.
  // Clean up every unique fixture identity even when start was not confirmed.
  await run('docker', ['rm', '-f', name, migrationName, workerName, storageName, incompleteName], {
    timeout: 30000,
  }).catch(() => {});
  await db.close();
  await rm(directory, { recursive: true, force: true });
}
