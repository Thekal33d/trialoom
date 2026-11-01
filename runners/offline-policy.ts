/** Host-owned limits for the first, deliberately offline runner checkpoint. */
export const offlinePolicy = {
  version: 'offline-runner-v1',
  memoryBytes: 128 * 1024 * 1024,
  scratchBytes: 8 * 1024 * 1024,
  sharedMemoryBytes: 1024 * 1024,
  fileBytes: 1024 * 1024,
  outputBytes: 64 * 1024,
  inputBytes: 32 * 1024,
  processes: 32,
  openFiles: 128,
  cpuPeriod: 100_000,
  cpuQuota: 50_000,
  cpuSeconds: 4,
  wallClockMs: 10_000,
} as const;

export class HostError extends Error {
  constructor(publicCode: string) {
    super(publicCode);
    this.name = 'HostError';
  }
}

export type HostCapabilities = {
  linux: boolean;
  cgroupV2: boolean;
  seccomp: boolean;
  runtimes: string[];
};

/** A runtime name is a configuration check, never proof of sandbox operation. */
export function customerRunnerGates(host: HostCapabilities): string[] {
  return [
    ...(!host.linux ? ['LINUX_REQUIRED'] : []),
    ...(!host.cgroupV2 ? ['CGROUP_V2_REQUIRED'] : []),
    ...(!host.seccomp ? ['SECCOMP_REQUIRED'] : []),
    ...(!host.runtimes.includes('runsc') ? ['GVISOR_NOT_INSTALLED'] : []),
    'GVISOR_BROWSER_VALIDATION_REQUIRED',
    'ENFORCED_PREVIEW_PROXY_REQUIRED',
    'LIVE_GRANT_DISPATCH_REQUIRED',
  ];
}

export function requireOfflineHost(host: HostCapabilities) {
  if (!host.linux || !host.cgroupV2 || !host.seccomp || !host.runtimes.includes('runc'))
    throw new HostError('OFFLINE_HOST_CONTROLS_UNAVAILABLE');
}

export function offlineCreateArgs(input: { name: string; imageId: string; deadline: number }) {
  if (
    !/^trialoom-offline-[a-f0-9]{32}$/.test(input.name) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.imageId) ||
    !Number.isSafeInteger(input.deadline) ||
    input.deadline <= 0
  )
    throw new HostError('INVALID_OFFLINE_JOB');
  const p = offlinePolicy;
  return [
    'create',
    '--pull=never',
    '--name',
    input.name,
    '--label',
    `trialoom.runner.policy=${p.version}`,
    '--label',
    `trialoom.runner.deadline=${input.deadline}`,
    '--runtime=runc',
    '--network=none',
    '--ipc=private',
    '--cgroupns=private',
    '--read-only',
    '--user=65534:65534',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit',
    String(p.processes),
    '--memory',
    String(p.memoryBytes),
    '--memory-swap',
    String(p.memoryBytes),
    '--cpu-period',
    String(p.cpuPeriod),
    '--cpu-quota',
    String(p.cpuQuota),
    '--shm-size',
    String(p.sharedMemoryBytes),
    '--ulimit',
    `nofile=${p.openFiles}:${p.openFiles}`,
    '--ulimit',
    `fsize=${p.fileBytes}:${p.fileBytes}`,
    '--ulimit',
    `cpu=${p.cpuSeconds}:${p.cpuSeconds}`,
    '--ulimit',
    'core=0:0',
    '--tmpfs',
    `/scratch:rw,nosuid,nodev,noexec,size=${p.scratchBytes},mode=0700,uid=65534,gid=65534`,
    '--workdir=/scratch',
    '--log-driver=none',
    '--restart=no',
    '--no-healthcheck',
    '--stop-timeout=1',
    '--interactive',
    '--entrypoint=/usr/bin/timeout',
    input.imageId,
    '--signal=KILL',
    `${p.wallClockMs / 1000}s`,
    '/usr/bin/env',
    '-i',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    'HOME=/scratch',
    'TMPDIR=/scratch',
    'XDG_CACHE_HOME=/scratch',
    'UV_USE_IO_URING=0',
    'LANG=C.UTF-8',
    '/usr/local/bin/node',
    '--input-type=module',
    '-',
  ];
}
