import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const directory = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
export async function migrationFiles() {
  const files = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(directory, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

export async function migrate(pool: Pool): Promise<string[]> {
  const files = await migrationFiles();
  if (!files.length) throw new Error('No migration files');
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(782341902)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    const registry = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    for (const recorded of registry.rows) {
      if (files.find((file) => file.name === recorded.name)?.checksum !== recorded.checksum) {
        throw new Error(`Applied migration modified or missing: ${recorded.name}`);
      }
    }
    for (const file of files) {
      if (registry.rows.some((row) => row.name === file.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file.name,
          file.checksum,
        ]);
        await client.query('COMMIT');
        applied.push(file.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(782341902)').catch(() => undefined);
    client.release();
  }
}
