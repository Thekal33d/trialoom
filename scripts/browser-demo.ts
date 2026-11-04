import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Browser, chromium, expect } from '@playwright/test';
import { startFixture } from '../spikes/browser-evidence/fixture.mjs';
import { migrate } from '../src/server/migrations.ts';
import { disposableDatabase } from '../tests/helpers/database.ts';
import { seedBrowserFixture } from './browser-fixture.ts';
import { executeInvitationRun } from './browser-worker.ts';
import { startLocalServer } from './local-server.ts';

const smoke = process.argv.includes('--smoke');
const directory = resolve('artifacts/browser-runs', randomBytes(8).toString('hex'));
for (const key of [
  'TRIALOOM_REMESSO_AGENT_KEY',
  'TRIALOOM_FEE_RECIPIENT',
  'TRIALOOM_RESOURCE_RECIPIENT',
])
  process.env[key] = '';
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let db: Awaited<ReturnType<typeof disposableDatabase>> | undefined;
let app: Awaited<ReturnType<typeof startLocalServer>> | undefined;
let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
let browser: Browser | undefined;
let serverFailed = false;
try {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  db = await disposableDatabase();
  await migrate(db.pool);
  fixture = await startFixture();
  const setup = await seedBrowserFixture(db.pool, fixture);
  app = await startLocalServer(db.url, directory);
  void app.exited.then(() => {
    serverFailed = true;
    stop();
  });
  browser = await chromium.launch({
    channel: 'chromium',
    headless: smoke,
    slowMo: smoke ? 0 : 150,
    // Chromium must not inherit the controller's .env/database credentials.
    // The trusted controller and fixed driver still share a Node process;
    // this is environment hygiene, not a claim of host/kernel isolation.
    env: Object.fromEntries(
      [
        'PATH',
        'HOME',
        'TMPDIR',
        'TMP',
        'TEMP',
        'LANG',
        'LC_ALL',
        'DISPLAY',
        'WAYLAND_DISPLAY',
        'XAUTHORITY',
        'XDG_RUNTIME_DIR',
        'SYSTEMROOT',
        'WINDIR',
      ].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key] as string]],
      ),
    ),
  });
  browser.once('disconnected', stop);
  const context = await browser.newContext({
    baseURL: app.origin,
    viewport: { width: 1440, height: 1000 },
  });
  context.once('close', stop);
  const page = await context.newPage();
  page.once('close', stop);
  await page.goto('/sign-in/email');
  await page.getByLabel('Email address').fill(setup.email);
  await page.getByLabel('Password', { exact: true }).fill(setup.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/workspace`);
  const run = await setup.assignment();
  console.log('Running Chromium against the owned invitation app. Findings start empty.');
  const result = await executeInvitationRun({
    browser,
    apiOrigin: app.origin,
    runId: run.runId,
    runToken: run.runToken,
    fixture,
    directory,
    signal: controller.signal,
    onProgress: (phase) => console.log(`Browser run: ${phase}`),
  });
  await writeFile(
    resolve(directory, 'result.json'),
    JSON.stringify(
      { runId: run.runId, document: result.document, receipt: result.receipt },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await page.reload();
  await page.getByRole('button', { name: /Canopy — real Chromium run/ }).click();
  const brief = page.locator('.brief-record', {
    hasText: 'Test teammate invitations — fresh browser evidence',
  });
  await expect(brief).toContainText('Reported a product failure');
  await expect(brief).toContainText('Pending review');
  await expect(brief).toContainText('run submitted');
  if (smoke) {
    const { checkBrowserIntegration } = await import('./browser-checks.ts');
    await checkBrowserIntegration({
      pool: db.pool,
      browser,
      page,
      setup,
      fixture,
      app,
      run,
      result,
      directory,
    });
  } else {
    await brief.getByRole('button', { name: 'View replay', exact: true }).first().click();
    const replay = brief.getByRole('region', { name: 'Recorded replay' });
    await expect(replay.locator('.replay-result')).toContainText('HTTP 400');
    await replay.scrollIntoViewIfNeeded();
    await page.bringToFront();
    await page.screenshot({ path: resolve(directory, 'workspace.png') });
    await replay.screenshot({ path: resolve(directory, 'replay-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await replay.getByRole('heading', { name: 'Recorded replay' }).focus();
    await replay.locator('.replay-result').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(directory, 'replay-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await replay.scrollIntoViewIfNeeded();
    console.log(
      `Recorded replay is open at ${app.origin}/workspace. The opened window is signed in. Step through the result, download the sanitized trace or export the brief. No acceptance or payment was performed.`,
    );
    console.log(
      `Private run files: ${directory}. Close the browser or press Ctrl-C to end the disposable session.`,
    );
    if (!controller.signal.aborted)
      await new Promise<void>((done) =>
        controller.signal.addEventListener('abort', () => done(), { once: true }),
      );
    if (serverFailed) throw new Error('The local app stopped unexpectedly.');
  }
} catch (error) {
  if (serverFailed || !controller.signal.aborted) throw error;
} finally {
  await Promise.allSettled([browser?.close(), fixture?.close(), app?.close()]);
  await db?.close();
  await rm(directory, { recursive: true, force: true });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  console.log('Disposable browser-run database and files removed.');
}
