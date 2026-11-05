import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AppError } from '../src/domain/errors.ts';
import { evidenceStorageConfig, getObject, putObject } from '../src/server/storage.ts';

const code = (value: string) => (e: unknown) => e instanceof AppError && e.code === value;

test('private S3 transport uses authenticated content keys and verifies retrieved bytes', async () => {
  const objects = new Map<string, Buffer>();
  let corrupt = false;
  let unavailable = false;
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    assert.match(request.headers.authorization ?? '', /^AWS4-HMAC-SHA256 /);
    assert.equal(request.headers['x-amz-acl'], undefined);
    const path = new URL(request.url ?? '', 'http://127.0.0.1').pathname;
    assert.match(path, /^\/private-fixture\/evidence\/[a-f0-9]{2}\/[a-f0-9]{64}$/);
    if (unavailable) {
      response.writeHead(503);
      response.end('<Error><Code>ServiceUnavailable</Code></Error>');
      return;
    }
    if (request.method === 'PUT') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      objects.set(path, Buffer.concat(chunks));
      response.writeHead(200);
      response.end();
      return;
    }
    const bytes = corrupt ? Buffer.from('corrupted') : objects.get(path);
    response.writeHead(bytes ? 200 : 404, bytes ? { 'content-length': bytes.length } : {});
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    TRIALOOM_S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
    TRIALOOM_S3_BUCKET: 'private-fixture',
    TRIALOOM_S3_ACCESS_KEY_ID: 'fixture-only',
    TRIALOOM_S3_SECRET_ACCESS_KEY: 'fixture-not-a-real-secret',
  };
  try {
    const original = Buffer.from('Synthetic evidence, no customer content.');
    const saved = await putObject(original, env);
    assert.deepEqual(await getObject(saved.key, { ...env }), original);
    assert.deepEqual(await putObject(original, env), saved);
    assert.equal(objects.size, 1);
    corrupt = true;
    await assert.rejects(getObject(saved.key, env), code('ARTIFACT_CORRUPT'));
    const before = requests;
    await assert.rejects(getObject('../../somewhere', env), code('ARTIFACT_UNAVAILABLE'));
    assert.equal(requests, before);
    unavailable = true;
    await assert.rejects(putObject(original, env), code('ARTIFACT_STORE_UNAVAILABLE'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('partial or insecure hosted configuration never falls back to local evidence', async () => {
  assert.equal(evidenceStorageConfig({ NODE_ENV: 'test' }), null);
  assert.throws(
    () => evidenceStorageConfig({ NODE_ENV: 'production', TRIALOOM_S3_BUCKET: 'private-fixture' }),
    code('STORAGE_NOT_CONFIGURED'),
  );
  assert.throws(
    () =>
      evidenceStorageConfig({
        NODE_ENV: 'production',
        TRIALOOM_S3_ENDPOINT: 'http://127.0.0.1',
        TRIALOOM_S3_BUCKET: 'private-fixture',
        TRIALOOM_S3_ACCESS_KEY_ID: 'x',
        TRIALOOM_S3_SECRET_ACCESS_KEY: 'y',
      }),
    code('STORAGE_NOT_CONFIGURED'),
  );
});
test('local storage remains private and refuses on-disk corruption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trialoom-evidence-'));
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', TRIALOOM_EVIDENCE_DIR: directory };
  try {
    const saved = await putObject(Buffer.from('local fixture'), env);
    const path = join(directory, saved.key.slice(0, 2), saved.key);
    assert.deepEqual(await getObject(saved.key, env), await readFile(path));
    await writeFile(path, 'different bytes');
    await assert.rejects(getObject(saved.key, env), code('ARTIFACT_CORRUPT'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
