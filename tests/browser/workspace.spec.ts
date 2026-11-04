import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('agent access is discoverable, explains wallet scope and fits narrow screens', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'For agents', exact: true }).click();
  await expect(page).toHaveURL('/agents');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('A result you can inspect');
  await expect(page.locator('pre')).toContainText('scripts/trialoom-agent.ts --sample');
  await expect(page.getByRole('main')).toContainText('It never signs a payment');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath('agent-access.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('the example leads with the issue and opens its recorded steps', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/demo');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('One thing to fix.');
  await expect(page.locator('.report-checks li')).toHaveCount(3);
  await page.getByRole('link', { name: 'See what happened' }).click();
  await expect(page).toHaveURL('/demo/evidence#plus-address');
  await expect(page.getByRole('heading', { name: 'Invitation rejected' })).toBeVisible();
  await expect(page.locator('.test-steps li')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('comparison preserves pending acceptance and exports a labelled demo report', async ({
  page,
}) => {
  await page.goto('/demo/evidence');
  await expect(page.getByRole('heading', { name: 'Invitation rejected' })).toBeVisible();
  await page.getByRole('button', { name: 'Proposed fix' }).click();
  await expect(page.getByRole('heading', { name: 'Invitation created' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Proposed fix' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.review-boundary')).toContainText('still needs an independent review');
  await expect(page.getByRole('link', { name: 'Download example report' })).toBeHidden();
  await page.getByText('Technical details & download', { exact: true }).click();
  await expect(page.locator('.technical-facts')).toContainText('201');
  await expect(page.locator('.technical-facts')).toContainText('same operator');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download example report' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  if (!path) throw new Error('Demo report download missing');
  const report = JSON.parse(await readFile(path, 'utf8'));
  expect(report).toMatchObject({
    mode: 'synthetic-demo',
    independentOperator: false,
    paymentAuthorized: false,
    marketplaceAcceptance: 'pending-independent-operator-review',
    baseline: { httpStatus: 400 },
    candidate: { httpStatus: 201 },
  });
  await page.getByRole('button', { name: 'Original version' }).click();
  await expect(page.getByRole('heading', { name: 'Invitation rejected' })).toBeVisible();
});

test('the guide keeps future paid work separate from the free beta', async ({ page }) => {
  await page.goto('/demo');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'How it works' })
    .click();
  await expect(page.getByRole('heading', { name: 'Start with a website.' })).toBeVisible();
  await page.getByText('Will Trialoom fix my website for me?', { exact: true }).click();
  await page.getByRole('link', { name: 'About future paid work' }).click();
  await expect(page.getByRole('heading', { name: 'No accepted work to pay yet.' })).toBeVisible();
  await expect(page.getByText('No spending authorized.', { exact: false })).toBeVisible();
});

for (const path of ['/', '/demo', '/demo/evidence', '/demo/payments', '/demo/guide']) {
  test(`${path} is accessible and fits the viewport`, async ({ page }, testInfo) => {
    await page.goto(path);
    await page.evaluate(() => document.fonts.ready);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      results.violations.map(({ id, nodes }) => ({
        id,
        failures: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
      })),
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('page.png'), fullPage: true });
  });
}

const signup =
  process.env.TRIALOOM_PUBLIC_SIGNUP === 'true' ||
  (process.env.TRIALOOM_WALLET_LOGIN === 'true' &&
    process.env.TRIALOOM_PUBLIC_WALLET_SIGNUP === 'true');
const testing = process.env.TRIALOOM_FREE_TESTS === 'true';

test('the landing page offers an honest next action for this deployment', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Let an agent test your app.',
  );
  await expect(page.getByRole('region', { name: 'Example test result' })).toBeVisible();
  await expect(page.locator('.home-availability')).toContainText(
    testing ? 'Free during beta' : 'Live testing isn’t available here yet',
  );
  await page.getByText('What can I try today?', { exact: true }).click();
  await expect(
    page.getByText(
      process.env.TRIALOOM_WALLET_LOGIN === 'true'
        ? 'Connect a wallet to access'
        : 'Account signup is not open yet',
      {
        exact: false,
      },
    ),
  ).toBeVisible();
  await page
    .getByRole('link', {
      name:
        process.env.TRIALOOM_WALLET_LOGIN === 'true'
          ? 'See an example report'
          : 'Explore the example',
    })
    .click();
  await expect(page).toHaveURL('/demo');
});

test('public pages remain usable at 320 pixels', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  for (const route of ['/', '/demo', '/demo/evidence', '/sign-in', '/sign-up']) {
    await page.goto(route);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      route,
    ).toBe(true);
  }
});

test('health, readiness, and demo security headers are explicit', async ({ request }) => {
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({
    mode: signup ? 'public-beta' : 'invited-alpha',
    testing: testing ? 'enabled' : 'unavailable',
    privileged: false,
  });
  expect((await request.get('/api/ready')).status()).toBe(200);
  const page = await request.get('/demo');
  expect(page.headers()['x-content-type-options']).toBe('nosniff');
  expect(page.headers()['x-frame-options']).toBe('DENY');
  expect(await page.text()).toContain('noindex, nofollow');
  expect(
    (
      await request.post('/api/v1/assignments', {
        data: {},
        headers: { Origin: 'http://127.0.0.1:3100' },
      })
    ).status(),
  ).toBe(404);
});

test('missing database configuration fails readiness without exposing secrets', async ({
  request,
}) => {
  const response = await request.get('http://127.0.0.1:3101/api/ready');
  expect(response.status()).toBe(503);
  expect(await response.json()).toEqual({ status: 'unavailable', code: 'DATABASE_NOT_READY' });
  expect((await request.get('http://127.0.0.1:3101/api/health')).status()).toBe(200);
});
