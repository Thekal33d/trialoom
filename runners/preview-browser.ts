// Fixed read-only journey. No application/host credential enters this process.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { boundedInput, previewBridge } from './preview-channel.ts';
import { readLadder } from './preview-ladder.ts';

async function main() {
  assert.equal(process.getuid?.(), 65534);
  assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo']);
  const job = await boundedInput(8192);
  const ready = JSON.parse(await readFile('/channel/ready.json', 'utf8'));
  const url = new URL(job.url);
  assert(url.origin === ready.origin && url.protocol === 'https:');
  assert(
    Array.isArray(ready.origins) &&
      ready.origins.includes(ready.origin) &&
      ready.origins.length <= 8,
  );
  assert.match(ready.spki, /^[A-Za-z0-9+/]{43}=$/);
  assert(Number.isSafeInteger(job.durationMs) && job.durationMs >= 1000 && job.durationMs <= 45000);
  assert(
    Number.isSafeInteger(job.maxNavigations) && job.maxNavigations >= 1 && job.maxNavigations <= 50,
  );
  assert(['owned', 'homepage', 'ladder'].includes(job.journey));
  if (job.journey === 'ladder') assert(ready.origins.includes(new URL(job.readUrl).origin));
  const bridge = await previewBridge();
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: false,
    proxy: { server: `http://127.0.0.1:${bridge.port}` },
    args: [`--ignore-certificate-errors-spki-list=${ready.spki}`, '--disable-quic'],
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/scratch',
      TMPDIR: '/scratch',
      XDG_CACHE_HOME: '/scratch',
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    },
  });
  const startedAt = new Date().toISOString();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(15000);
  const ladderRead =
    job.journey === 'ladder'
      ? page
          .waitForResponse(
            (response) => response.url() === job.readUrl && response.request().method() === 'GET',
            { timeout: 15000 },
          )
          .catch(() => null)
      : undefined;
  const origins = new Set<string>();
  const steps: {
    index: number;
    action: string;
    expected: string;
    actual: string;
    status: 'passed' | 'blocked';
  }[] = [];
  const assertions: { name: string; passed: boolean; detail: string }[] = [];
  let navigations = 0;
  let limited = false;
  context.on('page', (extra) => {
    if (extra !== page) void extra.close();
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && ++navigations > job.maxNavigations) {
      limited = true;
      void page.close();
    }
  });
  page.on('response', (response) => {
    if (response.headers()['x-trialoom-proxy-denied'] !== '1') {
      const origin = new URL(response.url()).origin;
      if (ready.origins.includes(origin)) origins.add(origin);
    }
  });
  const timer = setTimeout(() => {
    limited = true;
    void page.close();
  }, job.durationMs);
  await context.tracing.start({ screenshots: false, snapshots: true, sources: false });
  try {
    assert.equal((await context.cookies()).length, 0);
    // A fixed owned hold exercises revocation while a browser is alive.
    if (job.hold === true && job.journey === 'owned')
      await new Promise((resolve) => setTimeout(resolve, 30000));
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    const status = response?.status() ?? 0;
    if (!response?.ok() || response.headers()['x-trialoom-proxy-denied'] === '1')
      throw new Error('LOAD_BLOCKED');
    // biome-ignore lint/performance/useDomNodeTextContent: this assertion checks rendered text, excluding hidden SPA content.
    await page.waitForFunction(() => document.body.innerText.trim().length > 20);
    await page.waitForLoadState('load');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    steps.push({
      index: 1,
      action: 'Open the approved homepage in a fresh Chromium context',
      expected: 'Successful HTTPS response and visible page content',
      actual: `HTTP ${status}; visible content rendered`,
      status: 'passed',
    });
    assertions.push({
      name: 'homepage.rendered',
      passed: true,
      detail: `HTTP ${status}; body content rendered in Chromium.`,
    });
    if (job.journey === 'owned') {
      await page.getByRole('link', { name: 'Next page', exact: true }).click();
      await page.getByRole('heading', { name: 'Next page', exact: true }).waitFor();
      steps.push({
        index: 2,
        action: 'Follow the owned sample navigation link',
        expected: 'The next page renders',
        actual: 'Next page heading is visible',
        status: 'passed',
      });
      assertions.push({
        name: 'navigation.rendered',
        passed: true,
        detail: 'Chromium clicked the link and observed the destination heading.',
      });
    }
    if (job.journey === 'ladder') {
      assert(ladderRead);
      const result = await readLadder(page, ladderRead);
      steps.push({
        index: steps.length + 1,
        action: 'Open Leaderboard, then The Ladder',
        expected:
          'The public ladder opens and its displayed player count matches the approved API read',
        actual: `HTTP 200; ${result.count} players in the response and displayed count`,
        status: 'passed',
      });
      assertions.push({
        name: 'ladder.player-count',
        passed: true,
        detail: `Rendered count ${result.count} agrees with the GET response (SHA-256 ${result.sha256}). Player identities are withheld.`,
      });
    }
  } catch {
    steps.push({
      index: steps.length + 1,
      action: 'Complete the read-only journey',
      expected: 'Render the approved page within the run budget',
      actual: limited
        ? 'Runner limit reached'
        : 'Page could not be verified within the permitted scope',
      status: 'blocked',
    });
    assertions.push({
      name: 'journey.completed',
      passed: false,
      detail: 'Execution was blocked; this does not establish a product defect.',
    });
  }
  clearTimeout(timer);
  const tracePath = '/scratch/browser.trace.zip';
  await context.tracing.stop({ path: tracePath });
  const trace = await readFile(tracePath);
  assert(trace.length > 0 && trace.length <= 8 * 1024 ** 2);
  const result = {
    startedAt,
    finishedAt: new Date().toISOString(),
    browser: `Chromium ${browser.version()}`,
    runtime: process.version,
    configurationHash: createHash('sha256')
      .update(await readFile(new URL(import.meta.url)))
      .digest('hex'),
    observedOrigins: [...origins],
    steps,
    assertions,
    outcome: steps.some((step) => step.status === 'blocked') ? 'blocked' : 'executed',
    trace: trace.toString('base64'),
  };
  await browser.close();
  await bridge.close();
  // This bounded pipe is untrusted evidence, never instructions or host witness.
  process.stdout.write(JSON.stringify(result));
}
main().catch(() => {
  process.stderr.write('PREVIEW_BROWSER_FAILED\n');
  process.exitCode = 1;
});
