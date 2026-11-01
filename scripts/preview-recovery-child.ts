import assert from 'node:assert/strict';
import { createPool, databaseUrl } from '../src/server/database.ts';
import { executePreviewRun } from './preview-controller.ts';

// Owned crash harness only. Credentials arrive over stdin, never argv or journal.
const chunks: Buffer[] = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  assert(size <= 16384);
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
assert.equal(input.mode, 'owned');
const pool = createPool(databaseUrl());
try {
  const result = await executePreviewRun({
    ...input,
    journal: { pool, directory: input.directory },
    checkpoint: async (stage) => {
      if (stage !== input.stopAt) return;
      process.send?.({ checkpoint: stage });
      // Parent sends SIGKILL. No exception/finally cleanup can simulate this.
      await new Promise(() => {});
    },
  });
  process.send?.({
    completed: true,
    submissionId: result.receipt.submissionId,
    hash: result.receipt.contentHash,
  });
} catch (error) {
  const message = error instanceof Error ? error.message.split('\n')[0] : '';
  process.send?.({ error: /^[A-Z_]+$/.test(message) ? message : 'CHECK_FAILED' });
  process.exitCode = 1;
} finally {
  await pool.end();
  process.disconnect?.();
}
