import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const fixtures = JSON.parse(readFileSync(process.env.TRIALOOM_E2E_FIXTURE ?? '', 'utf8')) as Record<
  string,
  { signupUrl: string; password: string }
>;
test.skip(
  process.env.TRIALOOM_PUBLIC_SIGNUP !== 'true',
  'Explicitly enable the signup flow for these checks.',
);
async function accessible(page: Page) {
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test('public entry uses a wallet and legacy email requests still fail honestly', async ({
  page,
  request,
}, info) => {
  await page.goto('/sign-up');
  await expect(page).toHaveURL('/sign-in');
  await expect(page.getByLabel('Email address')).toHaveCount(0);
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await accessible(page);
  await page.screenshot({ path: info.outputPath('public-signup.png'), fullPage: true });
  const email = `${info.project.name}-missing-mail@example.test`;
  const first = await request.post('/api/signup/request', {
    headers: { origin: 'http://127.0.0.1:3100' },
    data: { email },
  });
  expect(first.status()).toBe(503);
  for (let i = 0; i < 3; i++) {
    const result = await request.post('/api/signup/request', {
      headers: { origin: 'http://127.0.0.1:3100' },
      data: { email },
    });
    expect(result.status()).toBe(i === 2 ? 429 : 503);
    expect(result.headers()['cache-control']).toBe('no-store');
  }
  const crossOrigin = await request.post('/api/signup/complete', {
    headers: { origin: 'https://attacker.example' },
    data: {},
  });
  expect(crossOrigin.status()).toBe(403);
  const body = await request.post('/api/signup/request', {
    headers: { origin: 'http://127.0.0.1:3100' },
    data: { email, padding: 'x'.repeat(5000) },
  });
  expect(body.status()).toBe(413);
});

test('a previously issued email link creates a free workspace, persists a project and opens operator registration', async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const fixture = fixtures[info.project.name];
  await page.goto(fixture.signupUrl);
  await expect(page).toHaveURL('/sign-up/complete');
  await expect(page.getByLabel('Email address')).toHaveValue(
    `${info.project.name}-free@example.test`,
  );
  await page.getByLabel('Your name').fill('Public builder');
  await page.getByLabel('Choose a password').fill(fixture.password);
  await accessible(page);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/workspace');
  await expect(page.getByRole('heading', { name: 'My websites' })).toBeVisible();
  await expect(
    page.getByText('Live testing isn’t available right now.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add website' }).click();
  await expect(page.getByLabel('Website address')).toBeFocused();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add website' })).toBeFocused();
  await page.getByRole('button', { name: 'Add website' }).click();
  await page.getByLabel('Website name').fill('My preview');
  await page.getByLabel('Website address').fill('https://127.0.0.1');
  await page.getByLabel('I own this website').check();
  await page.getByRole('button', { name: 'Save website' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('private');
  await page.getByLabel('Website address').fill('https://example.com');
  await page.getByRole('button', { name: 'Save website' }).click();
  await expect(page.getByRole('heading', { name: 'My preview' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'My preview' })).toBeVisible();
  await page.getByText('Verify website permission', { exact: true }).click();
  await page.getByRole('button', { name: 'Get verification code' }).click();
  await expect(page.getByLabel('DNS record name')).toHaveValue('_trialoom.example.com');
  await expect(page.getByLabel('DNS record value')).toHaveValue(/^trialoom-verification=/);
  const verificationValue = await page.getByLabel('DNS record value').inputValue();
  await page.reload();
  await page.getByText('Verify website permission', { exact: true }).click();
  await expect(page.getByLabel('DNS record value')).toHaveValue(verificationValue);
  await accessible(page);
  await page.screenshot({ path: info.outputPath('free-workspace.png'), fullPage: true });
  const registered = await page.request.post('/api/v1/operator', {
    headers: { origin: 'http://127.0.0.1:3100' },
    data: { handle: `${info.project.name}-public-operator` },
  });
  expect(registered.status()).toBe(201);
  await page.goto('/operator');
  await expect(page).toHaveURL('/operator');
  await expect(page.getByRole('heading', { name: /Prove who you are/ })).toBeVisible();
  await page.goto('/workspace');
  await page.getByRole('link', { name: 'Paid testing', exact: true }).click();
  await expect(page).toHaveURL('/jobs');
  await expect(page.getByRole('button', { name: 'Open paid testing' })).toBeVisible();
  await accessible(page);
  await page.getByRole('button', { name: 'Open paid testing' }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Workspace', exact: true })).toBeVisible();
  await page.goto('/workspace');
  await expect(page.getByRole('heading', { name: 'My websites' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');
  await page.goto(fixture.signupUrl);
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'expired or was already used',
  );
});
