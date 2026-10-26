import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authSettings } from '../src/server/auth/config.ts';
import { createPool, databaseUrl } from '../src/server/database.ts';
import { bootstrapWorkspace } from '../src/server/invitations.ts';

const pool = createPool(databaseUrl());
try {
  const [email, ...words] = process.argv.slice(2);
  if (!email || !words.length)
    throw new Error('Usage: npm run workspace:invite -- owner@example.com Workspace name');
  const settings = authSettings();
  const invitation = await bootstrapWorkspace(pool, { email, name: words.join(' ') });
  const directory = 'artifacts/invitations';
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${invitation.id}.txt`);
  await writeFile(
    file,
    `${settings.baseURL}/join#token=${invitation.token}\nExpires: ${invitation.expiresAt.toISOString()}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log(`Workspace created. Private owner invitation saved to ${file}. No message was sent.`);
} catch {
  console.error('Invitation could not be created. Check configuration, email, and workspace name.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
