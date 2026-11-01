import assert from 'node:assert/strict';
import test from 'node:test';
import { ladderResponse } from '../runners/preview-ladder.ts';

const body = (data: unknown) => Buffer.from(JSON.stringify(data));

test('ladder compares the total player count, not the limited standings page length', () => {
  const result = ladderResponse(body({ players: 103, standings: Array(25).fill({}) }));
  assert.equal(result.count, 103);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(ladderResponse(body({ players: 0, standings: [] })).count, 0);
});

test('ladder rejects the previously assumed shape, inconsistent counts and oversized responses', () => {
  for (const data of [
    { players: [{}] },
    { players: 1, standings: [{}, {}] },
    { players: 25, standings: Array(26).fill({}) },
    { players: '25', standings: [] },
    { players: -1, standings: [] },
    { players: 1.5, standings: [] },
    { players: Number.MAX_SAFE_INTEGER + 1, standings: [] },
    null,
  ])
    assert.throws(() => ladderResponse(body(data)), /LADDER_SHAPE_INVALID/);
  assert.throws(() => ladderResponse(Buffer.alloc(512 * 1024 + 1)), /LADDER_RESPONSE_TOO_LARGE/);
});
