import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** A private production-build process; no signing or background worker. */
export async function startLocalServer(databaseUrl: string, directory: string) {
  await access('.next/BUILD_ID').catch(() => {
    throw new Error('Run npm run build first.');
  });
  const socket = createServer();
  await new Promise<void>((done, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', done);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port available.');
  await new Promise<void>((done) => socket.close(() => done()));
  const origin = `http://127.0.0.1:${address.port}`;
  const child = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(address.port),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'),
        TRIALOOM_EVIDENCE_DIR: resolve(directory, 'evidence'),
        TRIALOOM_REMESSO_AGENT_KEY: '',
        TRIALOOM_FEE_RECIPIENT: '',
        TRIALOOM_RESOURCE_RECIPIENT: '',
      },
    },
  );
  let stopped = false;
  let listening = false;
  // Only trust readiness from our own child, never an existing port occupant.
  child.stdout?.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('Ready in')) listening = true;
  });
  child.stderr?.resume();
  const exited = new Promise<void>((done) => {
    child.once('exit', () => {
      stopped = true;
      done();
    });
    child.once('error', () => {
      stopped = true;
      done();
    });
  });
  const close = async () => {
    if (stopped) return;
    child.kill('SIGTERM');
    await Promise.race([exited, delay(5000, undefined, { ref: false })]);
    if (!stopped) {
      child.kill('SIGKILL');
      await exited;
    }
  };
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (stopped) throw new Error('Local app failed to start. Check the build and database.');
      if (listening) {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) return { origin, close, exited };
      }
      await delay(500);
    }
    throw new Error('Local app readiness timed out.');
  } catch (error) {
    await close();
    throw error;
  }
}
