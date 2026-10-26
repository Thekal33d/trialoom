import type { PoolClient } from 'pg';
import { Pool } from 'pg';

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw new Error('Invalid DATABASE_URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    url.pathname === '/'
  ) {
    throw new Error('Invalid DATABASE_URL');
  }
  return env.DATABASE_URL;
}

export function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    statement_timeout: 10000,
    application_name: 'trialoom',
  });
  pool.on('error', (error) => {
    const code = (error as { code?: string }).code;
    console.error(
      JSON.stringify({
        event: 'database.pool_error',
        code: code && /^[A-Z0-9]{5}$/.test(code) ? code : 'unknown',
      }),
    );
  });
  return pool;
}

const runtime = globalThis as typeof globalThis & { trialoomPool?: Pool };
export function getPool(): Pool {
  runtime.trialoomPool ??= createPool(databaseUrl());
  return runtime.trialoomPool;
}

export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
