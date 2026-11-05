import assert from 'node:assert/strict';

/** Fixed argv, never a shell command supplied by an agent or target. */
export function runnerCommand(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
) {
  assert(args.length > 0 && args.every((part) => typeof part === 'string' && !part.includes('\0')));
  const mode = env.TRIALOOM_RUNNER_HOST ?? (platform === 'darwin' ? 'orb' : 'linux');
  if (mode === 'orb') {
    assert.equal(platform, 'darwin', 'OrbStack mode requires macOS.');
    return {
      command: 'orb',
      args: ['-m', 'trialoom-runner', '-u', 'root', '-w', '/root', ...args],
    };
  }
  assert.equal(mode, 'linux', 'Choose orb or linux for TRIALOOM_RUNNER_HOST.');
  assert.equal(platform, 'linux', 'Native runner mode requires a dedicated Linux host.');
  // Keep access restricted to the commands the trusted controller needs.
  assert(
    ['docker', 'systemd-run', 'systemctl', 'openssl'].includes(args[0]),
    'Unsupported host command.',
  );
  return { command: args[0], args: args.slice(1) };
}
