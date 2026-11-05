import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runnerCommand } from './runner-command.ts';

// Dedicated host only. No arbitrary SSH host or shell arguments.
const environment = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test' as const };
function remote(args: string[], input?: Buffer, timeout = 30_000) {
  const command = runnerCommand(args);
  const result = spawnSync(command.command, command.args, {
    env: environment,
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // Only owned setup/fixture output exists on this dedicated test machine.
    throw new Error(
      `Dedicated runner command failed: ${result.error?.message ?? `${result.stderr}\n${result.stdout}`.slice(-6000)}`,
    );
  }
  return result.stdout.trim();
}
function inspectImage(name: string) {
  return JSON.parse(remote(['docker', 'image', 'inspect', name]))[0];
}

const version = JSON.parse(
  await readFile('node_modules/playwright-core/package.json', 'utf8'),
).version;
assert.equal(version, '1.64.1');
const runtime = JSON.parse(remote(['docker', 'info', '--format', '{{json .Runtimes}}']));
assert(runtime.runsc, 'The dedicated host must have runsc; never fall back to runc.');
const base = inspectImage('node:24-bookworm-slim');
const digest = base.RepoDigests.find((value: string) =>
  /^(?:docker\.io\/library\/)?node@sha256:[a-f0-9]{64}$/.test(value),
);
assert(digest, 'An immutable official Node image digest is required.');

await mkdir('artifacts/gvisor-builds', { recursive: true, mode: 0o700 });
const directory = await mkdtemp(resolve('artifacts/gvisor-builds/context-'));
try {
  for (const name of ['Dockerfile', 'browser.mjs'])
    await cp(`runners/gvisor-check/${name}`, `${directory}/${name}`);
  await cp('node_modules/playwright-core', `${directory}/playwright-core`, { recursive: true });
  await cp('spikes/browser-evidence/fixture.mjs', `${directory}/fixture.mjs`);
  await cp('spikes/browser-evidence/fixture', `${directory}/fixture`, { recursive: true });
  const archive = spawnSync(
    'tar',
    [
      '-C',
      directory,
      '-cf',
      '-',
      'Dockerfile',
      'browser.mjs',
      'fixture.mjs',
      'fixture',
      'playwright-core',
    ],
    {
      env: environment,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10_000,
    },
  );
  assert.equal(archive.status, 0);
  remote(
    [
      'docker',
      'build',
      '--force-rm=true',
      '--pull=false',
      '--build-arg',
      `BASE_IMAGE=${digest}`,
      '-t',
      'trialoom-gvisor-check:local',
      '-',
    ],
    archive.stdout,
    600_000,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
const image = inspectImage('trialoom-gvisor-check:local');
assert(/^sha256:[a-f0-9]{64}$/.test(image.Id));
assert.equal(Object.keys(image.Config.Volumes ?? {}).length, 0);
console.log(
  JSON.stringify({ event: 'gvisor.browser_image', baseDigest: digest, imageId: image.Id }),
);

const cancelled = new AbortController();
const abort = () => cancelled.abort();
process.once('SIGINT', abort);
process.once('SIGTERM', abort);
try {
  for (let attempt = 1; attempt <= 2; attempt++) {
    assert(!cancelled.signal.aborted);
    const name = `trialoom-gvisor-${randomBytes(16).toString('hex')}`;
    try {
      remote([
        'docker',
        'create',
        '--pull=never',
        '--name',
        name,
        '--label=trialoom.runner.policy=gvisor-owned-browser-v1',
        '--runtime=runsc',
        '--network=none',
        '--read-only',
        '--user=65534:65534',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--memory=1g',
        '--memory-swap=1g',
        '--pids-limit=256',
        '--cpus=1',
        '--ipc=private',
        '--cgroupns=private',
        '--ulimit=nofile=1024:1024',
        '--ulimit=nproc=256:256',
        '--ulimit=fsize=16777216:16777216',
        '--ulimit=core=0:0',
        // gVisor otherwise adds an implicit writable /tmp when the image's is empty.
        '--tmpfs=/tmp:ro,nosuid,nodev,noexec,size=1m',
        '--tmpfs=/scratch:rw,nosuid,nodev,noexec,size=128m,mode=0700,uid=65534,gid=65534',
        '--shm-size=64m',
        '--log-driver=none',
        '--restart=no',
        '--no-healthcheck',
        image.Id,
      ]);
      const before = JSON.parse(remote(['docker', 'inspect', name]))[0];
      assert.equal(before.HostConfig.Runtime, 'runsc');
      assert.equal(before.HostConfig.NetworkMode, 'none');
      assert.equal(before.HostConfig.ReadonlyRootfs, true);
      assert.equal(before.Config.User, '65534:65534');
      assert.deepEqual(before.HostConfig.CapDrop, ['ALL']);
      assert(before.HostConfig.SecurityOpt.includes('no-new-privileges'));
      assert.equal(before.HostConfig.Memory, 1024 ** 3);
      assert.equal(before.HostConfig.MemorySwap, 1024 ** 3);
      assert.equal(before.HostConfig.PidsLimit, 256);
      assert.equal(before.HostConfig.NanoCpus, 1_000_000_000);
      assert.equal(before.HostConfig.Tmpfs['/tmp'], 'ro,nosuid,nodev,noexec,size=1m');
      assert.equal(before.Image, image.Id);
      assert((before.Mounts ?? []).every((entry: { Type: string }) => entry.Type === 'tmpfs'));
      const output = await new Promise<string>((done, reject) => {
        const command = runnerCommand(['docker', 'start', '--attach', name]);
        const child = spawn(command.command, command.args, {
          env: environment,
        });
        let bytes = 0;
        let text = '';
        let error = '';
        let stopped = false;
        const kill = () => {
          if (stopped) return;
          stopped = true;
          try {
            remote(['docker', 'kill', name]);
          } catch {
            // The finally block must still verify removal if kill lost its response.
          } finally {
            child.kill('SIGKILL');
          }
        };
        const timer = setTimeout(kill, 50_000);
        cancelled.signal.addEventListener('abort', kill, { once: true });
        child.stdout.on('data', (buffer) => {
          bytes += buffer.length;
          if (bytes > 64 * 1024) kill();
          else text += buffer;
        });
        child.stderr.on('data', (buffer) => {
          bytes += buffer.length;
          if (bytes > 64 * 1024) kill();
          else error += buffer;
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          cancelled.signal.removeEventListener('abort', kill);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          cancelled.signal.removeEventListener('abort', kill);
          if (code === 0 && !stopped && !cancelled.signal.aborted && bytes <= 64 * 1024) done(text);
          else
            reject(new Error(`Owned gVisor browser check failed (${code}): ${error.slice(-6000)}`));
        });
      });
      const result = JSON.parse(output);
      assert(result.passed && result.networkDenied && result.freshStorage);
      assert.deepEqual(result.statuses, [201, 400]);
      assert.match(result.trace.sha256, /^[a-f0-9]{64}$/);
      console.log(JSON.stringify({ attempt, ...result }));
    } finally {
      // Reconcile by this invocation's unique name even if create lost its response.
      const present = remote([
        'docker',
        'ps',
        '--all',
        '--filter',
        `name=^/${name}$`,
        '--format',
        '{{.Names}}',
      ]);
      if (present) {
        assert.equal(present, name);
        const owned = JSON.parse(remote(['docker', 'inspect', name]))[0];
        assert.equal(owned.Config.Labels['trialoom.runner.policy'], 'gvisor-owned-browser-v1');
        remote(['docker', 'rm', '--force', '--volumes', name]);
        assert.equal(
          remote([
            'docker',
            'ps',
            '--all',
            '--filter',
            `name=^/${name}$`,
            '--format',
            '{{.Names}}',
          ]),
          '',
        );
      }
    }
  }
  console.log(
    'PASS two fresh Chromium journeys under runsc; network denied, traces bounded, containers removed.',
  );
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}
