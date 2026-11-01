import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { canaries, startFixture } from './fixture.mjs';

assert.equal(process.getuid(), 65534);
assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo']);
await assert.rejects(readFile('/scratch/prior-run'), { code: 'ENOENT' });
await writeFile('/scratch/prior-run', 'owned fixture only');
// This directory is writable by the workload in the image, so ordinary UID
// permissions cannot accidentally satisfy the read-only filesystem check.
await assert.rejects(writeFile('/rootfs-probe/root-write', 'x'), { code: 'EROFS' });
await assert.rejects(writeFile('/tmp/root-write', 'x'), { code: 'EROFS' });
await new Promise((resolve, reject) => {
  const socket = net.connect({ host: '192.0.2.1', port: 443 });
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new Error('Network denial was not observed'));
  }, 1500);
  socket.on('connect', () => {
    clearTimeout(timer);
    socket.destroy();
    reject(new Error('Unexpected route'));
  });
  socket.on('error', (error) => {
    clearTimeout(timer);
    if (['ENETUNREACH', 'EHOSTUNREACH'].includes(error.code)) resolve();
    else reject(error);
  });
});

const fixture = await startFixture();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: false, // The outer boundary is runsc; this harness is refused without it.
    timeout: 20_000,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/scratch',
      TMPDIR: '/scratch',
      XDG_CACHE_HOME: '/scratch',
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    },
  });
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== fixture.origin) return route.abort();
    return route.continue({
      headers: { ...route.request().headers(), 'x-fixture-token': canaries[0] },
    });
  });
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.tracing.start({ snapshots: false, screenshots: false, sources: false });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(fixture.origin);
  assert.equal((await context.cookies()).length, 0);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  const statuses = [];
  for (const email of ['teammate@example.test', 'teammate+qa@example.test']) {
    await page.getByLabel('Teammate email').fill(email);
    const [response] = await Promise.all([
      page.waitForResponse(
        (item) =>
          item.url() === `${fixture.origin}/api/invitations` && item.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Send invitation' }).click(),
    ]);
    statuses.push(response.status());
  }
  assert.deepEqual(statuses, [201, 400]);
  await context.tracing.stop({ path: '/scratch/browser.trace.zip' });
  const trace = await readFile('/scratch/browser.trace.zip');
  assert(trace.length > 0 && trace.length <= 8 * 1024 * 1024);
  await context.close();
  console.log(
    JSON.stringify({
      check: 'gvisor-owned-browser',
      passed: true,
      browserVersion: browser.version(),
      fixtureBuild: fixture.build.id,
      statuses,
      freshStorage: true,
      networkDenied: true,
      trace: { bytes: trace.length, sha256: createHash('sha256').update(trace).digest('hex') },
    }),
  );
} finally {
  await browser?.close();
  await fixture.close();
}
