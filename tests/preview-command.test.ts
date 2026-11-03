import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

test('a host CLI that ignores SIGTERM cannot outlive the command deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trialoom-command-'));
  const pidPath = join(directory, 'pid');
  // A shell, not Node: the fixture has to record its pid before the deadline
  // fires, and Node's own start-up can lose that race on a loaded machine —
  // which failed this check twice without anything being wrong with it.
  await writeFile(
    join(directory, 'orb'),
    `#!/bin/sh
echo $$ > ${JSON.stringify(pidPath)}
trap '' TERM
while :; do sleep 1; done
`,
    { mode: 0o700 },
  );
  try {
    const code = `import assert from 'node:assert/strict';
import {remote} from ${JSON.stringify(pathToFileURL(resolve('scripts/preview-host.ts')).href)};
const start=performance.now();
assert.throws(()=>remote(['owned-timeout-fixture'], undefined, 1000), /DEDICATED_HOST_COMMAND_FAILED/);
assert(performance.now()-start < 3000);`;
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, PATH: directory },
      timeout: 5000,
      killSignal: 'SIGKILL',
      stdio: 'pipe',
    });
    const pid = Number(await readFile(pidPath, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    // Only the fixture PID written in this test's private directory is eligible.
    const pid = Number(await readFile(pidPath, 'utf8').catch(() => '0'));
    if (pid > 0)
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already terminated */
      }
    await rm(directory, { recursive: true, force: true });
  }
});
