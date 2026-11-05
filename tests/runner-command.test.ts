import assert from 'node:assert/strict';
import test from 'node:test';
import { runnerCommand } from '../scripts/runner-command.ts';

test('native Linux invokes the same fixed host command without an Orb dependency', () => {
  assert.deepEqual(
    runnerCommand(['docker', 'inspect', 'owned-name'], { TRIALOOM_RUNNER_HOST: 'linux' }, 'linux'),
    { command: 'docker', args: ['inspect', 'owned-name'] },
  );
  assert.deepEqual(
    runnerCommand(
      ['systemd-run', '--on-active=50s', '/usr/bin/docker', 'rm', 'owned-name'],
      {},
      'linux',
    ).command,
    'systemd-run',
  );
  assert.throws(() => runnerCommand(['bash', '-c', 'arbitrary'], {}, 'linux'));
  assert.throws(() => runnerCommand(['docker'], { TRIALOOM_RUNNER_HOST: 'ssh attacker' }, 'linux'));
  assert.throws(() => runnerCommand(['docker'], { TRIALOOM_RUNNER_HOST: 'linux' }, 'darwin'));
});
test('macOS retains the dedicated VM and never interprets arguments as shell text', () => {
  const name = 'literal; echo should-not-execute';
  assert.deepEqual(runnerCommand(['docker', 'inspect', name], {}, 'darwin'), {
    command: 'orb',
    args: ['-m', 'trialoom-runner', '-u', 'root', '-w', '/root', 'docker', 'inspect', name],
  });
  assert.throws(() => runnerCommand(['docker'], { TRIALOOM_RUNNER_HOST: 'orb' }, 'linux'));
});
