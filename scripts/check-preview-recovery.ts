import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { revokeHost } from '../src/server/isolation.ts';
import { migrate } from '../src/server/migrations.ts';
import { digestOf } from '../src/server/storage.ts';
import { disposableDatabase } from '../tests/helpers/database.ts';
import { startLocalServer } from './local-server.ts';
import { seedPreviewFixture } from './preview-fixture.ts';
import { buildPreviewImage, previewHost, remote } from './preview-host.ts';

const directory = resolve('artifacts/preview-recovery', randomBytes(8).toString('hex'));
await mkdir(directory, { recursive: true, mode: 0o700 });
const db = await disposableDatabase();
let app: Awaited<ReturnType<typeof startLocalServer>> | undefined;
const children = new Set<ReturnType<typeof fork>>();
const results: { checkpoint: string; recovered: boolean; submissions: number }[] = [];
let image = '';
try {
  await migrate(db.pool);
  const fixture = await seedPreviewFixture(db.pool, 'owned', 'ladder');
  image = await buildPreviewImage();
  app = await startLocalServer(db.url, directory);
  function launch(input: Record<string, unknown>) {
    const child = fork(resolve('scripts/preview-recovery-child.ts'), [], {
      silent: true,
      env: { ...process.env, DATABASE_URL: db.url },
    });
    children.add(child);
    // Nothing from the raw child streams enters a log. The IPC protocol is closed.
    child.stdout?.resume();
    child.stderr?.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 70000);
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) => {
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        children.delete(child);
        done({ code, signal });
      });
    });
    const message = new Promise<{
      checkpoint?: string;
      error?: string;
      completed?: boolean;
      submissionId?: string;
    }>((done, reject) => {
      child.once('message', (value) => done(value as never));
      child.once('error', () => reject(new Error('CHILD_START_FAILED')));
      void exited.then(() => reject(new Error('CHILD_EXITED_WITHOUT_CHECKPOINT')));
    });
    child.stdin?.end(JSON.stringify(input));
    return { child, exited, message };
  }
  async function clean(prefix: string) {
    const host = previewHost(image, false, new AbortController().signal, prefix);
    await host.close();
    assert.equal(host.present(), '');
    assert.equal(
      remote([
        'docker',
        'volume',
        'ls',
        '--filter',
        `name=^${prefix}-channel$`,
        '--format',
        '{{.Name}}',
      ]),
      '',
    );
  }
  for (const checkpoint of [
    'dispatching',
    'running',
    'captured',
    'egress',
    'artifact',
    'submitted',
    'corrupt',
    'conflict',
    'expired',
    'revoked',
  ]) {
    const run = await fixture.assignment(`Recovery — ${checkpoint}`);
    const input = {
      apiOrigin: app.origin,
      runId: run.runId,
      runToken: run.runToken,
      hostCredential: fixture.host.credential,
      image,
      mode: 'owned',
      journey: 'ladder',
      hold: checkpoint === 'running',
      directory: resolve(directory, 'journal'),
    };
    const captureControl = ['corrupt', 'conflict', 'expired', 'revoked'].includes(checkpoint);
    const stopped = launch({
      ...input,
      stopAt: captureControl ? 'captured' : checkpoint,
    });
    assert.equal((await stopped.message).checkpoint, captureControl ? 'captured' : checkpoint);
    const journal = (
      await db.pool.query('SELECT * FROM preview_executions WHERE run_id=$1', [run.runId])
    ).rows[0];
    if (checkpoint === 'running') {
      let running = false;
      for (let n = 0; n < 20 && !running; n++) {
        running =
          remote([
            'docker',
            'inspect',
            `${journal.container_prefix}-browser`,
            '--format',
            '{{.State.Running}}',
          ]) === 'true';
        if (!running) await delay(100);
      }
      assert(running, 'BROWSER_NOT_RUNNING_AT_CRASH');
    }
    if (checkpoint === 'captured') {
      const competitor = launch(input);
      assert.equal((await competitor.message).error, 'EXECUTION_BUSY');
      assert.equal((await competitor.exited).code, 1);
    }
    stopped.child.kill('SIGKILL');
    assert.equal((await stopped.exited).signal, 'SIGKILL');
    if (journal.bundle_sha256) {
      const path = resolve(directory, 'journal', journal.bundle_sha256);
      const capture = await readFile(path, 'utf8');
      assert(!capture.includes(run.runToken) && !capture.includes(fixture.host.credential));
      if (checkpoint === 'corrupt') await writeFile(path, '{}');
    }
    if (checkpoint === 'conflict') {
      const bytes = Buffer.from('owned-conflicting-artifact');
      const query = new URLSearchParams({
        name: 'browser.trace.zip',
        kind: 'trace',
        sha256: digestOf(bytes),
      });
      const response: Response = await fetch(
        `${app.origin}/api/agent/v1/runs/${run.runId}/artifacts?${query}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${run.runToken}`, 'content-type': 'application/zip' },
          body: bytes,
        },
      );
      assert.equal(response.status, 201);
    }
    // The already committed server record may be ahead of the journal.
    const before = (
      await db.pool.query(
        'SELECT (SELECT count(*)::int FROM evidence_artifacts WHERE run_id=$1) AS artifacts, (SELECT count(*)::int FROM egress_batches WHERE run_id=$1) AS batches, (SELECT count(*)::int FROM evidence_submissions WHERE run_id=$1) AS submissions',
        [run.runId],
      )
    ).rows[0];
    if (checkpoint === 'artifact') {
      assert.equal(before.artifacts, 1);
      assert.equal(journal.uploaded_count, 0);
    }
    if (checkpoint === 'egress') {
      assert.equal(before.batches, 1);
      assert.equal(journal.egress_delivered, false);
    }
    if (checkpoint === 'submitted') {
      assert.equal(before.submissions, 1);
      assert.equal(journal.phase, 'captured');
    }
    if (checkpoint === 'expired' || checkpoint === 'submitted')
      await db.pool.query(
        "UPDATE runs SET issued_at=clock_timestamp()-interval '2 seconds',grant_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [run.runId],
      );
    if (checkpoint === 'revoked')
      await revokeHost(db.pool, fixture.owner, fixture.workspaceId, fixture.host.hostId);
    const recovered = launch(input);
    const outcome = await recovered.message;
    const exit = await recovered.exited;
    const interrupted = ['dispatching', 'running'].includes(checkpoint);
    const refused = captureControl;
    if (interrupted) {
      assert.equal(outcome.error, 'EXECUTION_INTERRUPTED');
      assert.equal(exit.code, 1);
    } else if (refused) {
      assert.match(
        outcome.error ?? '',
        /RUN_EXPIRED|HOST_UNUSABLE|HOST_CREDENTIAL_INVALID|CAPTURE_CORRUPT|DELIVERY_ARTIFACT_CHANGED/,
      );
      assert.equal(exit.code, 1);
    } else {
      assert.equal(outcome.completed, true);
      assert.equal(exit.code, 0);
    }
    const after = (
      await db.pool.query('SELECT * FROM preview_executions WHERE run_id=$1', [run.runId])
    ).rows[0];
    assert.equal(after.container_prefix, journal.container_prefix);
    assert.equal(after.bundle_sha256, journal.bundle_sha256);
    assert.equal(after.phase, interrupted ? 'interrupted' : refused ? 'captured' : 'delivered');
    assert(after.cleanup_at);
    assert.equal(
      remote([
        'docker',
        'ps',
        '-a',
        '--filter',
        `name=^/${journal.container_prefix}-`,
        '--format',
        '{{.Names}}',
      ]),
      '',
    );
    assert.equal(
      remote([
        'docker',
        'volume',
        'ls',
        '--filter',
        `name=^${journal.container_prefix}-channel$`,
        '--format',
        '{{.Name}}',
      ]),
      '',
    );
    await clean(journal.container_prefix);
    const counts = (
      await db.pool.query(
        'SELECT (SELECT count(*)::int FROM evidence_submissions WHERE run_id=$1) AS submissions, (SELECT count(*)::int FROM evidence_artifacts WHERE run_id=$1) AS artifacts, (SELECT count(*)::int FROM egress_batches WHERE run_id=$1) AS batches',
        [run.runId],
      )
    ).rows[0];
    assert.equal(counts.submissions, interrupted || refused ? 0 : 1);
    if (!interrupted && !refused) {
      assert.equal(counts.artifacts, 3);
      assert.equal(counts.batches, 1);
      const totals = (
        await db.pool.query(
          'SELECT artifact_count,artifact_bytes,(SELECT sum(bytes)::text FROM evidence_artifacts WHERE run_id=$1) AS stored_bytes FROM runs WHERE id=$1',
          [run.runId],
        )
      ).rows[0];
      assert.equal(totals.artifact_count, 3);
      assert.equal(totals.artifact_bytes, totals.stored_bytes);
      const again = launch(input);
      assert.equal((await again.message).submissionId, outcome.submissionId);
      assert.equal((await again.exited).code, 0);
      assert.equal(
        (
          await db.pool.query(
            'SELECT count(*)::int AS n FROM evidence_submissions WHERE run_id=$1',
            [run.runId],
          )
        ).rows[0].n,
        1,
      );
    }
    const account = (
      await db.pool.query(
        'SELECT committed_units,accepted_units,finalized_units FROM campaign_accounts WHERE campaign_id=$1',
        [run.campaignId],
      )
    ).rows[0];
    assert.deepEqual(account, {
      committed_units: '2000000',
      accepted_units: '0',
      finalized_units: '0',
    });
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM payables')).rows[0].n, 0);
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM decisions')).rows[0].n, 0);
    results.push({
      checkpoint,
      recovered: !interrupted && !refused,
      submissions: counts.submissions,
    });
    console.log(
      `PASS ${checkpoint}: fresh-process recovery, cleanup, unchanged commitment and no duplicate delivery.`,
    );
  }
  await writeFile(
    resolve(directory, 'summary.json'),
    JSON.stringify({ image, checks: results }, null, 2),
    { mode: 0o600 },
  );
  console.log(
    `PASS all ${results.length} real SIGKILL checkpoints; private summary: ${directory}/summary.json`,
  );
} finally {
  for (const child of children) child.kill('SIGKILL');
  await delay(200);
  try {
    if (image) {
      const rows = await db.pool.query('SELECT container_prefix FROM preview_executions');
      for (const row of rows.rows)
        await previewHost(image, false, new AbortController().signal, row.container_prefix).close();
    }
  } finally {
    await app?.close();
    await db.close();
    await rm(resolve(directory, 'evidence'), { recursive: true, force: true });
    await rm(resolve(directory, 'journal'), { recursive: true, force: true });
  }
}
