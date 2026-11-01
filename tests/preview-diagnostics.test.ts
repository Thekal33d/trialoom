import assert from 'node:assert/strict';
import test from 'node:test';
import { brokerFailure, readBrokerFailure } from '../runners/preview-diagnostics.ts';

test('broker diagnostics retain closed reason and origin index without error data', () => {
  const line = brokerFailure(
    Object.assign(new Error('private-url?token=fixture-canary'), {
      code: 'TARGET_UNRESOLVED',
      originIndex: 2,
      target: 'fixture-canary',
    }),
    'ADMISSION',
  );
  assert.equal(line, 'PREVIEW_BROKER_FAILED:ADMISSION:TARGET_UNRESOLVED:2');
  assert.equal(readBrokerFailure(`${line}\n`), line);
  assert.equal(
    brokerFailure(new Error('fixture-canary'), 'INPUT'),
    'PREVIEW_BROKER_FAILED:INPUT:INTERNAL:-',
  );
  for (const value of [
    `${line}:fixture-canary`,
    line.replace('ADMISSION', 'fixture-canary'),
    line.replace(':2', ':99'),
    'fixture-canary',
    'x'.repeat(16385),
  ])
    assert.equal(readBrokerFailure(value), undefined);
});
