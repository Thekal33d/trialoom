import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser } from '@playwright/test';
import { expect } from '@playwright/test';

/** Compatibility check against the installed viewer, only for our sanitized fixture. */
export async function checkTraceViewer(browser: Browser, path: string, actionCount: number) {
  const child = spawn(
    process.execPath,
    ['node_modules/playwright/cli.js', 'show-trace', path, '--host', '127.0.0.1', '--port', '0'],
    {
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', PWTEST_UNDER_TEST: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let origin: string | undefined;
  let stopped = false;
  const exited = new Promise<void>((done) => {
    child.once('exit', () => {
      stopped = true;
      done();
    });
    child.once('error', () => {
      stopped = true;
      done();
    });
  });
  child.stdout.on('data', (bytes: Buffer) => {
    origin ??= bytes.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  });
  child.stderr.resume();
  // Enough height avoids virtualized rows in this small fixture.
  const context = await browser.newContext({ viewport: { width: 1440, height: 2000 } });
  try {
    for (let i = 0; !origin && !stopped && i < 100; i++) await delay(100);
    assert(origin && !stopped, 'The local trace viewer must start.');
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.name));
    await page.goto(origin);
    await expect(page.locator('.action-title-method').first()).toBeVisible();
    // Playwright hides low-level read actions by default and labels that count.
    const hidden = page.getByText(/^\d+ hidden$/);
    const hiddenCount = (await hidden.count())
      ? Number.parseInt((await hidden.textContent()) ?? '0', 10)
      : 0;
    assert.equal((await page.locator('.action-title-method').count()) + hiddenCount, actionCount);
    await expect(page.locator('body')).toContainText('Fill');
    await page.getByRole('tab', { name: /^Network/ }).click();
    await expect(page.getByRole('option', { name: /POST 201/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /POST 400/ })).toBeVisible();
    assert.deepEqual(errors, []);
    console.log(
      'PASS: downloaded metadata trace opens in the installed Playwright viewer with actions and network records.',
    );
  } finally {
    await context.close();
    if (!stopped) child.kill('SIGTERM');
    await Promise.race([exited, delay(3000, undefined, { ref: false })]);
    if (!stopped) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}
