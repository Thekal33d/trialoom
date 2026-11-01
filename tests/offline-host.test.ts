import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type DockerCommand,
  inspectHost,
  reapExpiredOfflineRuns,
  removeOwnedContainer,
  resolveOwnedImage,
  runOfflineProbe,
} from '../runners/offline-host.ts';
import {
  customerRunnerGates,
  offlineCreateArgs,
  requireOfflineHost,
} from '../runners/offline-policy.ts';

const name = `trialoom-offline-${'a'.repeat(32)}`;
const imageId = `sha256:${'b'.repeat(64)}`;
const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const owned = (deadline: number) => ({
  Name: `/${name}`,
  Config: {
    Labels: {
      'trialoom.runner.policy': 'offline-runner-v1',
      'trialoom.runner.deadline': String(deadline),
    },
  },
});

test('customer gate cannot silently fall back to runc or infer readiness from runsc registration', () => {
  const host = { linux: true, cgroupV2: true, seccomp: true, runtimes: ['runc'] };
  assert(customerRunnerGates(host).includes('GVISOR_NOT_INSTALLED'));
  assert(
    customerRunnerGates({ ...host, runtimes: ['runc', 'runsc'] }).includes(
      'GVISOR_BROWSER_VALIDATION_REQUIRED',
    ),
  );
  for (const key of ['linux', 'cgroupV2', 'seccomp'] as const)
    assert.throws(
      () => requireOfflineHost({ ...host, [key]: false }),
      /OFFLINE_HOST_CONTROLS_UNAVAILABLE/,
    );
});

test('invalid job identity/image and caller supplied probes fail before Docker can run', async () => {
  for (const input of [
    { name: '../../another', imageId, deadline: 1 },
    { name, imageId: 'node:latest', deadline: 1 },
    { name, imageId, deadline: Number.NaN },
  ])
    assert.throws(() => offlineCreateArgs(input), /INVALID_OFFLINE_JOB/);
  await assert.rejects(
    runOfflineProbe({ imageId, probe: 'controls', timeoutMs: 99 }),
    /INVALID_TIME_LIMIT/,
  );
  await assert.rejects(
    runOfflineProbe({ imageId, probe: '__proto__' as 'controls' }),
    /UNKNOWN_OWNED_PROBE/,
  );
  await assert.rejects(resolveOwnedImage('--privileged'), /INVALID_IMAGE_REFERENCE/);
});

test('image-declared volumes cannot bypass the no-mount policy', async () => {
  await assert.rejects(
    resolveOwnedImage('node:22', async () =>
      ok([{ Id: imageId, Config: { Volumes: { '/host': {} } } }]),
    ),
    /IMAGE_VOLUMES_FORBIDDEN/,
  );
  assert.equal(
    await resolveOwnedImage('node:22', async () => ok([{ Id: imageId, Config: {} }])),
    imageId,
  );
});

test('doctor reports missing controls without exposing host fields or secrets', async () => {
  const result = await inspectHost(async () =>
    ok({
      OSType: 'linux',
      CgroupVersion: '2',
      Runtimes: { runc: {} },
      SecurityOptions: ['name=seccomp,profile=builtin'],
      Name: 'private-hostname',
      secret: 'private',
    }),
  );
  assert.equal(result.customerReady, false);
  assert(result.customerGates.includes('GVISOR_NOT_INSTALLED'));
  assert(!JSON.stringify(result).includes('private'));
});

test('cleanup refuses an unrelated container and a daemon outage is not success', async () => {
  let calls = 0;
  await assert.rejects(
    removeOwnedContainer(name, async () => {
      calls++;
      return ok([{ ...owned(1), Name: '/another' }]);
    }),
    /CONTAINER_OWNERSHIP_MISMATCH/,
  );
  assert.equal(calls, 1);
  let step = 0;
  await assert.rejects(
    removeOwnedContainer(name, async () => {
      step++;
      if (step === 1) return ok([owned(1)]);
      if (step === 2) return { code: 0, stdout: name, stderr: '' };
      return { code: 1, stdout: '', stderr: 'unavailable' };
    }),
    /CLEANUP_UNVERIFIED/,
  );
});

test('reaper removes only expired owned runs; active and malformed deadlines survive', async () => {
  for (const deadline of [101, Number.NaN, 0]) {
    let calls = 0;
    const command: DockerCommand = async () => {
      calls++;
      return calls === 1
        ? { code: 0, stdout: `${name}\nunrelated`, stderr: '' }
        : ok([owned(deadline)]);
    };
    assert.equal(await reapExpiredOfflineRuns(100, command), 0);
    assert.equal(calls, 2);
  }
  const commands: string[][] = [];
  assert.equal(
    await reapExpiredOfflineRuns(100, async (args) => {
      commands.push(args);
      if (args[1] === 'inspect') return ok([owned(99)]);
      if (commands.length === 1) return { code: 0, stdout: name, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }),
    1,
  );
  assert.equal(commands.filter((args) => args[1] === 'rm').length, 1);
});
