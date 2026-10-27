import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

type Fixture = { password: string; operatorEmail: string };
const fixtures = JSON.parse(readFileSync(process.env.TRIALOOM_E2E_FIXTURE ?? '', 'utf8')) as Record<
  string,
  Fixture
>;
const correctReports: Record<string, Record<string, unknown>> = {
  'invite-alias-defect': {
    defectPresent: true,
    failingStep: 'invitation.create',
    expectedStatus: 201,
    observedStatus: 400,
  },
  'invite-alias-repaired': {
    defectPresent: false,
    failingStep: null,
    expectedStatus: 201,
    observedStatus: 201,
  },
};
async function signIn(page: Page, fixture: Fixture) {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(fixture.operatorEmail);
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/workspace');
}

test('an operator registers, proves a payout wallet, and issues a scoped credential', async ({
  page,
  request,
}, info) => {
  const fixture = fixtures[info.project.name];
  const account = privateKeyToAccount(generatePrivateKey());
  await signIn(page, fixture);
  // The workspace shows an operator only the way into their own console.
  await expect(page.getByText('Project-wide materials are private.')).toBeVisible();
  await page.getByRole('link', { name: 'Open the operator console' }).click();
  await expect(page).toHaveURL('/operator');
  await expect(page.getByRole('heading', { name: 'Register an operator profile' })).toBeVisible();

  await page.getByLabel('Operator handle').fill(`agent-${info.project.name}`);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('heading', { name: 'Prove a payout wallet' })).toBeVisible();
  await expect(page.getByText('No wallet is proven for this operator yet.')).toBeVisible();

  await page.getByLabel('Wallet address').fill(account.address);
  await page.getByRole('button', { name: 'Request challenge' }).click();
  const message = await page.getByLabel('Message to sign').inputValue();
  expect(message).toContain(account.address);
  expect(message).toContain('Chain ID: 42220');
  expect(message).toContain('grants no spending authority');

  // The signature is produced outside the app, exactly as a wallet would.
  await page.getByLabel('Signature', { exact: true }).fill(await account.signMessage({ message }));
  await page.getByRole('button', { name: 'Submit proof' }).click();
  const walletRow = page.locator('.member-row', { hasText: account.address });
  await expect(walletRow).toContainText('payout');
  await expect(walletRow).toContainText('EOA');

  await page.getByLabel('Credential name').fill('Runner');
  await page.getByRole('button', { name: 'Create credential' }).click();
  const secret = await page.getByLabel('New credential secret').inputValue();
  expect(secret.length).toBeGreaterThan(30);
  await expect(page.locator('.member-row', { hasText: 'Runner' })).toContainText('active');
  await expect(page.getByText('shown once and is stored only as a digest')).toBeVisible();

  const auth = { Authorization: `Bearer ${secret}` };
  const identity = await request.get('/api/agent/v1/identity', { headers: auth });
  expect(identity.status()).toBe(200);
  const body = await identity.json();
  expect(body.operator.handle).toBe(`agent-${info.project.name}`);
  expect(body.wallets[0].address).toBe(account.address);
  expect(body.payoutSigning).toBe('never_delegated');
  expect(body.credential.scopes).toEqual(['operator:read', 'qualification:submit', 'work:read']);

  // Grading, idempotency, and the gates an agent is told about.
  for (const [task, report] of Object.entries(correctReports)) {
    const attempt = await request.post('/api/agent/v1/qualification/attempts', {
      headers: { ...auth, 'Idempotency-Key': `${info.project.name}-${task}` },
      data: { task, report },
    });
    expect(attempt.status()).toBe(201);
    expect((await attempt.json()).attempt.outcome).toBe('correct');
  }
  const replay = await request.post('/api/agent/v1/qualification/attempts', {
    headers: { ...auth, 'Idempotency-Key': `${info.project.name}-invite-alias-defect` },
    data: { task: 'invite-alias-defect', report: correctReports['invite-alias-defect'] },
  });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).replayed).toBe(true);
  const conflict = await request.post('/api/agent/v1/qualification/attempts', {
    headers: { ...auth, 'Idempotency-Key': `${info.project.name}-invite-alias-defect` },
    data: { task: 'invite-alias-repaired', report: correctReports['invite-alias-repaired'] },
  });
  expect(conflict.status()).toBe(409);
  expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_MISMATCH');

  const work = await request.get('/api/agent/v1/work', { headers: auth });
  expect(work.status()).toBe(200);
  const listing = await work.json();
  expect(listing.items).toEqual([]);
  expect(listing.eligibleServices).toEqual(['bug_discovery']);
  expect(listing.unavailable.map((entry: { code: string }) => entry.code)).toEqual([
    'PUBLICATION_UNAVAILABLE',
  ]);
  const assignments = await request.get('/api/agent/v1/assignments', { headers: auth });
  expect(assignments.status()).toBe(501);
  expect((await assignments.json()).error.code).toBe('ASSIGNMENTS_UNAVAILABLE');

  // The graded result is visible to the person behind the operator.
  await page.reload();
  await expect(
    page.locator('.audit-list li', { hasText: 'bug_discovery: eligible' }),
  ).toBeVisible();
  await expect(page.locator('.member-row', { hasText: 'invite-alias-defect v1' })).toContainText(
    'passed',
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('operator.png'), fullPage: true, scale: 'css' });

  // Revoking the credential ends the agent session immediately.
  await page
    .locator('.member-row', { hasText: 'Runner' })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(page.locator('.member-row', { hasText: 'Runner' })).toContainText('revoked');
  const refused = await request.get('/api/agent/v1/identity', { headers: auth });
  expect(refused.status()).toBe(401);
  expect((await refused.json()).error.code).toBe('CREDENTIAL_INVALID');
});

test('the agent API refuses cookies, missing credentials, and unknown routes', async ({
  request,
}) => {
  const anonymous = await request.get('/api/agent/v1/work');
  expect(anonymous.status()).toBe(401);
  expect((await anonymous.json()).error.code).toBe('CREDENTIAL_REQUIRED');
  const cookied = await request.get('/api/agent/v1/work', {
    headers: { Authorization: 'Bearer not-a-real-credential', Cookie: 'session=forged' },
  });
  expect(cookied.status()).toBe(401);
  expect((await cookied.json()).error.code).toBe('COOKIE_REJECTED');
  const unknown = await request.get('/api/agent/v1/payouts', {
    headers: { Authorization: 'Bearer not-a-real-credential' },
  });
  expect(unknown.status()).toBe(401);
  // The operator console itself stays behind a session.
  const console_ = await request.get('/api/v1/operator');
  expect(console_.status()).toBe(401);
});
