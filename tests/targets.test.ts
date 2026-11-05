import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AppError } from '../src/domain/errors.ts';
import { validateTarget } from '../src/server/targets.ts';

const target = 'https://preview.example.com/';
const publicAddresses = ['93.184.215.14'];
const lookupError = (code: string) => Object.assign(new Error('Private resolver detail'), { code });

test('a slow successful lookup is accepted beyond the former three-second cutoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lookup = Promise.withResolvers<string[]>();
  const result = validateTarget(target, () => lookup.promise);
  t.mock.timers.tick(4000);
  lookup.resolve(publicAddresses);
  assert.deepEqual((await result).addresses, publicAddresses);
});

test('temporary OS lookup failures get one retry, including ambiguous ENOTFOUND', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const code of ['EAI_AGAIN', 'ESERVFAIL', 'ETIMEOUT', 'ENOTFOUND']) {
    let calls = 0;
    const result = validateTarget(target, async () => {
      if (++calls === 1) throw lookupError(code);
      return publicAddresses;
    });
    await setImmediate();
    t.mock.timers.tick(250);
    assert.deepEqual((await result).addresses, publicAddresses);
    assert.equal(calls, 2);
  }
});

test('a retry never bypasses validation of private or mixed DNS answers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const rejected = assert.rejects(
    validateTarget(target, async () => {
      if (++calls === 1) throw lookupError('EAI_AGAIN');
      return [...publicAddresses, '10.0.0.1'];
    }),
    (error: unknown) => error instanceof AppError && error.code === 'TARGET_PRIVATE',
  );
  await setImmediate();
  t.mock.timers.tick(250);
  await rejected;
  assert.equal(calls, 2);
});

test('persistent missing names and resolver outages fail after at most two attempts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [code, status, expectedCalls] of [
    ['ENOTFOUND', 400, 2],
    ['ENODATA', 400, 1],
    ['EAI_AGAIN', 503, 2],
    ['EACCES', 503, 1],
  ] as const) {
    let calls = 0;
    const rejected = assert.rejects(
      validateTarget(target, async () => {
        calls++;
        throw lookupError(code);
      }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'TARGET_UNRESOLVED');
        assert.equal(error.status, status);
        assert.doesNotMatch(error.message, /Private resolver detail|checking its DNS/);
        return true;
      },
    );
    await setImmediate();
    t.mock.timers.tick(250);
    await rejected;
    assert.equal(calls, expectedCalls);
  }
});

test('the total deadline includes retries and late completion cannot admit a target', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lookup = Promise.withResolvers<string[]>();
  let calls = 0;
  const rejected = assert.rejects(
    validateTarget(target, async () => {
      if (++calls === 1) throw lookupError('EAI_AGAIN');
      return lookup.promise;
    }),
    (error: unknown) =>
      error instanceof AppError && error.status === 503 && /took too long/.test(error.message),
  );
  await setImmediate();
  t.mock.timers.tick(250);
  await setImmediate();
  assert.equal(calls, 2);
  t.mock.timers.tick(7750);
  await rejected;
  lookup.resolve(publicAddresses);
  await setImmediate();
  assert.equal(calls, 2);
});

test('a lookup failing after the deadline cannot start a background retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lookup = Promise.withResolvers<string[]>();
  let calls = 0;
  const rejected = assert.rejects(
    validateTarget(target, () => {
      calls++;
      return lookup.promise;
    }),
    (error: unknown) => error instanceof AppError && error.status === 503,
  );
  t.mock.timers.tick(8000);
  await rejected;
  lookup.reject(lookupError('EAI_AGAIN'));
  await setImmediate();
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(calls, 1);
});
