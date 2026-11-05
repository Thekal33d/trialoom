import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const script = resolve('scripts/trialoom-operator.ts');
test('operator client preserves a lost claim response and does not print credentials or attempt grants', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trialoom-operator-'));
  const token = randomBytes(32).toString('base64url');
  const requestId = randomUUID(),
    campaignId = randomUUID(),
    assignmentId = randomUUID(),
    attemptToken = randomUUID();
  const claims: string[] = [];
  let executions = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.url === '/api/agent/v1/assignments') {
      claims.push(String(request.headers['idempotency-key']));
      if (claims.length === 1) {
        request.socket.destroy();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ assignmentId, attemptToken }));
    } else if (request.url === `/api/agent/v1/assignments/${assignmentId}/execute`) {
      executions++;
      let body = '';
      for await (const part of request) body += part;
      assert.deepEqual(JSON.parse(body), { attemptToken });
      response.end(JSON.stringify({ id: 'same-job', state: 'queued' }));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const run = (args: string[]) =>
    promisify(execFile)(process.execPath, [script, '--origin', origin, ...args], {
      cwd: directory,
      env: { ...process.env, TRIALOOM_OPERATOR_TOKEN: token },
      timeout: 10000,
    });
  try {
    const claim = ['--claim', campaignId, '--request-id', requestId];
    await assert.rejects(run(claim));
    const path = join(directory, 'artifacts/operator-claims', `${requestId}.json`);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).requestId, requestId);
    const result = await run(claim);
    await run(claim);
    assert.deepEqual(claims, [requestId, requestId]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(result.stdout.includes(token), false);
    assert.equal(result.stdout.includes(attemptToken), false);
    const executed = await run(['--execute', path]);
    assert.equal(executions, 1);
    assert.equal(executed.stdout.includes(attemptToken), false);
    await assert.rejects(
      run(['--claim', randomUUID(), '--request-id', requestId]),
      /different saved claim/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('operator client refuses unsafe credential destinations before making a request', async () => {
  for (const origin of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com?token=x',
  ]) {
    await assert.rejects(
      promisify(execFile)(process.execPath, [script, '--origin', origin], {
        env: { ...process.env, TRIALOOM_OPERATOR_TOKEN: 'a'.repeat(43) },
      }),
      /HTTPS origin/,
    );
  }
});
