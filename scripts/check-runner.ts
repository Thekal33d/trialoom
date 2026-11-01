import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  dockerCommand,
  inspectHost,
  reapExpiredOfflineRuns,
  removeOwnedContainer,
  resolveOwnedImage,
  runOfflineProbe,
} from '../runners/offline-host.ts';
import { offlineCreateArgs } from '../runners/offline-policy.ts';

const args = process.argv.slice(2);
assert(
  args.every((arg) => ['--doctor', '--reap-expired'].includes(arg)),
  'Unknown option.',
);
const host = await inspectHost();
console.log(JSON.stringify({ event: 'runner.host', ...host }));
if (args.includes('--doctor')) {
  process.exitCode = host.customerReady ? 0 : 2;
} else if (args.includes('--reap-expired')) {
  console.log(JSON.stringify({ event: 'runner.cleanup', removed: await reapExpiredOfflineRuns() }));
} else {
  // Only the cached official Node fixture image. No pulls, builds or mounts.
  const imageId = await resolveOwnedImage();
  console.log(JSON.stringify({ event: 'runner.owned_image', imageId }));
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    for (const probe of [
      'controls',
      'disk',
      'processes',
      'memory',
      'file',
      'cpu',
      'controls',
    ] as const) {
      const result = await runOfflineProbe({ imageId, probe, signal: stop.signal });
      // A cgroup may choose PID 1 rather than the allocating child as its OOM victim.
      if (probe === 'memory' && result.status === 'failed') {
        assert(result.oomKilled);
        assert.notEqual(result.exitCode, 0);
      } else {
        assert.equal(result.status, 'completed', `${probe}: ${result.status} (${result.exitCode})`);
        assert.equal(JSON.parse(result.output).passed, true);
      }
      assert(result.cleanupVerified);
      console.log(
        `PASS ${probe === 'controls' ? 'network, credentials, fresh scratch, limits and local fixture' : probe}`,
      );
    }
    const timed = await runOfflineProbe({
      imageId,
      probe: 'wait',
      timeoutMs: 700,
      signal: stop.signal,
    });
    assert.equal(timed.status, 'timed_out');
    assert(timed.cleanupVerified);
    console.log('PASS host deadline kills the workload and verifies deletion');

    const cancel = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = await runOfflineProbe({
      imageId,
      probe: 'wait',
      signal: AbortSignal.any([stop.signal, cancel.signal]),
      onStarted: () => {
        timer = setTimeout(() => cancel.abort(), 700);
      },
    }).finally(() => clearTimeout(timer));
    assert.equal(cancelled.status, 'cancelled');
    assert(cancelled.cleanupVerified);
    console.log('PASS cancellation kills the workload and verifies deletion');

    const output = await runOfflineProbe({ imageId, probe: 'output', signal: stop.signal });
    assert.equal(output.status, 'output_limit');
    assert.equal(output.output, '');
    assert(output.cleanupVerified);
    console.log('PASS output cap stops execution without retaining an oversized result');

    // No controller timer here. The fixed PID 1 timeout must independently end
    // a detached, hung owned fixture, including after a controller disappears.
    const name = `trialoom-offline-${randomBytes(16).toString('hex')}`;
    const create = offlineCreateArgs({ name, imageId, deadline: Date.now() + 30_000 });
    // Replace only Node's final '-' (stdin) with a fixed hung fixture argument.
    create.splice(create.length - 1, 1, '-e', 'setInterval(()=>{},1000)');
    assert.equal((await dockerCommand(create)).code, 0);
    try {
      assert.equal((await dockerCommand(['start', name])).code, 0);
      const deadline = Date.now() + 15_000;
      let state: { Running: boolean; ExitCode: number } | undefined;
      do {
        await delay(500, undefined, { signal: stop.signal });
        const check = await dockerCommand(['inspect', '--format', '{{json .State}}', name]);
        assert.equal(check.code, 0);
        state = JSON.parse(check.stdout);
      } while (state?.Running && Date.now() < deadline);
      assert.equal(state?.Running, false);
      assert.notEqual(state?.ExitCode, 0);
    } finally {
      await removeOwnedContainer(name);
    }
    console.log('PASS independent in-container deadline ends a detached hung fixture');
    const expired = `trialoom-offline-${randomBytes(16).toString('hex')}`;
    const active = `trialoom-offline-${randomBytes(16).toString('hex')}`;
    const recoveryNames: string[] = [];
    try {
      for (const [name, deadline] of [
        [expired, Date.now() - 1],
        [active, Date.now() + 45_000],
      ] as const) {
        assert.equal((await dockerCommand(offlineCreateArgs({ name, imageId, deadline }))).code, 0);
        recoveryNames.push(name);
      }
      assert.equal(await reapExpiredOfflineRuns(), 1);
      recoveryNames.splice(recoveryNames.indexOf(expired), 1);
      assert.equal((await dockerCommand(['container', 'inspect', active])).code, 0);
    } finally {
      for (const name of recoveryNames) await removeOwnedContainer(name);
    }
    console.log('PASS recovery removes an expired owned run and preserves a current one');
    console.log('Offline runner checks passed. Customer preview execution remains gated.');
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
