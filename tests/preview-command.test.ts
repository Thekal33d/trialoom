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
  // A shell, not Node, so the fixture records its pid almost immediately and
  // start-up cannot lose a race with the deadline on a loaded machine. What is
  // under test is that the deadline is *enforced* against a CLI ignoring
  // SIGTERM, not that it is any particular number of milliseconds.
  //
  // `sleep` is called by absolute path on purpose: `remote` runs the command
  // with a stripped PATH pointing only at this directory, so a bare `sleep`
  // is not found, the loop spins, stderr floods, and the call ends on
  // maxBuffer after about a second — passing this check for a reason that has
  // nothing to do with the deadline it claims to test.
  await writeFile(
    join(directory, 'orb'),
    `#!/bin/sh
echo $$ > ${JSON.stringify(pidPath)}
trap '' TERM
while :; do /bin/sleep 1; done
`,
    { mode: 0o700 },
  );
  try {
    const code = `import assert from 'node:assert/strict';
import {remote} from ${JSON.stringify(pathToFileURL(resolve('scripts/preview-host.ts')).href)};
const start=performance.now();
assert.throws(()=>remote(['owned-timeout-fixture'], undefined, 3000), /DEDICATED_HOST_COMMAND_FAILED/);
assert(performance.now()-start < 6000);`;
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, PATH: directory },
      timeout: 15000,
      killSignal: 'SIGKILL',
      stdio: 'pipe',
    });
    // If this file is missing the fixture never started, which is a broken
    // check rather than a surviving process — say which, instead of an ENOENT.
    const recorded = await readFile(pidPath, 'utf8').catch(() => null);
    assert(recorded, 'the fixture never recorded a pid, so nothing was tested');
    assert.throws(() => process.kill(Number(recorded), 0), { code: 'ESRCH' });
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
