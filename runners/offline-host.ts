import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  customerRunnerGates,
  type HostCapabilities,
  HostError,
  offlineCreateArgs,
  offlinePolicy,
  requireOfflineHost,
} from './offline-policy.ts';
import { type OfflineProbe, offlineProbes } from './offline-probes.ts';

type CommandResult = { code: number | null; stdout: string; stderr: string };
export type DockerCommand = (args: string[]) => Promise<CommandResult>;

// The trusted Docker client needs its local context. No environment is copied
// into the workload; env -i also removes environment defaults baked into images.
function clientEnvironment() {
  return { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test' as const };
}

export const dockerCommand: DockerCommand = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      env: clientEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: HostError | undefined;
    const timer = setTimeout(() => {
      failure = new HostError('DOCKER_CONTROL_TIMEOUT');
      child.kill('SIGKILL');
    }, 15_000);
    const collect = (into: Buffer[]) => (buffer: Buffer) => {
      bytes += buffer.length;
      if (bytes > 2 * 1024 * 1024) {
        failure = new HostError('DOCKER_CONTROL_OUTPUT_LIMIT');
        child.kill('SIGKILL');
      } else into.push(buffer);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', () => {
      clearTimeout(timer);
      reject(new HostError('DOCKER_UNAVAILABLE'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        });
    });
  });

async function jsonCommand(args: string[], command: DockerCommand) {
  const result = await command(args);
  if (result.code !== 0) throw new HostError('DOCKER_CONTROL_FAILED');
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new HostError('DOCKER_RESPONSE_INVALID');
  }
}

export async function inspectHost(command = dockerCommand) {
  const info = await jsonCommand(['info', '--format', '{{json .}}'], command);
  const host: HostCapabilities = {
    linux: info.OSType === 'linux',
    cgroupV2: info.CgroupVersion === '2',
    seccomp:
      Array.isArray(info.SecurityOptions) &&
      info.SecurityOptions.includes('name=seccomp,profile=builtin'),
    runtimes: Object.keys(info.Runtimes ?? {}).sort(),
  };
  return { ...host, customerReady: false as const, customerGates: customerRunnerGates(host) };
}

export async function resolveOwnedImage(reference = 'node:22', command = dockerCommand) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,200}$/.test(reference))
    throw new HostError('INVALID_IMAGE_REFERENCE');
  const [image] = await jsonCommand(['image', 'inspect', reference], command);
  if (!/^sha256:[a-f0-9]{64}$/.test(image?.Id ?? '')) throw new HostError('IMAGE_ID_REQUIRED');
  // Declared volumes are automatically mounted by Docker even without -v.
  if (Object.keys(image.Config?.Volumes ?? {}).length)
    throw new HostError('IMAGE_VOLUMES_FORBIDDEN');
  return image.Id as string;
}

const ownedName = /^trialoom-offline-[a-f0-9]{32}$/;
function assertOwned(
  container: { Name?: string; Config?: { Labels?: Record<string, string> } },
  name: string,
) {
  if (
    !ownedName.test(name) ||
    container.Name !== `/${name}` ||
    container.Config?.Labels?.['trialoom.runner.policy'] !== offlinePolicy.version
  )
    throw new HostError('CONTAINER_OWNERSHIP_MISMATCH');
}

async function inspectContainer(name: string, command: DockerCommand) {
  const [container] = await jsonCommand(['container', 'inspect', name], command);
  assertOwned(container, name);
  return container;
}

export async function removeOwnedContainer(name: string, command = dockerCommand) {
  await inspectContainer(name, command);
  const removed = await command(['container', 'rm', '--force', '--volumes', name]);
  if (removed.code !== 0) throw new HostError('CLEANUP_FAILED');
  // Listing succeeds or fails independently: a daemon outage is not deletion.
  const remaining = await command([
    'container',
    'ls',
    '--all',
    '--filter',
    `name=^/${name}$`,
    '--format',
    '{{.Names}}',
  ]);
  if (remaining.code !== 0 || remaining.stdout.trim()) throw new HostError('CLEANUP_UNVERIFIED');
}

/** Reap only this policy's named containers whose host-owned deadline elapsed. */
export async function reapExpiredOfflineRuns(now = Date.now(), command = dockerCommand) {
  const listed = await command([
    'container',
    'ls',
    '--all',
    '--filter',
    `label=trialoom.runner.policy=${offlinePolicy.version}`,
    '--format',
    '{{.Names}}',
  ]);
  if (listed.code !== 0) throw new HostError('CLEANUP_SCAN_FAILED');
  let removed = 0;
  for (const name of listed.stdout.trim().split('\n').filter(Boolean)) {
    if (!ownedName.test(name)) continue;
    const container = await inspectContainer(name, command);
    const deadline = Number(container.Config.Labels['trialoom.runner.deadline']);
    if (Number.isSafeInteger(deadline) && deadline > 0 && deadline <= now) {
      await removeOwnedContainer(name, command);
      removed += 1;
    }
  }
  return removed;
}

export type OfflineResult = {
  policy: typeof offlinePolicy.version;
  probe: OfflineProbe;
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'output_limit';
  exitCode: number | null;
  oomKilled: boolean;
  cleanupVerified: true;
  output: string;
};

/** Only the reviewed probes can execute. This is not a customer dispatcher. */
export async function runOfflineProbe(options: {
  imageId: string;
  probe: OfflineProbe;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStarted?: () => void;
}): Promise<OfflineResult> {
  if (!Object.hasOwn(offlineProbes, options.probe)) throw new HostError('UNKNOWN_OWNED_PROBE');
  const source = offlineProbes[options.probe];
  if (Buffer.byteLength(source) > offlinePolicy.inputBytes) throw new HostError('INPUT_LIMIT');
  const budget = options.timeoutMs ?? offlinePolicy.wallClockMs;
  if (!Number.isInteger(budget) || budget < 100 || budget > offlinePolicy.wallClockMs)
    throw new HostError('INVALID_TIME_LIMIT');
  requireOfflineHost(await inspectHost());
  // Revalidate the immutable image, including volumes, on every invocation.
  if ((await resolveOwnedImage(options.imageId)) !== options.imageId)
    throw new HostError('IMAGE_CHANGED');
  if (options.signal?.aborted) throw new HostError('CANCELLED_BEFORE_START');
  const name = `trialoom-offline-${randomBytes(16).toString('hex')}`;
  const args = offlineCreateArgs({ name, imageId: options.imageId, deadline: Date.now() + 45_000 });
  let created = false;
  let result: Omit<OfflineResult, 'cleanupVerified'> | undefined;
  try {
    // If create loses its response, the scoped recovery path still finds the
    // name. No start is attempted until ownership/configuration is verified.
    const made = await dockerCommand(args);
    if (made.code !== 0) throw new HostError('CONTAINER_CREATE_FAILED');
    created = true;
    const container = await inspectContainer(name, dockerCommand);
    if (
      container.Image !== options.imageId ||
      container.HostConfig.NetworkMode !== 'none' ||
      !container.HostConfig.ReadonlyRootfs ||
      container.Config.User !== '65534:65534' ||
      (container.Mounts ?? []).some((mount: { Type: string }) => mount.Type !== 'tmpfs')
    )
      throw new HostError('CONTAINER_POLICY_MISMATCH');
    if (options.signal?.aborted) throw new HostError('CANCELLED_BEFORE_START');
    const outcome = await new Promise<{ status: OfflineResult['status']; output: string }>(
      (resolve, reject) => {
        const child = spawn('docker', ['start', '--attach', '--interactive', name], {
          env: clientEnvironment(),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const output: Buffer[] = [];
        let bytes = 0;
        let status: OfflineResult['status'] | undefined;
        let stop: Promise<unknown> | undefined;
        const halt = (reason: OfflineResult['status']) => {
          if (status) return;
          status = reason;
          stop = dockerCommand(['container', 'kill', name]).finally(() => child.kill('SIGKILL'));
          void stop.catch(() => undefined);
        };
        const abort = () => halt('cancelled');
        const timer = setTimeout(() => halt('timed_out'), budget);
        options.signal?.addEventListener('abort', abort, { once: true });
        const finish = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
        };
        const collect = (keep: boolean) => (buffer: Buffer) => {
          bytes += buffer.length;
          if (bytes > offlinePolicy.outputBytes) halt('output_limit');
          else if (keep && !status) output.push(buffer);
        };
        child.stdout.on('data', collect(true));
        child.stderr.on('data', collect(false));
        child.stdin.on('error', () => undefined); // A killed/closed sandbox cannot accept input.
        child.once('error', () => {
          finish();
          reject(new HostError('ATTACH_FAILED'));
        });
        child.once('close', async (code) => {
          finish();
          await stop?.catch(() => undefined);
          resolve({
            status: status ?? (code === 0 ? 'completed' : 'failed'),
            output: status ? '' : Buffer.concat(output).toString(),
          });
        });
        child.stdin.end(source);
        if (options.signal?.aborted) abort();
        // This callback means attach was dispatched, not proof of workload success.
        options.onStarted?.();
      },
    );
    const after = await inspectContainer(name, dockerCommand);
    if (after.State.Running) throw new HostError('WORKLOAD_STILL_RUNNING');
    result = {
      policy: offlinePolicy.version,
      probe: options.probe,
      status: outcome.status,
      exitCode: after.State.ExitCode,
      oomKilled: after.State.OOMKilled === true,
      output: outcome.output,
    };
  } finally {
    if (created) await removeOwnedContainer(name);
    else {
      // A failed/timed-out create may have committed in the daemon.
      const found = await dockerCommand([
        'container',
        'ls',
        '--all',
        '--filter',
        `name=^/${name}$`,
        '--format',
        '{{.Names}}',
      ]);
      // Cleanup uncertainty takes precedence over a workload error: never
      // report completion while a container may still exist.
      // biome-ignore lint/correctness/noUnsafeFinally: fail closed on unverified cleanup
      if (found.code !== 0) throw new HostError('CLEANUP_UNVERIFIED');
      if (found.stdout.trim()) await removeOwnedContainer(name);
    }
  }
  if (!result) throw new HostError('RUN_RESULT_MISSING');
  return { ...result, cleanupVerified: true };
}
