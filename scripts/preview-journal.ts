import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { canonicalJson } from '../src/domain/values.ts';
import { digestOf } from '../src/server/storage.ts';

const maxBundleBytes = 14 * 1024 ** 2;
type Row = {
  run_id: string;
  config_hash: string;
  container_prefix: string;
  phase: 'prepared' | 'dispatching' | 'captured' | 'delivered' | 'interrupted';
  bundle_sha256: string | null;
  receipt: Record<string, unknown> | null;
};

/** A database session lock excludes competing controllers; phase CAS prevents redispatch. */
export async function openPreviewJournal(
  pool: Pool,
  directory: string,
  runId: string,
  config: Record<string, unknown>,
  abort: AbortController,
) {
  const client = await pool.connect();
  let broken = false;
  const lost = () => {
    broken = true;
    abort.abort(new Error('JOURNAL_CONNECTION_LOST'));
  };
  client.on('error', lost);
  client.on('end', lost);
  let locked = false;
  const key = `preview-execution:${runId}`;
  async function close() {
    try {
      if (locked && !broken)
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1,48301))', [key]);
    } catch (error) {
      broken = true;
      throw error;
    } finally {
      client.removeListener('error', lost);
      client.removeListener('end', lost);
      client.release(broken);
    }
  }
  try {
    locked = (
      await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,48301)) AS held', [key])
    ).rows[0].held;
    assert(locked, 'EXECUTION_BUSY');
    const hash = digestOf(Buffer.from(canonicalJson(config)));
    await client.query(
      `INSERT INTO preview_executions (run_id,config_hash,container_prefix) VALUES ($1,$2,$3)
       ON CONFLICT (run_id) DO NOTHING`,
      [runId, hash, `trialoom-run-${randomBytes(12).toString('hex')}`],
    );
    const state = (
      await client.query<Row>('SELECT * FROM preview_executions WHERE run_id=$1', [runId])
    ).rows[0];
    assert.equal(state.config_hash, hash, 'EXECUTION_CONFIG_CHANGED');
    const root = resolve(directory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    async function owned() {
      abort.signal.throwIfAborted();
      await client.query('SELECT 1');
      abort.signal.throwIfAborted();
    }
    async function update(sql: string, values: unknown[] = []) {
      const phase = state.phase;
      await owned();
      const changed = await client.query(
        `UPDATE preview_executions SET ${sql} WHERE run_id=$1 AND phase=$${values.length + 2} RETURNING *`,
        [runId, ...values, phase],
      );
      assert.equal(changed.rowCount, 1, 'JOURNAL_TRANSITION_REFUSED');
      Object.assign(state, changed.rows[0]);
    }
    return {
      state,
      owned,
      close,
      async dispatch() {
        assert.equal(state.phase, 'prepared', 'EXECUTION_ALREADY_DISPATCHED');
        await update("phase='dispatching'");
      },
      async capture(bundle: unknown) {
        assert.equal(state.phase, 'dispatching');
        const bytes = Buffer.from(JSON.stringify(bundle));
        assert(bytes.length > 0 && bytes.length <= maxBundleBytes, 'CAPTURE_TOO_LARGE');
        const sha = digestOf(bytes);
        const temporary = resolve(root, `${sha}.${randomBytes(8).toString('hex')}.part`);
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await rename(temporary, resolve(root, sha));
          const folder = await open(root, 'r');
          try {
            await folder.sync();
          } finally {
            await folder.close();
          }
          await update("phase='captured',bundle_sha256=$2", [sha]);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      async bundle(): Promise<unknown> {
        const sha = state.bundle_sha256;
        assert(sha && /^[a-f0-9]{64}$/.test(sha), 'CAPTURE_MISSING');
        const handle = await open(resolve(root, sha), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          assert(stat.isFile() && stat.size > 0 && stat.size <= maxBundleBytes, 'CAPTURE_INVALID');
          const bytes = await handle.readFile();
          assert.equal(digestOf(bytes), sha, 'CAPTURE_CORRUPT');
          return JSON.parse(bytes.toString('utf8'));
        } finally {
          await handle.close();
        }
      },
      async interrupted() {
        await update("phase='interrupted'");
      },
      async cleaned() {
        await update('cleanup_at=coalesce(cleanup_at,clock_timestamp())');
      },
      async egress() {
        await update('egress_delivered=true');
      },
      async uploaded(count: number) {
        await update('uploaded_count=greatest(uploaded_count,$2)', [count]);
      },
      async delivered(receipt: Record<string, unknown>) {
        await update("phase='delivered',receipt=$2", [JSON.stringify(receipt)]);
      },
      async delivery() {
        await owned();
        // Reconcile authoritative records before every retry. This trusted local
        // controller already holds a DB connection; it never bypasses HTTP writes.
        const submission = (
          await client.query(
            `SELECT id,run_id,outcome,content_hash,egress_verification,submitted_at
           FROM evidence_submissions WHERE run_id=$1`,
            [runId],
          )
        ).rows[0];
        const artifacts = (
          await client.query(
            'SELECT name,kind,media_type,bytes,sha256 FROM evidence_artifacts WHERE run_id=$1',
            [runId],
          )
        ).rows;
        return { submission, artifacts };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
