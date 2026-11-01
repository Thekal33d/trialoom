import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect } from '@playwright/test';
import { dispatchFreeTest, freeRunnerHeartbeat } from '../src/server/free-test-dispatch.ts';
import { requestFreeTest } from '../src/server/free-tests.ts';
import { migrate } from '../src/server/migrations.ts';
import { requestSignup } from '../src/server/signup.ts';
import { disposableDatabase } from '../tests/helpers/database.ts';
import { seedFreeAccount } from '../tests/helpers/free-account.ts';
import { freePreviewRunner } from './free-preview-runner.ts';
import { startLocalServer } from './local-server.ts';
import { buildPreviewImage } from './preview-host.ts';

const directory = resolve('artifacts/free-test-checks', randomBytes(8).toString('hex'));
await mkdir(directory, { recursive: true, mode: 0o700 });
const db = await disposableDatabase();
let app: Awaited<ReturnType<typeof startLocalServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let worker: ReturnType<typeof spawn> | undefined;
let workerExit: Promise<void> | undefined;
const children = new Set<ReturnType<typeof fork>>();
let image = '';
try {
  await migrate(db.pool);
  image = await buildPreviewImage();
  console.log(JSON.stringify({ event: 'free_check.host_ready' }));
  process.env.TRIALOOM_PUBLIC_SIGNUP = 'true';
  process.env.TRIALOOM_FREE_TESTS = 'true';
  process.env.RESEND_API_KEY = '';
  process.env.TRIALOOM_EMAIL_FROM = '';
  app = await startLocalServer(db.url, directory);
  worker = spawn(process.execPath, ['workers/free-tests.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DATABASE_URL: db.url,
      TRIALOOM_FREE_TARGET_ORIGINS: '',
      TRIALOOM_REMESSO_AGENT_KEY: '',
    },
  });
  worker.stdout?.resume();
  worker.stderr?.resume();
  workerExit = new Promise<void>((done) => {
    worker?.once('exit', () => done());
  });
  for (let n = 0; n < 120; n++) {
    if ((await db.pool.query('SELECT 1 FROM free_test_runtime')).rowCount) break;
    assert(worker.exitCode === null, 'FREE_WORKER_EXITED');
    await delay(500);
  }
  assert.equal((await db.pool.query('SELECT 1 FROM free_test_runtime')).rowCount, 1);
  let signupUrl = '';
  await requestSignup(
    db.pool,
    { email: 'free-browser-check@example.test' },
    app.origin,
    async (mail) => {
      signupUrl = mail.url;
    },
  );
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(signupUrl);
  await page.getByLabel('Your name').fill('Sample builder');
  await page.getByLabel('Workspace name').fill('My free workspace');
  await page.getByLabel('Choose a password').fill(randomBytes(24).toString('base64url'));
  await page.getByRole('button', { name: 'Create free workspace' }).click();
  await expect(page).toHaveURL(`${app.origin}/workspace`);
  await expect(page.getByRole('button', { name: 'Run sample test' })).toBeEnabled();
  await page.getByRole('button', { name: 'Run sample test' }).click();
  await expect(page.getByText('Checks completed', { exact: true })).toBeVisible({ timeout: 90000 });
  await page.getByText('View replay', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recorded browser actions' })).toBeVisible();
  await expect(
    page.getByText('Sample next-page navigation rendered', { exact: true }),
  ).toBeVisible();
  const row = (await db.pool.query('SELECT * FROM free_tests')).rows[0];
  assert.equal(row.phase, 'completed');
  assert(row.cleanup_at);
  assert(row.result.replay.actions.length > 0 && row.result.replay.requests.length > 0);
  assert.equal(row.target.addresses[0], '127.0.0.1');
  console.log(JSON.stringify({ event: 'free_check.replay_ready' }));
  for (const size of [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    assert.deepEqual(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
      [],
    );
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: resolve(directory, `${size.name}.png`), fullPage: true });
  }
  await page.reload();
  await expect(page.getByText('Checks completed', { exact: true })).toBeVisible();
  worker.kill('SIGTERM');
  await workerExit;
  worker = undefined;
  const recovery: { checkpoint: string; phase: string }[] = [];
  for (const checkpoint of ['running', 'captured'] as const) {
    const account = await seedFreeAccount(db.pool);
    await freeRunnerHeartbeat(db.pool, []);
    const queued = await requestFreeTest(
      db.pool,
      account.actor,
      account.workspaceId,
      { kind: 'sample', requestId: randomUUID() },
      true,
    );
    const child = fork(resolve('scripts/free-runner-check-child.ts'), [], {
      silent: true,
      env: { ...process.env, DATABASE_URL: db.url },
    });
    children.add(child);
    child.stdout?.resume();
    child.stderr?.resume();
    const exit = new Promise<void>((done) => {
      child.once('exit', () => {
        children.delete(child);
        done();
      });
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 70000);
    const message = new Promise<{ checkpoint?: string; error?: string }>((done, reject) => {
      child.once('message', (value) => done(value as never));
      child.once('error', reject);
      void exit.then(() => reject(new Error('CHECKPOINT_NOT_REACHED')));
    });
    child.stdin?.end(JSON.stringify({ image, checkpoint }));
    try {
      assert.equal((await message).checkpoint, checkpoint);
      child.kill('SIGKILL');
      await exit;
    } finally {
      clearTimeout(timer);
    }
    const runner = freePreviewRunner(image, []);
    await dispatchFreeTest(db.pool, {
      ...runner,
      run: async () => {
        assert.fail('Recovery redispatched a browser');
      },
    });
    const recovered = (
      await db.pool.query('SELECT phase,cleanup_at FROM free_tests WHERE id=$1', [queued.id])
    ).rows[0];
    assert.equal(recovered.phase, checkpoint === 'captured' ? 'completed' : 'interrupted');
    assert(recovered.cleanup_at);
    recovery.push({ checkpoint, phase: recovered.phase });
    console.log(
      JSON.stringify({ event: 'free_check.recovered', checkpoint, phase: recovered.phase }),
    );
  }
  for (const table of [
    'campaigns',
    'assignments',
    'payables',
    'payment_authorities',
    'resource_purchases',
  ])
    assert.equal((await db.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
  const evidence = {
    task: 'FREE-02',
    checkedAt: new Date().toISOString(),
    image,
    mode: 'offline-owned-proxy-fixture-v1',
    automaticDispatch: true,
    signupToReplay: true,
    actions: row.result.replay.actions.length,
    requests: row.result.replay.requests.length,
    recovery,
    customerLiabilityUnits: '0',
    publicTargetsContacted: false,
  };
  await writeFile(resolve(directory, 'checkpoint.json'), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ event: 'free_tests.verified', directory, ...evidence }));
} finally {
  if (worker) {
    worker.kill('SIGTERM');
    await workerExit;
  }
  for (const child of children) child.kill('SIGKILL');
  await browser?.close();
  await app?.close();
  if (image) {
    const rows = (
      await db.pool.query("SELECT * FROM free_tests WHERE phase IN ('running','captured')")
    ).rows;
    for (const row of rows) await freePreviewRunner(image, []).cleanup(row);
  }
  await db.close();
}
