import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

type Fixture = {
  password: string;
  ownerEmail: string;
  workspaceId: string;
  projectId: string;
  joinToken: string;
  reviewerEmail: string;
  operatorEmail: string;
};
const fixtures = JSON.parse(readFileSync(process.env.TRIALOOM_E2E_FIXTURE ?? '', 'utf8')) as Record<
  string,
  Fixture
>;
async function signIn(page: Page, fixture: Fixture, email = fixture.ownerEmail) {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/workspace');
}
async function accessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((n) => n.target) })),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
}

test('private workspace redirects; sign-in page is accessible', async ({ page, request }, info) => {
  await page.goto('/workspace');
  await expect(page).toHaveURL('/sign-in');
  await accessible(page);
  await page.screenshot({ path: info.outputPath('sign-in.png'), fullPage: true, scale: 'css' });
  const response = await request.get('/api/v1/workspaces');
  expect(response.status()).toBe(401);
  expect(response.headers()['cache-control']).toBe('no-store');
});
test('one-time invitation creates an account and session; fragment is removed', async ({
  page,
}, info) => {
  const f = fixtures[info.project.name];
  await page.goto(`/join#token=${f.joinToken}`);
  await expect(page.getByText('Join Invited browser workspace as owner.')).toBeVisible();
  await expect(page).toHaveURL('/join');
  await page.getByLabel('Your name').fill('Invited builder');
  await page.getByLabel('Choose a password').fill(f.password);
  await page.getByRole('button', { name: 'Create account and join' }).click();
  await expect(page).toHaveURL('/workspace');
  await expect(page.getByText('Invited browser workspace', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL('/sign-in');
  await page.goto(`/join#token=${f.joinToken}`);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('no longer available');
});
test('builder creates a project, pins a build, saves terms, and preserves old versions', async ({
  page,
}, info) => {
  test.setTimeout(60000); // Complete setup/revision journey includes three accessibility scans.
  const f = fixtures[info.project.name];
  await signIn(page, f);
  await accessible(page);
  await page.screenshot({ path: info.outputPath('projects.png'), fullPage: true, scale: 'css' });
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Project name').fill('Browser verified project');
  await page.getByLabel('Preview URL', { exact: true }).fill('https://127.0.0.1');
  await page.getByLabel('I own this target').check();
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('private');
  await expect(page.getByLabel('Project name')).toHaveValue('Browser verified project');
  await page.getByLabel('Preview URL', { exact: true }).fill('https://example.com/');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Browser verified project', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Pin a build', exact: true }).click();
  await page.getByLabel('Revision or deployment ID').fill('immutable-commit-one');
  await page.getByLabel('Fixture version').fill('fixture-v1');
  await page.getByRole('button', { name: 'Save pinned build' }).click();
  await expect(page.getByText('immutable-commit-one', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New work brief' }).click();
  await page.getByLabel('Brief name').fill('Invite a teammate');
  await page
    .getByRole('textbox', { name: 'Scope', exact: true })
    .fill('Test the complete invitation journey.');
  await page.getByLabel('Permitted actions', { exact: true }).fill('Create a sandbox invitation');
  await page.getByLabel('Exclusions', { exact: true }).fill('Do not deliver real email');
  await page
    .getByLabel('Acceptance criteria', { exact: true })
    .fill('Provide replayable steps and assertions.');
  await page
    .getByLabel('Discovery reward rules', { exact: true })
    .fill('No separate discovery reward.');
  await page.getByLabel('Execution price (USDC)').fill('0.10');
  await page
    .getByLabel('Delivery deadline')
    .fill(new Date(Date.now() + 86400000).toISOString().slice(0, 16));
  await page
    .getByLabel('Artifact rights', { exact: true })
    .fill('Builder can retain and reuse reports and tests.');
  await page
    .getByLabel('Payment and resource terms')
    .fill('Accepted work remains owed. Authorization is not escrow. Platform covers payout gas.');
  // A brief can demand a witnessed run, which is the whole point of admitting
  // a runner host. It was reachable only by hand-crafted API call before.
  await page.getByLabel('Execution isolation').selectOption('witnessed');
  await page.getByLabel('I approve this scope').check();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath('terms-editor.png'),
    fullPage: true,
    scale: 'css',
  });
  await page.getByRole('button', { name: 'Save draft brief' }).click();
  await expect(page.getByText('Draft · v1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revise terms' }).click();
  await page
    .getByRole('textbox', { name: 'Scope', exact: true })
    .fill('Also exercise plus-address invitations.');
  await page.getByLabel('I approve this scope').check();
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByText('Draft · v2', { exact: true })).toBeVisible();
  await page.getByText('Version 1', { exact: false }).first().click();
  await expect(
    page.getByText('Test the complete invitation journey.', { exact: true }),
  ).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath('project-detail.png'),
    fullPage: true,
    scale: 'css',
  });
  await page.reload();
  await page.getByRole('button', { name: /Browser verified project/ }).click();
  await expect(page.getByText('Draft · v2', { exact: true })).toBeVisible();

  // Publishing the brief authorizes a ceiling and opens it to admitted operators.
  await page.getByRole('button', { name: 'Publish to operators' }).click();
  await page.getByLabel('Terms version to offer').selectOption({ index: 0 });
  await page.getByLabel('Assignment slots').fill('2');
  await page.getByLabel('Concurrent assignments').fill('2');
  await page.getByLabel('Authorize additional budget (USDC)').fill('5');
  await page.getByLabel('Spending authorization reference').fill('remesso-policy-browser-ui');
  await page.getByLabel('I authorize spending').check();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('open · v2', { exact: true })).toBeVisible();
  const ledger = page.locator('.campaign-ledger');
  await expect(ledger).toContainText('5.00 USDC');
  await expect(ledger).toContainText('0 of 2 taken');
  await expect(ledger).toContainText('replays to these balances');
  await expect(ledger).toContainText('No operator has claimed this work yet.');
  await accessible(page);
  await page.screenshot({
    path: info.outputPath('campaign-budget.png'),
    fullPage: true,
    scale: 'css',
  });
  // Pausing and cancelling stop new claims; neither erases the accounting.
  await page.getByRole('button', { name: 'Pause new claims' }).click();
  await expect(page.getByText('paused · v2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reopen for claims' }).click();
  await expect(page.getByText('open · v2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel campaign' }).click();
  await expect(page.getByText('cancelled · v2', { exact: true })).toBeVisible();
  await expect(ledger).toContainText('5.00 USDC');
});
test('owner can create and revoke an invitation and see access history', async ({ page }, info) => {
  const f = fixtures[info.project.name];
  await signIn(page, f);
  await page.getByRole('button', { name: 'Workspace access', exact: true }).click();
  await page
    .getByLabel('Email address', { exact: true })
    .fill(`${info.project.name}-collaborator@example.test`);
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  await expect(page.getByLabel('Private invitation link')).toHaveValue(/\/join#token=[a-f0-9]{64}/);
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByText('No pending invitations.')).toBeVisible();
  await accessible(page);
  await page.screenshot({ path: info.outputPath('access.png'), fullPage: true, scale: 'css' });
});
test('reviewer reads are allowed, writes denied; operators cannot read project materials', async ({
  page,
}, info) => {
  const f = fixtures[info.project.name];
  await signIn(page, f, f.reviewerEmail);
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /Seeded private project/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Seeded private project', exact: true }),
  ).toBeVisible();
  const rejected = await page.request.post(`/api/v1/workspaces/${f.workspaceId}/projects`, {
    headers: { Origin: 'http://127.0.0.1:3100' },
    data: {
      name: 'Not allowed',
      targetUrl: 'https://example.com',
      environment: 'preview',
      authorizationConfirmed: true,
    },
  });
  expect(rejected.status()).toBe(403);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, f, f.operatorEmail);
  await expect(page.getByRole('heading', { name: /Your work starts/ })).toBeVisible();
  expect(
    (
      await page.request.get(`/api/v1/workspaces/${f.workspaceId}/projects/${f.projectId}`)
    ).status(),
  ).toBe(403);
});
test('public signup, cross-origin mutations, oversized bodies, and excess attempts are refused', async ({
  request,
}, info) => {
  const f = fixtures[info.project.name];
  expect(
    (
      await request.post('/api/auth/sign-up/email', {
        headers: { Origin: 'http://127.0.0.1:3100' },
        data: { email: 'uninvited@example.test', password: f.password, name: 'No' },
      })
    ).status(),
  ).toBe(404);
  expect(
    (
      await request.post('/api/auth/sign-in/email', {
        headers: { Origin: 'https://evil.example' },
        data: { email: f.ownerEmail, password: f.password },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post('/api/v1/invitations/inspect', {
        headers: { Origin: 'http://127.0.0.1:3100' },
        data: { token: 'x'.repeat(40000) },
      })
    ).status(),
  ).toBe(413);
  const attempts = await Promise.all(
    Array.from({ length: 11 }, () =>
      request.post('/api/auth/sign-in/email', {
        headers: { Origin: 'http://127.0.0.1:3100' },
        data: { email: `${info.project.name}@`, password: f.password },
      }),
    ),
  );
  expect(attempts.filter((response) => response.status() === 429)).toHaveLength(1);
  expect(attempts.filter((response) => response.status() === 400)).toHaveLength(10);
});

test('an owner admits a runner host and can revoke it', async ({ page }, info) => {
  const fixture = fixtures[info.project.name];
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Workspace access' }).click();
  const hosts = page.locator('.live-section', { hasText: 'Runner hosts' });
  await expect(hosts).toContainText('runner-host-v1');
  // Admitting a host is a declaration, and the panel says so.
  await expect(hosts).toContainText('Trialoom does not run these hosts');
  await expect(hosts).toContainText('every run is attested only');

  await hosts.getByRole('button', { name: 'Register a host' }).click();
  await page.getByLabel('Host name').fill('Sandboxed runner');
  // The contract is readable before accepting it, including what it does not
  // promise.
  await page.getByText('The contract this host accepts').click();
  await expect(hosts).toContainText('Still only asserted');
  await page.getByLabel('I have read the contract').check();
  await hosts.getByRole('button', { name: 'Register host' }).click();

  // The credential is shown once, and the host appears with what it provides.
  const credential = await page.getByLabel('New host credential').inputValue();
  expect(credential).toMatch(/^trh_/);
  await expect(hosts).toContainText('Shown once and stored only as a digest');
  const row = hosts.locator('.member-row', { hasText: 'Sandboxed runner' });
  await expect(row).toContainText('witnessed');
  await expect(row).toContainText('sandbox gvisor');
  await expect(row).toContainText('egress enforced');
  await expect(row).toContainText('never used');

  // A host that claims the witnessed level without implementing it is refused.
  await hosts.getByRole('button', { name: 'Register a host' }).click();
  await page.getByLabel('Host name').fill('Unenforced runner');
  await page.getByLabel('An egress proxy is the only network path').uncheck();
  await page.getByLabel('I have read the contract').check();
  await hosts.getByRole('button', { name: 'Register host' }).click();
  await expect(hosts).toContainText('must declare a sandbox');

  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(row).toContainText('revoked');
});
