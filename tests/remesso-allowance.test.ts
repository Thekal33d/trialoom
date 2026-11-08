import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOWANCE, allowanceAbi, CHAIN_ID } from 'remesso-sdk';
import { allowanceCreateAbi, remessoAllowance } from '../src/domain/remesso-allowance.ts';

// The browser copy of this contract's details must not drift from the SDK the
// server settles with. A mismatch here is a builder approving the wrong
// contract, which no amount of careful UI copy would make safe.
test('the client copy of the allowance contract matches the SDK deployment', () => {
  assert.equal(remessoAllowance.address.toLowerCase(), String(ALLOWANCE).toLowerCase());
  assert.equal(remessoAllowance.chainId, Number(CHAIN_ID));
});

test('the copied createPolicy signature matches the SDK ABI', () => {
  const ours = allowanceCreateAbi.find((item) => item.name === 'createPolicy');
  const theirs = allowanceAbi.find(
    (item: { type: string; name?: string }) =>
      item.type === 'function' && item.name === 'createPolicy',
  );
  assert(ours && theirs, 'createPolicy must exist in both');
  const shape = (abi: { inputs: readonly { name: string; type: string }[] }) =>
    abi.inputs.map((input) => `${input.name}:${input.type}`).join(',');
  assert.equal(shape(ours), shape(theirs));
});

test('the copied PolicyCreated event matches the SDK ABI', () => {
  const ours = allowanceCreateAbi.find((item) => item.name === 'PolicyCreated');
  const theirs = allowanceAbi.find(
    (item: { type: string; name?: string }) =>
      item.type === 'event' && item.name === 'PolicyCreated',
  );
  assert(ours && theirs, 'PolicyCreated must exist in both');
  const shape = (abi: { inputs: readonly { name: string; type: string; indexed?: boolean }[] }) =>
    abi.inputs.map((input) => `${input.name}:${input.type}:${Boolean(input.indexed)}`).join(',');
  assert.equal(shape(ours), shape(theirs));
});
