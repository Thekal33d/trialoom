import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { seedPreviewFixture } from '../scripts/preview-fixture.ts';
import { openPreviewJournal } from '../scripts/preview-journal.ts';
import { createPool } from '../src/server/database.ts';
import { migrate } from '../src/server/migrations.ts';
import { disposableDatabase } from './helpers/database.ts';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let fixture: Awaited<ReturnType<typeof seedPreviewFixture>>;
let directory: string;
before(async () => {
  db = await disposableDatabase();
  await migrate(db.pool);
  fixture = await seedPreviewFixture(db.pool, 'owned');
  directory = await mkdtemp(join(tmpdir(), 'trialoom-journal-'));
});
after(async () => {
  await db?.close();
  await rm(directory, { recursive: true, force: true });
});
const config = { image: `sha256:${'a'.repeat(64)}`, mode: 'owned' };

test('loss of the owning database session aborts work and never resets dispatch intent', async () => {
  const run = await fixture.assignment();
  const ownerPool = createPool(db.url);
  const client = await ownerPool.connect();
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  client.release();
  const abort = new AbortController();
  const journal = await openPreviewJournal(ownerPool, directory, run.runId, config, abort);
  try {
    assert.equal(ownerPool.totalCount, 1);
    await journal.dispatch();
    const ended = once(abort.signal, 'abort', { signal: AbortSignal.timeout(3000) });
    // This PID belongs only to the private test pool created immediately above.
    await db.pool.query('SELECT pg_terminate_backend($1)', [pid]);
    await ended;
    await assert.rejects(journal.owned(), /JOURNAL_CONNECTION_LOST/);
  } finally {
    await journal.close();
    await ownerPool.end();
  }
  const next = await openPreviewJournal(
    db.pool,
    directory,
    run.runId,
    config,
    new AbortController(),
  );
  try {
    assert.equal(next.state.phase, 'dispatching');
    await assert.rejects(next.dispatch(), /EXECUTION_ALREADY_DISPATCHED/);
  } finally {
    await next.close();
  }
});

test('one controller owns a run and immutable configuration survives reopening', async () => {
  const run = await fixture.assignment();
  const journal = await openPreviewJournal(
    db.pool,
    directory,
    run.runId,
    config,
    new AbortController(),
  );
  try {
    await assert.rejects(
      openPreviewJournal(db.pool, directory, run.runId, config, new AbortController()),
      /EXECUTION_BUSY/,
    );
    await journal.dispatch();
    await assert.rejects(journal.dispatch(), /EXECUTION_ALREADY_DISPATCHED/);
    await assert.rejects(
      db.pool.query("UPDATE preview_executions SET phase='prepared' WHERE run_id=$1", [run.runId]),
    );
    await assert.rejects(
      db.pool.query('UPDATE preview_executions SET config_hash=$2 WHERE run_id=$1', [
        run.runId,
        'b'.repeat(64),
      ]),
    );
  } finally {
    await journal.close();
  }
  await assert.rejects(
    openPreviewJournal(
      db.pool,
      directory,
      run.runId,
      { ...config, mode: 'public' },
      new AbortController(),
    ),
    /EXECUTION_CONFIG_CHANGED/,
  );
  const recovered = await openPreviewJournal(
    db.pool,
    directory,
    run.runId,
    config,
    new AbortController(),
  );
  try {
    assert.equal(recovered.state.phase, 'dispatching');
    await recovered.interrupted();
    await assert.rejects(recovered.dispatch(), /EXECUTION_ALREADY_DISPATCHED/);
  } finally {
    await recovered.close();
  }
});

test('capture is private, durable and hash checked; progress and delivery cannot regress', async () => {
  const run = await fixture.assignment();
  const root = join(directory, 'capture');
  const journal = await openPreviewJournal(db.pool, root, run.runId, config, new AbortController());
  try {
    await journal.dispatch();
    await journal.capture({ privateFixture: 'not-for-logs' });
    assert(journal.state.bundle_sha256);
    const path = join(root, journal.state.bundle_sha256);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await journal.bundle(), { privateFixture: 'not-for-logs' });
    const row = (
      await db.pool.query('SELECT * FROM preview_executions WHERE run_id=$1', [run.runId])
    ).rows[0];
    assert(!JSON.stringify(row).includes('not-for-logs'));
    const bytes = await readFile(path);
    await writeFile(path, '{}');
    await assert.rejects(journal.bundle(), /CAPTURE_CORRUPT/);
    await writeFile(path, bytes);
    await journal.egress();
    await journal.uploaded(2);
    await journal.delivered({ submissionId: 'local-fixture' });
    await assert.rejects(
      db.pool.query('UPDATE preview_executions SET uploaded_count=0 WHERE run_id=$1', [run.runId]),
    );
    await assert.rejects(
      db.pool.query('DELETE FROM preview_executions WHERE run_id=$1', [run.runId]),
    );
  } finally {
    await journal.close();
  }
  const recovered = await openPreviewJournal(
    db.pool,
    root,
    run.runId,
    config,
    new AbortController(),
  );
  try {
    assert.equal(recovered.state.phase, 'delivered');
    assert.deepEqual(await recovered.bundle(), { privateFixture: 'not-for-logs' });
  } finally {
    await recovered.close();
  }
});
