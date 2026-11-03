import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('journeys filter, search, recover from empty results, and open evidence', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveURL('/demo');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Your release,');
  await expect(page.locator('.journey-row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Needs review', exact: true }).click();
  await expect(page.locator('.journey-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Passed', exact: true }).click();
  await expect(page.locator('.journey-row')).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Find a journey' }).fill('no such journey');
  await expect(page.getByRole('heading', { name: 'No matching journeys' })).toBeVisible();
  await page.getByRole('button', { name: 'Show all journeys' }).click();
  await expect(page.locator('.journey-row')).toHaveCount(3);
  await page
    .getByRole('link', { name: 'Invite a teammate with a plus address', exact: true })
    .click();
  await expect(page).toHaveURL('/demo/evidence#plus-address');
  await expect(
    page.getByRole('heading', { name: 'Plus-address invitations are rejected' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('comparison preserves pending acceptance and exports a labelled demo report', async ({
  page,
}) => {
  await page.goto('/demo/evidence');
  await expect(page.locator('.response-code')).toContainText('400');
  await page.getByRole('button', { name: 'Candidate build' }).click();
  await expect(page.locator('.response-code')).toContainText('201');
  await expect(page.getByRole('button', { name: 'Candidate build' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.review-boundary')).toContainText('same operator');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export demo report' }).click();
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
  await page.getByRole('button', { name: 'Original build' }).click();
  await expect(page.locator('.response-code')).toContainText('400');
});

test('navigation reaches payments and the guide on both screen sizes', async ({ page }) => {
  await page.goto('/demo');
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Payments' })
    .click();
  await expect(page.getByRole('heading', { name: 'No accepted work to pay yet.' })).toBeVisible();
  await expect(page.getByText('No spending authorized')).toBeVisible();
  await expect(page.getByText('Live payments are not enabled in this preview.')).toBeVisible();
  await page.locator('footer').getByRole('link', { name: 'How Trialoom works' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a journey' })).toBeVisible();
});

for (const path of ['/demo', '/demo/evidence', '/demo/payments', '/demo/guide']) {
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

test('health, readiness, and demo security headers are explicit', async ({ request }) => {
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  // This suite runs the invited build, so the endpoint must report that mode
  // and must not claim testing is available.
  expect(await health.json()).toMatchObject({ mode: 'invited-alpha', testing: 'unavailable' });
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
