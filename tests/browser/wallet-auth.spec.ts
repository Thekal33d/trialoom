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
async function installWallet(
  page: Page,
  rejected = false,
  kind: 'MetaMask' | 'Rabby' = 'MetaMask',
  legacy = false,
) {
  const account = privateKeyToAccount(generatePrivateKey());
  const methods: string[] = [];
  let chainId = '0x1';
  await page.exposeFunction(
    `testWalletRequest${kind}`,
    async ({ method, params }: { method: string; params?: unknown[] }) => {
      methods.push(method);
      if (method === 'wallet_requestPermissions') {
        expect(params).toEqual([{ eth_accounts: {} }]);
        return [
          {
            parentCapability: 'eth_accounts',
            caveats: [{ type: 'restrictReturnedAccounts', value: [account.address] }],
          },
        ];
      }
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
  await page.addInitScript(
    ({ kind, legacy }) => {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const provider = {
        isMetaMask: kind === 'MetaMask',
        isRabby: kind === 'Rabby',
        on: (event: string, listener: (...args: unknown[]) => void) => {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)?.add(listener);
        },
        removeListener: (event: string, listener: (...args: unknown[]) => void) => {
          listeners.get(event)?.delete(listener);
        },
        request: async (args: { method: string }) => {
          const result = await (
            window as unknown as Record<string, (args: unknown) => Promise<unknown>>
          )[`testWalletRequest${kind}`](args);
          if (args.method === 'wallet_switchEthereumChain') {
            for (const listener of listeners.get('chainChanged') ?? []) listener('0xa4ec');
          }
          return result;
        },
      };
      if (!('ethereum' in window)) Object.defineProperty(window, 'ethereum', { value: provider });
      const browser = window as Window & {
        ethereum?: typeof provider & { providers?: (typeof provider)[] };
      };
      if (browser.ethereum) {
        browser.ethereum.providers ??= [browser.ethereum];
        if (!browser.ethereum.providers.includes(provider))
          browser.ethereum.providers.push(provider);
      }
      if (legacy) return;
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: {
              provider,
              info: {
                uuid:
                  kind === 'MetaMask'
                    ? '95a8f379-3141-4d18-8255-8d6b8995ac04'
                    : '95a8f379-3141-4d18-8255-8d6b8995ac05',
                name: `Test ${kind}`,
                rdns: kind === 'MetaMask' ? 'io.metamask' : 'io.rabby',
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="orange"/></svg>',
              },
            },
          }),
        );
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
    },
    { kind, legacy },
  );
  return { account, methods };
}
async function connectWallet(page: Page, label = 'Connect wallet', name = 'Test MetaMask') {
  await page.getByRole('button', { name: label, exact: true }).click();
  const walletName =
    test.info().project.name === 'mobile'
      ? name.replace('Test MetaMask', 'MetaMask').replace('Test Rabby', 'Rabby Wallet')
      : name;
  const wallet = page
    .getByRole('button')
    .filter({ hasText: new RegExp(`^${walletName}(Recent| Recent)?$`) });
  await expect(page.getByRole('combobox')).toHaveCount(0);
  if (test.info().title.startsWith('wallet signup')) {
    // Wait for the sheet's opening transition before measuring text contrast.
    await page.getByRole('dialog').evaluate(async (dialog) => {
      await Promise.all(
        dialog.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
    });
    await accessible(page);
  }
  await page.screenshot({ path: test.info().outputPath('wallet-picker.png') });
  await wallet.click();
  await page.getByRole('button', { name: 'Sign message', exact: true }).click();
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
  await page.goto('/sign-in');
  await expect(page.getByLabel('Email address')).toHaveCount(0);
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await accessible(page);
  await page.screenshot({ path: info.outputPath('wallet-signup.png'), fullPage: true });
  await connectWallet(page);
  await expect(page).toHaveURL('/workspace');
  await expect(page.getByRole('heading', { name: 'My websites' })).toBeVisible();
  const session = await (await page.request.get('/api/auth/get-session')).json();
  expect(session.user.emailVerified).toBe(false);
  const registered = await page.request.post('/api/v1/operator', {
    headers: { origin: 'http://127.0.0.1:3100' },
    data: { handle: `wallet-${info.project.name}` },
  });
  expect(registered.status()).toBe(201);
  await page.getByRole('link', { name: 'Account settings' }).click();
  await accessible(page);
  await page.screenshot({ path: info.outputPath('wallet-account.png'), fullPage: true });
  await page.getByRole('link', { name: 'Back to workspace' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');
  await connectWallet(page);
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
        'wallet_requestPermissions',
        'personal_sign',
      ].includes(method),
    ),
  ).toBe(true);
});

test('an email owner links a wallet and returns to the same account', async ({ page }, info) => {
  const fixture = fixtures[info.project.name];
  const { account } = await installWallet(page);
  await page.goto('/sign-in/email');
  await page.getByLabel('Email address').fill(fixture.ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/workspace');
  const before = await (await page.request.get('/api/auth/get-session')).json();
  await page.getByRole('link', { name: 'Account settings' }).click();
  await connectWallet(page, 'Link a wallet');
  await expect(page.locator('.wallet-addresses')).toContainText(account.address.toLowerCase());
  await accessible(page);
  await page.getByRole('link', { name: 'Back to workspace' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');
  await connectWallet(page);
  await expect(page).toHaveURL('/workspace');
  const after = await (await page.request.get('/api/auth/get-session')).json();
  expect(after.user.id).toBe(before.user.id);
  expect(after.user.email).toBe(fixture.ownerEmail);
});

test('missing and rejected wallets do not create a session', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Get a wallet' })).toBeVisible();
  expect(await (await page.request.get('/api/auth/get-session')).json()).toBeNull();
  await installWallet(page, true);
  await page.goto('/sign-up');
  await connectWallet(page);
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await (await page.request.get('/api/auth/get-session')).json()).toBeNull();
});

test('multiple EIP-6963 wallets stay distinct and only the chosen wallet signs', async ({
  page,
}) => {
  const first = await installWallet(page);
  const second = await installWallet(page, false, 'Rabby');
  await page.goto('/sign-in');
  await connectWallet(page, 'Connect wallet', 'Test Rabby');
  await expect(page).toHaveURL('/workspace');
  await page.getByRole('link', { name: 'Account settings' }).click();
  await expect(page.locator('.wallet-addresses')).toContainText(
    second.account.address.toLowerCase(),
  );
  await expect(page.locator('.wallet-addresses')).not.toContainText(
    first.account.address.toLowerCase(),
  );
  expect(first.methods).not.toContain('personal_sign');
  expect(second.methods).toContain('personal_sign');
});

test('legacy window.ethereum wallets still connect without EIP-6963', async ({ page }) => {
  await installWallet(page, false, 'MetaMask', true);
  await page.goto('/sign-in');
  await connectWallet(page, 'Connect wallet', 'MetaMask');
  await expect(page).toHaveURL('/workspace');
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
  // Two deliberate ten-second idle polls plus real signup and accessibility scans.
  test.setTimeout(60000);
  await installWallet(page);
  await page.goto('/sign-up');
  await connectWallet(page);
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
        purchase: {
          service: 'cencori.v1.chat.completions',
          settlement: 'pending',
          token: 'USDT',
          amountUnits: '9000',
          transactionHash: null,
          requestHash: 'a'.repeat(64),
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
  await first.getByText('Service purchase', { exact: true }).click();
  await expect(first).toContainText('Confirmation pending');
  await expect(first).toContainText('Quoted 0.009 USDT');
  await expect(first.getByRole('link', { name: 'View payment on Celo' })).toHaveCount(0);
  const explanation = view.explanations['incomplete-ui-fixture'];
  if (!explanation.purchase) throw new Error('Missing test purchase');
  explanation.purchase.settlement = 'verified';
  explanation.purchase.transactionHash = `0x${'b'.repeat(64)}`;
  // Paid-but-unusable output must retain a visible receipt without inventing advice.
  explanation.state = 'unusable';
  explanation.body = null;
  await page.reload();
  // The initial server render is real; this UI fixture arrives on the ten-second idle poll.
  await expect(first).toContainText('The service response could not be used.', { timeout: 15000 });
  await first.getByText('Service purchase', { exact: true }).click();
  await expect(first).toContainText('Verified on Celo');
  await expect(first).toContainText('Paid 0.009 USDT');
  await expect(first.getByRole('link', { name: 'View payment on Celo' })).toHaveAttribute(
    'href',
    `https://celoscan.io/tx/0x${'b'.repeat(64)}`,
  );
  await accessible(page);
  await page.screenshot({ path: info.outputPath('service-payment-proof.png'), fullPage: true });
});
