import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { FreeTestsView } from '../../src/domain/free-tests';

test.skip(
  process.env.TRIALOOM_WALLET_LOGIN !== 'true' ||
    process.env.TRIALOOM_PUBLIC_WALLET_SIGNUP !== 'true',
  'Enable wallet login and signup for this suite.',
);
const fixtures = JSON.parse(readFileSync(process.env.TRIALOOM_E2E_FIXTURE ?? '', 'utf8')) as Record<
  string,
  { ownerEmail: string; password: string }
>;

// Only the wallet transport is simulated. Signatures are real, and all auth HTTP,
// cookies, database records and account authorization use the application.
async function installWallet(page: Page, rejected = false) {
  const account = privateKeyToAccount(generatePrivateKey());
  const methods: string[] = [];
  let chainId = '0x1';
  await page.exposeFunction(
    'testWalletRequest',
    async ({ method, params }: { method: string; params?: unknown[] }) => {
      methods.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account.address];
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') {
        chainId = '0xa4ec';
        return null;
      }
      if (method === 'personal_sign') {
        if (rejected) throw new Error('User rejected the request.');
        return account.signMessage({ message: { raw: String(params?.[0]) as `0x${string}` } });
      }
      throw new Error(`Unexpected wallet method: ${method}`);
    },
  );
  await page.addInitScript(() => {
    Object.defineProperty(window, 'ethereum', {
      value: {
        request: (args: unknown) =>
          (
            window as unknown as { testWalletRequest: (args: unknown) => Promise<unknown> }
          ).testWalletRequest(args),
      },
    });
  });
  return { account, methods };
}
async function accessible(page: Page) {
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test('wallet signup, sign-out and returning login work without email or payments', async ({
  page,
}, info) => {
  const { methods } = await installWallet(page);
  await page.goto('/sign-up');
  await accessible(page);
  await page.screenshot({ path: info.outputPath('wallet-signup.png'), fullPage: true });
  await page.getByRole('button', { name: 'Continue with a wallet' }).click();
  await expect(page).toHaveURL('/workspace');
  await expect(page.getByRole('heading', { name: 'My websites' })).toBeVisible();
  const session = await (await page.request.get('/api/auth/get-session')).json();
  expect(session.user.emailVerified).toBe(false);
  const denied = await page.request.post('/api/v1/operator', {
    headers: { origin: 'http://127.0.0.1:3100' },
    data: { handle: `wallet-${info.project.name}` },
  });
  expect(denied.status()).toBe(403);
  await page.getByRole('link', { name: 'Account settings' }).click();
  await accessible(page);
  await page.screenshot({ path: info.outputPath('wallet-account.png'), fullPage: true });
  await page.getByRole('link', { name: 'Back to workspace' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');
  await page.getByRole('button', { name: 'Sign in with a wallet' }).click();
  await expect(page).toHaveURL('/workspace');
  const returning = await (await page.request.get('/api/auth/get-session')).json();
  expect(returning.user.id).toBe(session.user.id);
  expect(methods).toContain('wallet_switchEthereumChain');
  expect(
    methods.every((method) =>
      [
        'eth_requestAccounts',
        'eth_accounts',
        'eth_chainId',
        'wallet_switchEthereumChain',
        'personal_sign',
      ].includes(method),
    ),
  ).toBe(true);
});

test('an email owner links a wallet and returns to the same account', async ({ page }, info) => {
  const fixture = fixtures[info.project.name];
  const { account } = await installWallet(page);
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(fixture.ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/workspace');
  const before = await (await page.request.get('/api/auth/get-session')).json();
  await page.getByRole('link', { name: 'Account settings' }).click();
  await page.getByRole('button', { name: 'Link a wallet' }).click();
  await expect(page.locator('.wallet-addresses')).toContainText(account.address.toLowerCase());
  await accessible(page);
  await page.getByRole('link', { name: 'Back to workspace' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');
  await page.getByRole('button', { name: 'Sign in with a wallet' }).click();
  await expect(page).toHaveURL('/workspace');
  const after = await (await page.request.get('/api/auth/get-session')).json();
  expect(after.user.id).toBe(before.user.id);
  expect(after.user.email).toBe(fixture.ownerEmail);
});

test('missing and rejected wallets show an actionable error without creating a session', async ({
  page,
}) => {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Sign in with a wallet' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Open Trialoom in your wallet',
  );
  await installWallet(page, true);
  await page.goto('/sign-up');
  await page.getByRole('button', { name: 'Continue with a wallet' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  expect(await (await page.request.get('/api/auth/get-session')).json()).toBeNull();
});

test('wallet HTTP routes reject cross-origin requests and rate-limit challenge issuance', async ({
  request,
}) => {
  const account = privateKeyToAccount(generatePrivateKey());
  const data = { address: account.address, intent: 'sign-up' };
  expect(
    (
      await request.post('/api/auth/wallet/challenge', {
        headers: { origin: 'https://attacker.example' },
        data,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post('/api/auth/siwe/verify', {
        headers: { origin: 'http://127.0.0.1:3100' },
        data: {},
      })
    ).status(),
  ).toBe(404);
  for (let i = 0; i < 11; i++) {
    const response = await request.post('/api/auth/wallet/challenge', {
      headers: { origin: 'http://127.0.0.1:3100' },
      data,
    });
    expect(response.status()).toBe(i === 10 ? 429 : 200);
    expect(response.headers()['cache-control']).toBe('no-store');
  }
});

// These result records exercise presentation states only. They are injected at
// the read API; they do not claim that a runner or paid suggestion was executed.
test('a builder saves just a website address and can read an incomplete test and replay', async ({
  page,
}, info) => {
  await installWallet(page);
  await page.goto('/sign-up');
  await page.getByRole('button', { name: 'Continue with a wallet' }).click();
  await expect(page).toHaveURL('/workspace');
  await page.getByRole('button', { name: 'Add website' }).click();
  await expect(page.getByLabel('Website address')).toBeFocused();
  await page.getByLabel('Website address').fill('https://example.com');
  await page.getByLabel('I own this website').check();
  await page.getByRole('button', { name: 'Save website' }).click();
  await expect(page.getByRole('heading', { name: 'example.com', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add website' })).toBeFocused();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'example.com', exact: true })).toBeVisible();

  const result = {
    schemaVersion: 1 as const,
    outcome: 'blocked' as const,
    startedAt: '2026-11-04T10:00:00.000Z',
    finishedAt: '2026-11-04T10:00:05.000Z',
    browser: 'Chromium',
    revisionConfirmed: false as const,
    checks: [
      { check: 'homepage' as const, passed: true },
      { check: 'scope' as const, passed: false },
    ],
    replay: {
      schemaVersion: 1 as const,
      actions: [{ index: 1, method: 'goto', startMs: 0, endMs: 300, status: 'completed' as const }],
      requests: [{ index: 1, method: 'GET', status: 200, startMs: 20, durationMs: 100 }],
    },
  };
  const view: FreeTestsView = {
    available: false,
    allowedOrigins: [],
    remaining: 1,
    tests: [
      {
        id: 'incomplete-ui-fixture',
        project_id: null,
        kind: 'sample',
        phase: 'blocked',
        cancel_requested: false,
        created_at: result.startedAt,
        result,
      },
      {
        id: 'passing-ui-fixture',
        project_id: null,
        kind: 'sample',
        phase: 'completed',
        cancel_requested: false,
        created_at: result.startedAt,
        result: {
          ...result,
          outcome: 'completed',
          checks: result.checks.map((check) => ({ ...check, passed: true })),
        },
      },
    ],
    explanations: {
      'incomplete-ui-fixture': {
        state: 'ready',
        observations: [{ ref: 'check.scope', name: 'scope', passed: false }],
        body: {
          title: 'Review allowed resources',
          summary: 'A resource fell outside the test limits.',
          nextStep: 'Check which resources this page needs.',
          evidenceRefs: ['check.scope'],
        },
      },
    },
  };
  await page.route('**/api/v1/workspaces/*/free-tests', (route) => route.fulfill({ json: view }));
  await expect(page.getByText('Test incomplete', { exact: true })).toBeVisible({ timeout: 15000 });
  const first = page.locator('.test-record').first();
  const older = page.locator('.test-record').last();
  await expect(first).toHaveAttribute('open', '');
  await expect(older).not.toHaveAttribute('open');
  await expect(older.locator('summary').first()).toContainText('All checks passed');
  await expect(first).toContainText('This doesn’t mean your website is broken.');
  await expect(first.getByRole('region', { name: 'AI suggestion' })).toContainText(
    'Check which resources this page needs.',
  );
  await expect(first.locator('.action-timeline')).toBeHidden();
  await first.locator('.result-replay > summary').focus();
  await page.keyboard.press('Enter');
  await expect(first.locator('.action-timeline')).toContainText('Opened the page');
  await expect(first).toContainText('not a video');
  await expect(first.locator('.network-responses')).toBeHidden();
  await first.getByText('Technical details', { exact: true }).click();
  await expect(first.locator('.network-responses')).toContainText('HTTP 200');
  await first.getByText('Why this was suggested', { exact: true }).click();
  await expect(first).toContainText('This is advice, not a test result.');
  await older.locator('summary').first().click();
  await expect(older.locator('.result-check-list')).toBeVisible();
  await accessible(page);
  await first.getByText('Why this was suggested', { exact: true }).click();
  await first.getByText('Technical details', { exact: true }).click();
  await older.locator('summary').first().click();
  await page.getByRole('heading', { level: 1 }).click();
  await page.screenshot({ path: info.outputPath('readable-results.png'), fullPage: true });
});
