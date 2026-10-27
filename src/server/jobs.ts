import type { Pool, PoolClient } from 'pg';
import { transaction } from './database.ts';

export type JobLease = {
  id: string;
  topic: string;
  lease_token: string;
  attempts: number;
  payload: unknown;
};

/**
 * Enqueues in the caller's transaction, so a business write and its job commit
 * together or not at all. The dedupe key makes a repeated event one job.
 */
export async function enqueueJob(
  db: Pool | PoolClient,
  topic: string,
  key: string,
  payload: Record<string, unknown>,
): Promise<string> {
  if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(key)) throw new Error('Invalid job identity');
  const result = await db.query<{ id: string }>(
    `INSERT INTO outbox_jobs (topic, dedupe_key, payload) VALUES ($1,$2,$3)
    ON CONFLICT (dedupe_key) DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key RETURNING id`,
    [topic, key, JSON.stringify(payload)],
  );
  return result.rows[0].id;
}

export async function enqueuePing(db: Pool | PoolClient, key: string): Promise<string> {
  return enqueueJob(db, 'system.ping', key, { version: 1 });
}

/** Finishes a leased job. A lost lease finishes nothing. */
export async function completeJob(pool: Pool, lease: JobLease): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE outbox_jobs SET state='done',completed_at=clock_timestamp(),lease_token=NULL,
    lease_until=NULL WHERE id=$1 AND lease_token=$2 AND state='leased'`,
    [lease.id, lease.lease_token],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Returns a job to the queue after a wait that is not a failure, such as a
 * payout whose recipient or payment authority does not exist yet. Waiting must
 * not exhaust the attempts that protect against a genuinely failing handler.
 */
export async function rescheduleJob(
  pool: Pool,
  lease: JobLease,
  seconds: number,
  keepAttempts = false,
): Promise<void> {
  await pool.query(
    `UPDATE outbox_jobs SET state='pending',lease_token=NULL,lease_until=NULL,
    attempts=CASE WHEN $3 THEN attempts ELSE 0 END,
    available_at=clock_timestamp()+make_interval(secs=>$2)
    WHERE id=$1 AND state='leased'`,
    [lease.id, seconds, keepAttempts],
  );
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

/** Handlers are passed in, so the queue stays unaware of what it dispatches. */
export type JobHandler = (pool: Pool, lease: JobLease) => Promise<string>;
export async function processOne(
  pool: Pool,
  handlers: Record<string, JobHandler> = {},
): Promise<boolean> {
  const lease = await claimJob(pool);
  if (!lease) return false;
  const handler = handlers[lease.topic];
  if (handler) {
    const outcome = await handler(pool, lease);
    console.log(JSON.stringify({ event: 'job.handled', topic: lease.topic, outcome }));
    return true;
  }
  const completed = await completePing(pool, lease);
  console.log(
    JSON.stringify({ event: completed ? 'job.completed' : 'job.lease_lost', jobId: lease.id }),
  );
  return true;
}
