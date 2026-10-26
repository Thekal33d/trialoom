import { randomUUID } from 'node:crypto';
import { createPool, databaseUrl } from '../../src/server/database.ts';
export async function disposableDatabase() {
  const url = new URL(databaseUrl());
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/trialoom_dev'
  )
    throw new Error('Tests require the isolated loopback trialoom_dev database');
  const name = `trialoom_test_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool(url.href);
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const pool = createPool(url.href);
  return {
    pool,
    url: url.href,
    async close() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
