import type { Pool, PoolClient } from 'pg';
import { transaction } from './database.ts';

export type JobLease = {
  id: string;
  topic: string;
  lease_token: string;
  attempts: number;
  payload: unknown;
};

export async function enqueuePing(db: Pool | PoolClient, key: string): Promise<string> {
  if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(key)) throw new Error('Invalid job identity');
  const result = await db.query<{ id: string }>(
    `INSERT INTO outbox_jobs (topic, dedupe_key, payload)
    VALUES ('system.ping', $1, '{"version":1}') ON CONFLICT (dedupe_key)
    DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key RETURNING id`,
    [key],
  );
  return result.rows[0].id;
}

export async function claimJob(pool: Pool, leaseSeconds = 30): Promise<JobLease | null> {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300)
    throw new Error('Invalid job lease');
  return transaction(pool, async (client) => {
    await client.query(`UPDATE outbox_jobs SET state = 'dead', lease_token = NULL, lease_until = NULL
      WHERE state = 'leased' AND lease_until <= clock_timestamp() AND attempts >= 5`);
    const result = await client.query<JobLease>(
      `UPDATE outbox_jobs SET state = 'leased', attempts = attempts + 1,
      lease_token = gen_random_uuid(), lease_until = clock_timestamp() + ($1 * interval '1 second')
      WHERE id = (SELECT id FROM outbox_jobs WHERE attempts < 5 AND available_at <= clock_timestamp()
        AND (state = 'pending' OR (state = 'leased' AND lease_until <= clock_timestamp()))
        ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, topic, lease_token, attempts, payload`,
      [leaseSeconds],
    );
    return result.rows[0] ?? null;
  });
}

export async function completePing(pool: Pool, lease: JobLease): Promise<boolean> {
  return transaction(pool, async (client) => {
    const current = await client.query(
      `SELECT id, topic, payload FROM outbox_jobs
      WHERE id = $1 AND lease_token = $2 AND state = 'leased' AND lease_until > clock_timestamp() FOR UPDATE`,
      [lease.id, lease.lease_token],
    );
    const job = current.rows[0];
    if (!job) return false;
    if (job.topic !== 'system.ping' || job.payload?.version !== 1)
      throw new Error('Unsupported job handler');
    await client.query(
      `INSERT INTO worker_effects (job_id, kind) VALUES ($1, 'system.ping') ON CONFLICT DO NOTHING`,
      [lease.id],
    );
    await client.query(
      `UPDATE outbox_jobs SET state = 'done', completed_at = clock_timestamp(), lease_token = NULL,
      lease_until = NULL WHERE id = $1 AND lease_token = $2`,
      [lease.id, lease.lease_token],
    );
    return true;
  });
}

export async function processOne(pool: Pool): Promise<boolean> {
  const lease = await claimJob(pool);
  if (!lease) return false;
  const completed = await completePing(pool, lease);
  console.log(
    JSON.stringify({ event: completed ? 'job.completed' : 'job.lease_lost', jobId: lease.id }),
  );
  return true;
}
