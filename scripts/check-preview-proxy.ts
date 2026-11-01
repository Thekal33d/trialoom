import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const machine = ['-m', 'trialoom-runner', '-u', 'root', '-w', '/root'];
const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test' as const };
const label = 'trialoom.runner.policy=preview-proxy-fixture-v1';
const prefix = `trialoom-preview-${randomBytes(12).toString('hex')}`;
const names = new Set<string>();
const volume = `${prefix}-channel`;
let volumeAttempted = false;
const abort = new AbortController();
const cancel = () => abort.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
function remote(args: string[], input?: Buffer, timeout = 20_000) {
  const result = spawnSync('orb', [...machine, ...args], {
    env,
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 128 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Dedicated preview check command failed: ${result.error?.message ?? result.stderr.slice(-3000)}`,
    );
  return result.stdout.trim();
}
function inspect(name: string) {
  return JSON.parse(remote(['docker', 'inspect', name]))[0];
}
const runtime = JSON.parse(remote(['docker', 'info', '--format', '{{json .Runtimes}}']))[
  'runsc-preview'
];
assert(runtime?.runtimeArgs?.includes('--host-uds=open'));
assert(runtime.runtimeArgs.includes('--network=none'));
const base = JSON.parse(remote(['docker', 'image', 'inspect', 'trialoom-gvisor-check:local']))[0];
assert.match(base.Id, /^sha256:[a-f0-9]{64}$/);
assert.equal(Object.keys(base.Config.Volumes ?? {}).length, 0);
await mkdir('artifacts/preview-builds', { recursive: true, mode: 0o700 });
const build = await mkdtemp(resolve('artifacts/preview-builds/context-'));
try {
  const files = [
    'runners/preview-policy.ts',
    'runners/preview-proxy.ts',
    'runners/preview-check/fixture.ts',
    'runners/preview-check/read-identities.ts',
    'runners/preview-check/test-entry.ts',
    'runners/preview-check/broker.ts',
    'runners/preview-check/browser.ts',
    'src/server/targets.ts',
    'src/domain/errors.ts',
    'runners/preview-check/proxy.test.ts',
  ];
  for (const file of files) {
    await mkdir(dirname(`${build}/${file}`), { recursive: true });
    await cp(file, `${build}/${file}`);
  }
  await cp('runners/preview-check/Dockerfile', `${build}/Dockerfile`);
  await cp('node_modules/ipaddr.js', `${build}/ipaddr.js`, { recursive: true });
  const archive = spawnSync(
    'tar',
    ['-C', build, '-cf', '-', 'Dockerfile', 'runners', 'src', 'ipaddr.js'],
    { env, timeout: 10_000, maxBuffer: 2 * 1024 ** 2 },
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
      'trialoom-preview-check:local',
      '-',
    ],
    archive.stdout,
    90_000,
  );
} finally {
  await rm(build, { recursive: true, force: true });
}
const image = JSON.parse(remote(['docker', 'image', 'inspect', 'trialoom-preview-check:local']))[0];
assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
assert.equal(Object.keys(image.Config.Volumes ?? {}).length, 0);
console.log(JSON.stringify({ event: 'preview.image', baseImage: base.Id, image: image.Id }));

// Temporary fixture identities are piped only to the isolated trusted broker or
// unit-test process. No key enters the image, shared channel, browser, or logs.
const certDir = await mkdtemp(resolve('artifacts/preview-builds/identity-'));
const identities: Record<string, { key: string; cert: string }> = {};
try {
  for (const hostname of ['preview.example.com', 'wrong.example.com']) {
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
        `${certDir}/key.pem`,
        '-out',
        `${certDir}/cert.pem`,
        '-days',
        '1',
        '-subj',
        `/CN=${hostname}`,
        '-addext',
        `subjectAltName=DNS:${hostname}`,
      ],
      { env, timeout: 5000, maxBuffer: 8192 },
    );
    assert.equal(result.status, 0, 'Fixture identity generation failed');
    identities[hostname] = {
      key: await readFile(`${certDir}/key.pem`, 'utf8'),
      cert: await readFile(`${certDir}/cert.pem`, 'utf8'),
    };
  }
} finally {
  await rm(certDir, { recursive: true, force: true });
}
const input = Buffer.from(JSON.stringify(identities));

function create(suffix: string, role: 'test' | 'broker' | 'browser', args: string[]) {
  assert(!abort.signal.aborted);
  const name = `${prefix}-${suffix}`;
  names.add(name);
  const mounts =
    role === 'test'
      ? []
      : [
          '--mount',
          `type=volume,source=${volume},target=/channel,volume-nocopy${role === 'browser' ? ',readonly' : ''}`,
        ];
  remote([
    'docker',
    'create',
    '--pull=never',
    '--name',
    name,
    '--label',
    label,
    `--runtime=${role === 'broker' ? 'runc' : role === 'test' ? 'runsc' : 'runsc-preview'}`,
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
    '--tmpfs=/tmp:ro,nosuid,nodev,noexec,size=1m',
    '--tmpfs=/scratch:rw,nosuid,nodev,noexec,size=128m,mode=0700,uid=65534,gid=65534',
    '--shm-size=64m',
    '--log-driver=none',
    '--restart=no',
    '--no-healthcheck',
    '--interactive',
    ...mounts,
    image.Id,
    ...args,
  ]);
  const actual = inspect(name);
  assert.equal(actual.Image, image.Id);
  assert.equal(actual.HostConfig.NetworkMode, 'none');
  assert.equal(actual.HostConfig.ReadonlyRootfs, true);
  assert.equal(
    actual.HostConfig.Runtime,
    role === 'broker' ? 'runc' : role === 'test' ? 'runsc' : 'runsc-preview',
  );
  const persistent = actual.Mounts.filter((mount: { Type: string }) => mount.Type !== 'tmpfs');
  assert.equal(persistent.length, role === 'test' ? 0 : 1);
  if (role !== 'test') {
    assert.equal(persistent[0].Name, volume);
    assert.equal(persistent[0].Destination, '/channel');
    assert.equal(persistent[0].RW, role === 'broker');
  }
  return name;
}
function start(name: string, data?: Buffer) {
  const child = spawn('orb', [...machine, 'docker', 'start', '--attach', '--interactive', name], {
    env,
  });
  let bytes = 0;
  let stdout = '';
  let stderr = '';
  let stopped = false;
  const kill = () => {
    if (stopped) return;
    stopped = true;
    try {
      remote(['docker', 'kill', name]);
    } catch {
      /* cleanup must still verify deletion */
    }
    child.kill('SIGKILL');
  };
  const timer = setTimeout(kill, 75_000);
  abort.signal.addEventListener('abort', kill, { once: true });
  child.stdin.on('error', () => {});
  child.stdin.end(data);
  const completion = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) kill();
        else stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) kill();
        else stderr += chunk;
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        abort.signal.removeEventListener('abort', kill);
        if (stopped || abort.signal.aborted) reject(new Error('PREVIEW_CHECK_INTERRUPTED'));
        else resolve({ code, stdout, stderr });
      });
    },
  );
  // Observed later even if a different check fails first.
  void completion.catch(() => {});
  return completion;
}
function passed(result: { code: number | null; stdout: string; stderr: string }) {
  assert.equal(
    result.code,
    0,
    `Owned preview check failed: ${result.stderr.slice(-4000)} ${result.stdout.slice(-6000)}`,
  );
  return result.stdout.trim();
}
try {
  const tests = create('tests', 'test', ['/opt/trialoom/runners/preview-check/test-entry.ts']);
  console.log(passed(await start(tests, input)));
  if (!process.argv.includes('--unit-only')) {
    volumeAttempted = true;
    remote([
      'docker',
      'volume',
      'create',
      '--label',
      label,
      '--driver=local',
      '--opt=type=tmpfs',
      '--opt=device=tmpfs',
      '--opt=o=size=1m,uid=65534,gid=65534,mode=0700',
      volume,
    ]);
    const broker = create('broker', 'broker', ['/opt/trialoom/runners/preview-check/broker.ts']);
    const brokerDone = start(broker, input);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      assert(!abort.signal.aborted);
      try {
        remote(['docker', 'exec', broker, 'test', '-f', '/channel/ready.json']);
        ready = true;
        break;
      } catch {
        assert(inspect(broker).State.Running, 'Broker stopped before readiness');
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(ready, 'Broker did not become ready');
    for (let attempt = 1; attempt <= 2; attempt++) {
      const browser = create(`browser-${attempt}`, 'browser', [
        '/opt/trialoom/runners/preview-check/browser.ts',
      ]);
      const result = JSON.parse(passed(await start(browser)));
      assert(result.passed && result.directNetworkDenied && result.channelReadOnly);
      console.log(JSON.stringify({ attempt, ...result }));
    }
    const witness = JSON.parse(remote(['docker', 'exec', broker, 'cat', '/scratch/status.json']));
    assert(!witness.closed && witness.upstreamRequests >= 8);
    for (const reason of ['ALLOWED', 'ORIGIN_DENIED', 'REDIRECT_DENIED', 'METHOD_DENIED'])
      assert(
        witness.observations.some((item: { reason: string }) => item.reason === reason),
        reason,
      );
    console.log(JSON.stringify({ event: 'preview.host_witness', ...witness }));
    const loss = create('proxy-loss', 'browser', [
      '/opt/trialoom/runners/preview-check/browser.ts',
      'no-proxy',
    ]);
    const lossDone = start(loss);
    let lossReady = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        remote(['docker', 'exec', loss, 'test', '-f', '/scratch/loss-ready']);
        lossReady = true;
        break;
      } catch {
        assert(inspect(loss).State.Running, 'Proxy-loss browser stopped before readiness');
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(lossReady);
    remote(['docker', 'kill', broker]);
    await brokerDone;
    remote(['docker', 'exec', loss, 'touch', '/scratch/release-loss']);
    const result = JSON.parse(passed(await lossDone));
    assert(result.passed && result.directNetworkDenied);
    console.log(JSON.stringify(result));
  }
} finally {
  input.fill(0);
  for (const name of names) {
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
      assert.equal(
        inspect(name).Config.Labels['trialoom.runner.policy'],
        'preview-proxy-fixture-v1',
      );
      remote(['docker', 'rm', '--force', '--volumes', name]);
    }
    assert.equal(
      remote(['docker', 'ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']),
      '',
    );
  }
  if (volumeAttempted) {
    const present = remote([
      'docker',
      'volume',
      'ls',
      '--filter',
      `name=^${volume}$`,
      '--format',
      '{{.Name}}',
    ]);
    if (present) {
      const owned = JSON.parse(remote(['docker', 'volume', 'inspect', volume]))[0];
      assert.equal(owned.Labels['trialoom.runner.policy'], 'preview-proxy-fixture-v1');
      remote(['docker', 'volume', 'rm', volume]);
    }
    assert.equal(
      remote(['docker', 'volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}']),
      '',
    );
  }
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
console.log('PASS preview proxy checks; owned containers and channel volume removed.');
