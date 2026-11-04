import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

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
  await page.getByRole('button', { name: 'Create workspace with a wallet' }).click();
  await expect(page).toHaveURL('/workspace');
  await expect(page.getByRole('heading', { name: /Wallet .*workspace/ })).toBeVisible();
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
  await page.getByRole('button', { name: 'Create workspace with a wallet' }).click();
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
