import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  acceptInvitation,
  bootstrapWorkspace,
  createInvitation,
} from '../src/server/invitations.ts';
import { migrate } from '../src/server/migrations.ts';
import { createProject } from '../src/server/projects.ts';
import { disposableDatabase } from '../tests/helpers/database.ts';

const db = await disposableDatabase();
const directory = resolve('artifacts/browser-checks', randomBytes(8).toString('hex'));
try {
  await migrate(db.pool);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString('base64url');
  const fixtures: Record<string, unknown> = {};
  for (const viewport of ['desktop', 'mobile']) {
    const ownerEmail = `${viewport}-owner@example.test`;
    const first = await bootstrapWorkspace(db.pool, {
      email: ownerEmail,
      name: `${viewport} workspace`,
    });
    await acceptInvitation(db.pool, { token: first.token, name: 'Test builder', password }, null);
    const owner = (
      await db.pool.query('SELECT id,email,name FROM auth_user WHERE email=$1', [ownerEmail])
    ).rows[0];
    for (const role of ['reviewer', 'operator']) {
      const invite = await createInvitation(db.pool, owner, first.workspaceId, {
        email: `${viewport}-${role}@example.test`,
        role,
      });
      await acceptInvitation(
        db.pool,
        { token: invite.token, name: `Test ${role}`, password },
        null,
      );
    }
    const project = await createProject(
      db.pool,
      owner,
      first.workspaceId,
      {
        name: 'Seeded private project',
        targetUrl: 'https://example.com/',
        environment: 'preview',
        authorizationConfirmed: true,
      },
      async () => ['93.184.215.14'],
    );
    const join = await bootstrapWorkspace(db.pool, {
      email: `${viewport}-join@example.test`,
      name: 'Invited browser workspace',
    });
    fixtures[viewport] = {
      password,
      ownerEmail,
      workspaceId: first.workspaceId,
      projectId: project.id,
      joinToken: join.token,
      reviewerEmail: `${viewport}-reviewer@example.test`,
      operatorEmail: `${viewport}-operator@example.test`,
    };
  }
  const fixtureFile = resolve(directory, 'fixtures.json');
  await writeFile(fixtureFile, JSON.stringify(fixtures), { mode: 0o600 });
  const child = spawn(
    process.execPath,
    ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: db.url,
        BETTER_AUTH_URL: 'http://127.0.0.1:3100',
        BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'),
        PLAYWRIGHT_BROWSERS_PATH: '.cache/ms-playwright',
        TRIALOOM_E2E_FIXTURE: fixtureFile,
      },
    },
  );
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const result = await new Promise<number>((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => done(code ?? 1));
  });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  process.exitCode = result;
} finally {
  await db.close();
  await rm(directory, { recursive: true, force: true });
}
