import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readBrokerFailure } from '../runners/preview-diagnostics.ts';

const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test' as const };
const machine = ['-m', 'trialoom-runner', '-u', 'root', '-w', '/root'];
const policy = 'application-preview-v1';
export function remote(args: string[], input?: Buffer, timeout = 15000) {
  const result = spawnSync('orb', [...machine, ...args], {
    env,
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 128 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('DEDICATED_HOST_COMMAND_FAILED');
  return result.stdout.trim();
}
const inspect = (name: string) => JSON.parse(remote(['docker', 'inspect', name]))[0];
export async function buildPreviewImage() {
  const runtime = JSON.parse(remote(['docker', 'info', '--format', '{{json .Runtimes}}']))[
    'runsc-preview'
  ];
  assert(
    runtime?.runtimeArgs?.includes('--host-uds=open') &&
      runtime.runtimeArgs.includes('--network=none'),
  );
  const base = JSON.parse(remote(['docker', 'image', 'inspect', 'trialoom-gvisor-check:local']))[0];
  assert.match(base.Id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.keys(base.Config.Volumes ?? {}).length, 0);
  await mkdir('artifacts/preview-builds', { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(resolve('artifacts/preview-builds/application-'));
  try {
    for (const file of [
      'runners/preview-policy.ts',
      'runners/preview-proxy.ts',
      'runners/preview-channel.ts',
      'runners/preview-browser.ts',
      'runners/preview-ladder.ts',
      'runners/preview-broker.ts',
      'runners/preview-diagnostics.ts',
      'src/server/targets.ts',
      'src/domain/errors.ts',
      'src/domain/preview-scope.ts',
    ]) {
      await mkdir(dirname(`${directory}/${file}`), { recursive: true });
      await cp(file, `${directory}/${file}`);
    }
    await cp('runners/preview-check/Dockerfile', `${directory}/Dockerfile`);
    await cp('node_modules/ipaddr.js', `${directory}/ipaddr.js`, { recursive: true });
    const archive = spawnSync(
      'tar',
      ['-C', directory, '-cf', '-', 'Dockerfile', 'runners', 'src', 'ipaddr.js'],
      { env, timeout: 10000, maxBuffer: 2 * 1024 ** 2 },
    );
    assert.equal(archive.status, 0);
    remote(
      [
        'docker',
        'build',
        '--network=none',
        '--pull=false',
        '--force-rm=true',
        '--build-arg',
        `BASE_IMAGE=${base.Id}`,
        '-t',
        'trialoom-preview-run:local',
        '-',
      ],
      archive.stdout,
      90000,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const image = JSON.parse(remote(['docker', 'image', 'inspect', 'trialoom-preview-run:local']))[0];
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.keys(image.Config.Volumes ?? {}).length, 0);
  return image.Id as string;
}
export async function previewIdentity(hostname: string) {
  assert(/^[a-z0-9.-]+$/.test(hostname) && hostname.length <= 253);
  const directory = await mkdtemp(resolve('artifacts/preview-builds/identity-'));
  try {
    const result = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        `${directory}/key.pem`,
        '-out',
        `${directory}/cert.pem`,
        '-days',
        '1',
        '-subj',
        `/CN=${hostname}`,
        '-addext',
        `subjectAltName=DNS:${hostname}`,
      ],
      { env, timeout: 5000, maxBuffer: 8192 },
    );
    assert.equal(result.status, 0);
    return {
      key: await readFile(`${directory}/key.pem`, 'utf8'),
      cert: await readFile(`${directory}/cert.pem`, 'utf8'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** All objects are owned by one invocation; no workspace mount or default runtime. */
export function previewHost(image: string, publicNetwork: boolean, signal: AbortSignal) {
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const prefix = `trialoom-run-${randomBytes(12).toString('hex')}`;
  const volume = `${prefix}-channel`;
  const broker = `${prefix}-broker`;
  const browser = `${prefix}-browser`;
  let volumeCreated = false;
  let watchdog = false;
  const names = new Set<string>();
  const processes: Promise<string>[] = [];
  const kill = () => {
    for (const name of names) {
      try {
        remote(['docker', 'kill', name]);
      } catch {
        /* verified removal follows */
      }
    }
  };
  signal.addEventListener('abort', kill, { once: true });
  function create(name: string, role: 'broker' | 'browser') {
    signal.throwIfAborted();
    names.add(name);
    remote([
      'docker',
      'create',
      '--pull=never',
      '--name',
      name,
      '--label',
      `trialoom.runner.policy=${policy}`,
      '--label',
      `trialoom.runner.expires=${Date.now() + 70000}`,
      `--runtime=${role === 'broker' ? 'runc' : 'runsc-preview'}`,
      `--network=${role === 'broker' && publicNetwork ? 'bridge' : 'none'}`,
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
      '--tmpfs=/tmp:ro,nosuid,nodev,noexec,size=1m',
      '--tmpfs=/scratch:rw,nosuid,nodev,noexec,size=128m,mode=0700,uid=65534,gid=65534',
      '--shm-size=64m',
      '--log-driver=none',
      '--restart=no',
      '--no-healthcheck',
      '--interactive',
      '--mount',
      `type=volume,source=${volume},target=/channel,volume-nocopy${role === 'browser' ? ',readonly' : ''}`,
      image,
      `/opt/trialoom/runners/preview-${role}.ts`,
    ]);
    const actual = inspect(name);
    assert.equal(actual.Image, image);
    assert.equal(actual.HostConfig.Runtime, role === 'broker' ? 'runc' : 'runsc-preview');
    assert.equal(
      actual.HostConfig.NetworkMode,
      role === 'broker' && publicNetwork ? 'bridge' : 'none',
    );
    assert.equal(actual.HostConfig.ReadonlyRootfs, true);
    assert.equal(actual.HostConfig.Memory, 1024 ** 3);
    assert.equal(actual.HostConfig.MemorySwap, 1024 ** 3);
    assert.equal(actual.HostConfig.PidsLimit, 256);
    assert.equal(actual.HostConfig.NanoCpus, 1e9);
    const mounts = actual.Mounts.filter((mount: { Type: string }) => mount.Type !== 'tmpfs');
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].Name, volume);
    assert.equal(mounts[0].RW, role === 'broker');
    assert.equal(mounts[0].Destination, '/channel');
  }
  function start(name: string, input: unknown, cap: number) {
    signal.throwIfAborted();
    const child = spawn('orb', [...machine, 'docker', 'start', '--attach', '--interactive', name], {
      env,
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let failed = false;
    const stop = () => {
      failed = true;
      kill();
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 65000);
    const done = new Promise<string>((resolve, reject) => {
      child.once('error', () => {
        failed = true;
      });
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > cap) stop();
          else if (stream === child.stdout) chunks.push(chunk);
          else if (name === broker) errors.push(chunk);
        });
      child.once('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        if (code !== 0 || failed || signal.aborted)
          reject(
            new Error(
              name === broker && !failed && !signal.aborted
                ? (readBrokerFailure(Buffer.concat(errors).toString('utf8')) ??
                    'PREVIEW_PROCESS_STOPPED')
                : 'PREVIEW_PROCESS_STOPPED',
            ),
          );
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
    processes.push(done);
    void done.catch(() => {});
    return done;
  }
  return {
    async prepare(input: unknown, watchdogSeconds = 70) {
      assert(watchdogSeconds >= 3 && watchdogSeconds <= 70);
      signal.throwIfAborted();
      remote([
        'docker',
        'volume',
        'create',
        '--label',
        `trialoom.runner.policy=${policy}`,
        '--driver=local',
        '--opt=type=tmpfs',
        '--opt=device=tmpfs',
        '--opt=o=size=1m,uid=65534,gid=65534,mode=0700',
        volume,
      ]);
      volumeCreated = true;
      // Root-owned systemd timer lives outside both containers and the Mac controller.
      // All interpolated names are generated hex identifiers, never target input.
      remote([
        'systemd-run',
        '--quiet',
        `--unit=${prefix}`,
        `--on-active=${watchdogSeconds}s`,
        '--timer-property=AccuracySec=100ms',
        '/bin/sh',
        '-c',
        `/usr/bin/docker rm -fv ${browser} ${broker} >/dev/null 2>&1; /usr/bin/docker volume rm ${volume} >/dev/null 2>&1`,
      ]);
      watchdog = true;
      create(broker, 'broker');
      create(browser, 'browser');
      const brokerProcess = start(broker, input, 16384);
      for (let n = 0; n < 40; n++) {
        signal.throwIfAborted();
        try {
          remote(['docker', 'exec', broker, 'test', '-f', '/channel/ready.json']);
          return;
        } catch {
          const state = inspect(broker).State;
          // Attaching through Orb is asynchronous; a created container has not failed.
          // Keep polling within the existing bound, but stop on an exited/dead broker.
          if (!state.Running && state.Status !== 'created') {
            await brokerProcess;
            throw new Error('BROKER_NOT_READY');
          }
        }
        await delay(100);
      }
      throw new Error('BROKER_NOT_READY');
    },
    run(input: unknown) {
      return start(browser, input, 12 * 1024 ** 2);
    },
    async witness() {
      remote(['docker', 'exec', broker, 'touch', '/scratch/freeze']);
      for (let n = 0; n < 30; n++) {
        const status = JSON.parse(
          remote(['docker', 'exec', broker, 'cat', '/scratch/status.json']),
        );
        if (status.closed) return status;
        await delay(100);
      }
      throw new Error('WITNESS_NOT_FROZEN');
    },
    present() {
      return remote([
        'docker',
        'ps',
        '-a',
        '--filter',
        `name=^/${prefix}-`,
        '--format',
        '{{.Names}}',
      ]);
    },
    async close() {
      signal.removeEventListener('abort', kill);
      for (const name of names) {
        const present = remote([
          'docker',
          'ps',
          '-a',
          '--filter',
          `name=^/${name}$`,
          '--format',
          '{{.Names}}',
        ]);
        if (present) {
          assert.equal(present, name);
          assert.equal(inspect(name).Config.Labels['trialoom.runner.policy'], policy);
          remote(['docker', 'rm', '--force', '--volumes', name]);
        }
        assert.equal(
          remote(['docker', 'ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']),
          '',
        );
      }
      await Promise.allSettled(processes);
      if (volumeCreated) {
        if (
          remote([
            'docker',
            'volume',
            'ls',
            '--filter',
            `name=^${volume}$`,
            '--format',
            '{{.Name}}',
          ])
        ) {
          const actual = JSON.parse(remote(['docker', 'volume', 'inspect', volume]))[0];
          assert.equal(actual.Labels['trialoom.runner.policy'], policy);
          remote(['docker', 'volume', 'rm', volume]);
        }
        assert.equal(
          remote([
            'docker',
            'volume',
            'ls',
            '--filter',
            `name=^${volume}$`,
            '--format',
            '{{.Name}}',
          ]),
          '',
        );
      }
      if (watchdog) {
        try {
          remote(['systemctl', 'stop', `${prefix}.timer`, `${prefix}.service`]);
        } catch {
          /* fired timer may already have disappeared */
        }
      }
    },
  };
}
