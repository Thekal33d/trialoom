import assert from 'node:assert/strict';
import type { FreeRunner } from '../src/server/free-test-dispatch.ts';
import { projectFreeTestResult } from '../src/server/free-test-results.ts';
import { parseTarget } from '../src/server/targets.ts';
import { previewHost, previewIdentity } from './preview-host.ts';

export function configuredFreeOrigins(value = process.env.TRIALOOM_FREE_TARGET_ORIGINS ?? '') {
  if (!value.trim()) return [];
  const origins = value.split(',').map((part) => part.trim());
  assert(origins.length <= 20 && new Set(origins).size === origins.length);
  for (const origin of origins) assert.equal(parseTarget(origin).url.origin, origin);
  return origins;
}
/** Reuses the gVisor browser, network witness, bounded pipe and independent host timer. */
export function freePreviewRunner(
  image: string,
  allowedOrigins: string[],
  onStarted?: () => Promise<void>,
): FreeRunner {
  const hosts = new Map<string, ReturnType<typeof previewHost>>();
  return {
    image,
    allowedOrigins,
    async run(row, signal) {
      const sample = row.kind === 'sample';
      assert.equal(row.image, image);
      if (sample) {
        assert.deepEqual(row.target, {
          url: 'https://preview.example.com/',
          origin: 'https://preview.example.com',
          addresses: ['127.0.0.1'],
        });
      } else assert(allowedOrigins.includes(row.target.origin));
      const host = previewHost(row.image, !sample, signal, row.container_prefix);
      hosts.set(row.id, host);
      // The dispatcher records capture before cleanup and always calls cleanup separately.
      const identity = await previewIdentity(new URL(row.target.origin).hostname);
      signal.throwIfAborted();
      await host.prepare(
        {
          mode: sample ? 'owned' : 'public',
          target: row.target,
          readOnlyDependencies: [],
          blockedDependencyOrigins: [],
          identity,
          durationMs: 50000,
        },
        55,
      );
      const running = host.run({
        url: row.target.url,
        journey: sample ? 'owned' : 'homepage',
        durationMs: 45000,
        maxNavigations: 5,
      });
      await onStarted?.();
      const output = JSON.parse(await running);
      signal.throwIfAborted();
      const witness = await host.witness();
      return projectFreeTestResult(output, witness, sample);
    },
    async cleanup(row) {
      const host =
        hosts.get(row.id) ??
        previewHost(
          row.image,
          row.kind !== 'sample',
          new AbortController().signal,
          row.container_prefix,
        );
      await host.close();
      hosts.delete(row.id);
    },
  };
}
