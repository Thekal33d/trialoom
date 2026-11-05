import assert from 'node:assert/strict';
import { buildPreviewImage, previewHost, previewIdentity } from './preview-host.ts';

const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const host = previewHost(await buildPreviewImage(), false, abort.signal);
try {
  await host.prepare(
    {
      mode: 'owned',
      target: {
        url: 'https://preview.example.com/',
        origin: 'https://preview.example.com',
        addresses: ['127.0.0.1'],
      },
      readOnlyDependencies: [],
      blockedDependencyOrigins: [],
      identity: await previewIdentity('preview.example.com'),
      durationMs: 45000,
    },
    55,
  );
  const output = JSON.parse(
    await host.run({
      url: 'https://preview.example.com/',
      journey: 'owned',
      durationMs: 40000,
      maxNavigations: 5,
    }),
  );
  assert.equal(output.outcome, 'executed');
  assert(
    output.assertions.length > 0 && output.assertions.every((a: { passed: boolean }) => a.passed),
  );
  const witness = await host.witness();
  assert(witness.closed && witness.observations.length > 0);
  console.log(
    JSON.stringify({
      event: 'runner.smoke_passed',
      platform: process.platform,
      checks: output.assertions.length,
      witnessed: true,
      publicTargetsContacted: false,
    }),
  );
} finally {
  await host.close();
  assert.equal(host.present(), '');
}
