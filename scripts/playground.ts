import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type Browser, chromium, expect, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { canaries, startFixture } from '../spikes/browser-evidence/fixture.mjs';

export type PlaygroundFixture = {
  evidenceOwnerEmail: string;
  password: string;
  submitterHandle: string;
};

async function availablePort() {
  const socket = createServer();
  await new Promise<void>((done, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', done);
  });
  const address = socket.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((done, reject) =>
    socket.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

async function ready(child: ChildProcess, origin: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 120; attempt++) {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('The practice server exited before it was ready.');
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // The owned server is still binding its loopback socket.
    }
    await delay(500, undefined, { signal });
  }
  throw new Error('The practice server did not become ready within one minute.');
}

async function verifyJourney(page: Page, sample: Page, fixture: PlaygroundFixture) {
  // Exercise a real bug in our owned fixture, separately from the seeded reports.
  for (const [email, status] of [
    ['teammate@example.test', 201],
    ['teammate+qa@example.test', 400],
  ] as const) {
    await sample.getByLabel('Teammate email').fill(email);
    const response = sample.waitForResponse((item) => item.url().endsWith('/api/invitations'));
    await sample.getByRole('button', { name: 'Send invitation' }).click();
    assert.equal((await response).status(), status);
    await expect(sample.getByRole('status')).toHaveAttribute(
      'data-outcome',
      status === 201 ? 'invited' : 'rejected',
    );
  }

  const brief = page.locator('.brief-record', {
    hasText: 'Test teammate invitations — sample findings',
  });
  await expect(brief).toContainText('Pending review');
  const report = await page.request.get(
    (await brief.getByRole('link', { name: 'Open redacted copy' }).first().getAttribute('href')) ??
      '',
  );
  assert.equal(report.status(), 200);
  assert(!(await report.text()).includes('abcdefghijklmnopqrstuvwxyz012345'));
  const pending = brief.locator('.editor-panel', {
    hasText: `${fixture.submitterHandle} · execution not decided`,
  });
  await pending.getByLabel('Outcome').selectOption('accepted');
  await pending
    .getByLabel('Reason, against the pinned acceptance criteria')
    .fill('Practice only: reviewing the seeded example to test the decision workflow.');
  await pending.getByRole('button', { name: 'Record decision' }).click();
  await expect(brief.locator('.decision-trail')).toContainText('execution accepted');
  await expect(brief.locator('.payout-block')).toContainText('2.00 USDC');
  await expect(brief.locator('.payout-block')).toContainText('no payout wallet');
  await page.reload();
  await page.getByRole('button', { name: /Canopy — sample invitation app/ }).click();
  await expect(brief.locator('.decision-trail')).toContainText('execution accepted');

  const downloadEvent = page.waitForEvent('download');
  await brief.getByRole('link', { name: 'Export this brief' }).click();
  const download = await downloadEvent;
  assert.equal(await download.failure(), null);
  const file = await download.path();
  assert(file);
  const files = unzipSync(await readFile(file));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  assert.equal(manifest.redaction.rawBytesIncluded, false);
  assert(
    !Object.values(files)
      .map((bytes) => strFromU8(bytes))
      .join('\n')
      .includes('abcdefghijklmnopqrstuvwxyz012345'),
  );
  console.log(
    'Practice check passed: real fixture 201/400, redacted report, persisted review, blocked payment, ZIP download.',
  );
}

/** Interactive use of the real app against a disposable test database. */
export async function openPlayground({
  databaseUrl,
  directory,
  fixture,
  smoke,
}: {
  databaseUrl: string;
  directory: string;
  fixture: PlaygroundFixture;
  smoke: boolean;
}) {
  await access('.next/BUILD_ID').catch(() => {
    throw new Error('Run npm run build before opening the playground.');
  });
  const origin = `http://127.0.0.1:${await availablePort()}`;
  const controller = new AbortController();
  const stop = () => controller.abort();
  let userStopped = false;
  const requestStop = () => {
    userStopped = true;
    stop();
  };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  let sampleApp: Awaited<ReturnType<typeof startFixture>> | undefined;
  try {
    child = spawn(
      process.execPath,
      [
        'node_modules/next/dist/bin/next',
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        new URL(origin).port,
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          BETTER_AUTH_URL: origin,
          BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'),
          TRIALOOM_EVIDENCE_DIR: resolve(directory, 'evidence'),
          TRIALOOM_REMESSO_AGENT_KEY: '',
          TRIALOOM_FEE_RECIPIENT: '',
          TRIALOOM_RESOURCE_RECIPIENT: '',
        },
      },
    );
    child.once('error', stop);
    child.once('exit', stop);
    await ready(child, origin, controller.signal);
    sampleApp = await startFixture();
    const sampleOrigin = sampleApp.origin;
    browser = await chromium.launch({ channel: 'chromium', headless: smoke });
    browser.once('disconnected', requestStop);
    const context = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1440, height: 1000 },
    });
    context.once('close', requestStop);
    context.on('page', (page) =>
      page.once('close', () => {
        if (context.pages().length === 0) requestStop();
      }),
    );
    await context.route('**/*', (route) => {
      const target = new URL(route.request().url()).origin;
      if (target === sampleOrigin)
        return route.continue({
          headers: { ...route.request().headers(), 'x-fixture-token': canaries[0] },
        });
      if (target === origin) return route.continue();
      return route.abort('blockedbyclient');
    });

    const guide = await context.newPage();
    await guide.setContent(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Start here · Trialoom practice</title>
      <style>body{font:18px/1.6 system-ui;background:#f6f5ef;color:#202d26;max-width:760px;margin:4rem auto;padding:0 2rem}h1{line-height:1.2}li{margin:1rem 0}a{color:#174b38}small{color:#526059}</style>
      <small>Trialoom · private local practice</small><h1>Try a test, then review the finding.</h1>
      <p>You are signed in to a disposable practice workspace. Reports, operators, repairs, and money shown there are sample data. No emails are sent and no money moves.</p>
      <ol><li>In the <strong>invitation fixture</strong> tab, invite <code>teammate@example.test</code>. It should succeed. Try <code>teammate+qa@example.test</code> next: the app rejects this valid alias. That is the bug.</li>
      <li>In the <strong>Trialoom</strong> tab, open <strong>Canopy — sample invitation app</strong>, then find <strong>Test teammate invitations — sample findings</strong>. Read the execution and open a redacted report.</li>
      <li>Under <strong>Reports and decisions</strong>, find <strong>@practice-submitter · execution not decided</strong>. Leave <strong>Accept the execution</strong> selected, enter a practice reason, and click <strong>Record decision</strong>. The decision persists when you reload. Payment remains blocked.</li>
      <li>Click <strong>Export this brief</strong> for a ZIP of the report and decisions. You can also explore <strong>What's waiting</strong> and the sample repair brief.</li></ol>
      <p>The manual invitation test is separate from the seeded workspace reports; it is not automatically submitted. Seeded binary trace files are placeholders and are withheld from exports. This session does not demonstrate a hosted agent, an independent human operator, or a live payment.</p>
      <p>Keep this browser open while you explore. Closing the browser or stopping the command removes its practice database and temporary files. Run <code>npm run playground</code> to start again with fresh examples.</p></html>`);
    const sample = await context.newPage();
    await sample.goto(sampleOrigin);
    await expect(sample.getByLabel('Teammate email')).toBeVisible();
    const page = await context.newPage();
    await page.goto('/sign-in');
    await page.getByLabel('Email address').fill(fixture.evidenceOwnerEmail);
    await page.getByLabel('Password', { exact: true }).fill(fixture.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/workspace`);
    await page.getByRole('button', { name: /Canopy — sample invitation app/ }).click();
    await expect(
      page.locator('.brief-record', { hasText: 'Test teammate invitations — sample findings' }),
    ).toContainText('Pending review');
    if (smoke) {
      await verifyJourney(page, sample, fixture);
    } else {
      await page.screenshot({ path: resolve(directory, 'workspace.png'), fullPage: false });
      await guide.bringToFront();
      console.log(
        `Practice ready at ${origin}/workspace. Three browser tabs are open; start with the guide. No wallet or worker is enabled. Close the browser or press Ctrl-C to discard this session.`,
      );
      console.log(`Private session files: ${directory}`);
      if (!controller.signal.aborted)
        await new Promise<void>((done) =>
          controller.signal.addEventListener('abort', () => done(), { once: true }),
        );
      if (!userStopped) throw new Error('The practice server stopped unexpectedly.');
    }
  } catch (error) {
    if (!userStopped) throw error;
  } finally {
    await Promise.allSettled([browser?.close(), sampleApp?.close()]);
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((done) => child?.once('exit', () => done()));
      child.kill('SIGTERM');
      await Promise.race([exited, delay(5000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
  }
}
