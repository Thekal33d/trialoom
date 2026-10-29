import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

type Fixture = {
  password: string;
  evidenceOwnerEmail: string;
  evidenceReviewerEmail: string;
  evidenceWorkspaceId: string;
  evidenceProjectId: string;
  evidenceBuildId: string;
  evidenceCampaignId: string;
  evidenceTermsVersionId: string;
  evidenceTermsContentHash: string;
  submittedRunId: string;
  submittedAssignmentId: string;
  submittedCredential: string;
  submitterHandle: string;
  liveRunId: string;
  liveRunToken: string;
  liveAssignmentId: string;
  liveCredential: string;
  repairCampaignId: string;
  repairAuthorHandle: string;
  repairVerifierHandle: string;
  repairAuthorAssignmentId: string;
  repairVerifierAssignmentId: string;
  liveAttemptToken: string;
  resourceCampaignId: string;
  resourceRunId: string;
  resourceCredential: string;
  hostId: string;
  hostCredential: string;
  witnessedRunId: string;
  witnessedRunToken: string;
  witnessedCredential: string;
  reconciledPurchaseId: string;
  uncertainPurchaseId: string;
};
const fixtures = JSON.parse(readFileSync(process.env.TRIALOOM_E2E_FIXTURE ?? '', 'utf8')) as Record<
  string,
  Fixture
>;
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const leakedCredential = 'authorization: Bearer abcdefghijklmnopqrstuvwxyz012345';
const archive = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0xff, 0xfe]),
  Buffer.from('browser-check-trace'),
]);
async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('/workspace');
}
const campaignBase = (fixture: Fixture) =>
  `/api/v1/workspaces/${fixture.evidenceWorkspaceId}/projects/${fixture.evidenceProjectId}/campaigns/${fixture.evidenceCampaignId}`;

test.describe.configure({ mode: 'serial' });

test('a builder reads redacted evidence and sees that nothing has been decided', async ({
  page,
  browser,
}, info) => {
  const fixture = fixtures[info.project.name];
  await signIn(page, fixture.evidenceOwnerEmail, fixture.password);
  await page.getByRole('button', { name: /Evidence fixture project/ }).click();
  const brief = page.locator('.brief-record', { hasText: 'Evidence fixture campaign' });
  await expect(brief).toContainText('Execution and evidence');
  await expect(brief).toContainText('Reported a product failure');
  await expect(brief).toContainText('Pending review');
  await expect(brief).toContainText('run submitted');
  await expect(brief).toContainText('revision confirmed');
  // Both claims still reserve their maximum liability: nothing has been paid.
  await expect(brief).toContainText('7.60 USDC');
  await expect(brief).toContainText('owed and queued for payment');
  await expect(brief).toContainText('This policy cannot redact archived or binary evidence.');
  await expect(brief.getByRole('link', { name: 'Open redacted copy' })).toHaveCount(2);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('evidence.png'), fullPage: true, scale: 'css' });

  const listed = await (await page.request.get(`${campaignBase(fixture)}/submissions`)).json();
  expect(listed.submissions).toHaveLength(1);
  const artifacts = listed.submissions[0].artifacts as {
    id: string;
    name: string;
    kind: string;
    reviewable: boolean;
  }[];
  const report = artifacts.find((artifact) => artifact.name === 'report.json');
  const trace = artifacts.find((artifact) => artifact.kind === 'trace');
  const served = await page.request.get(`${campaignBase(fixture)}/artifacts/${report?.id}`);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-disposition']).toContain('redacted-report.json');
  expect(served.headers()['x-trialoom-redaction']).toBe('text-secrets-v1');
  const body = await served.text();
  // What a reader gets is the redacted copy, never the stored bytes.
  expect(body).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  expect(body).not.toContain('teammate+qa@example.test');
  expect(body).toContain('[REDACTED:');
  const refused = await page.request.get(`${campaignBase(fixture)}/artifacts/${trace?.id}`);
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.code).toBe('ARTIFACT_PRIVATE');

  // A reviewer reads the same redacted evidence; the read is recorded.
  const reviewerContext = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' });
  const reviewerPage = await reviewerContext.newPage();
  await signIn(reviewerPage, fixture.evidenceReviewerEmail, fixture.password);
  expect((await reviewerPage.request.get(`${campaignBase(fixture)}/submissions`)).status()).toBe(
    200,
  );
  expect(
    (await reviewerPage.request.get(`${campaignBase(fixture)}/artifacts/${report?.id}`)).status(),
  ).toBe(200);
  await reviewerContext.close();
});

test('a run grant reaches only its own run, and evidence is ingested once', async ({
  request,
}, info) => {
  const fixture = fixtures[info.project.name];
  const grant = { Authorization: `Bearer ${fixture.liveRunToken}` };
  const agent = { Authorization: `Bearer ${fixture.liveCredential}` };
  const runBase = `/api/agent/v1/runs/${fixture.liveRunId}`;

  const view = await request.get(runBase, { headers: grant });
  expect(view.status()).toBe(200);
  const manifest = (await view.json()).manifest;
  expect(manifest.payoutSigning).toBe('never_delegated');
  expect(manifest.grant.scope).toBe('evidence:submit');
  expect(manifest.egressAllowlist).toEqual(['https://example.com']);
  expect(manifest.isolation).toEqual({
    freshBrowserContext: true,
    ephemeralProfile: true,
    clearedStorage: true,
  });

  // The long-lived agent credential cannot reach a run route.
  const asAgent = await request.get(runBase, { headers: agent });
  expect(asAgent.status()).toBe(401);
  expect((await asAgent.json()).error.code).toBe('RUN_GRANT_INVALID');
  // The run grant cannot reach anything else, including another run.
  const work = await request.get('/api/agent/v1/work', { headers: grant });
  expect(work.status()).toBe(401);
  const other = await request.get(`/api/agent/v1/runs/${fixture.submittedRunId}`, {
    headers: grant,
  });
  expect(other.status()).toBe(403);
  expect((await other.json()).error.code).toBe('RUN_MISMATCH');

  const log = Buffer.from(`${leakedCredential}\nstep 1 complete`);
  const corrupt = await request.post(
    `${runBase}/artifacts?name=run.log&kind=log&sha256=${'0'.repeat(64)}`,
    { headers: { ...grant, 'Content-Type': 'text/plain' }, data: log },
  );
  expect(corrupt.status()).toBe(400);
  expect((await corrupt.json()).error.code).toBe('ARTIFACT_CORRUPT');
  const wrongType = await request.post(
    `${runBase}/artifacts?name=run.log&kind=log&sha256=${sha256(log)}`,
    { headers: { ...grant, 'Content-Type': 'application/json' }, data: log },
  );
  expect(wrongType.status()).toBe(415);
  expect((await wrongType.json()).error.code).toBe('MEDIA_TYPE_REJECTED');

  const stored = await request.post(
    `${runBase}/artifacts?name=run.log&kind=log&sha256=${sha256(log)}`,
    { headers: { ...grant, 'Content-Type': 'text/plain' }, data: log },
  );
  expect(stored.status()).toBe(201);
  const storedBody = await stored.json();
  expect(storedBody.reviewable).toBe(true);
  expect(storedBody.redaction.findings.authorization_header).toBe(1);
  const assertions = Buffer.from('{"invitationAccepted":false}');
  expect(
    (
      await request.post(
        `${runBase}/artifacts?name=assertions.json&kind=assertions&sha256=${sha256(assertions)}`,
        { headers: { ...grant, 'Content-Type': 'application/json' }, data: assertions },
      )
    ).status(),
  ).toBe(201);
  const traceUpload = await request.post(
    `${runBase}/artifacts?name=replay.trace.zip&kind=trace&sha256=${sha256(archive)}`,
    { headers: { ...grant, 'Content-Type': 'application/zip' }, data: archive },
  );
  expect(traceUpload.status()).toBe(201);
  // An archive cannot be cleaned by the text policy, so it stays private.
  expect((await traceUpload.json()).reviewable).toBe(false);

  const now = new Date().toISOString();
  const document = {
    schemaVersion: 1,
    campaignId: fixture.evidenceCampaignId,
    assignmentId: fixture.liveAssignmentId,
    termsVersionId: fixture.evidenceTermsVersionId,
    termsContentHash: fixture.evidenceTermsContentHash,
    build: {
      id: fixture.evidenceBuildId,
      revision: 'baseline-1',
      fixtureVersion: 'invitation-1',
      targetUrl: 'https://example.com/',
    },
    environment: 'preview',
    agent: {
      runtime: 'node 24',
      browser: 'chromium 141',
      viewport: '1280x800',
      configurationHash: 'b'.repeat(64),
    },
    isolation: { freshBrowserContext: true, ephemeralProfile: true, clearedStorage: true },
    startedAt: now,
    finishedAt: now,
    observedOrigins: ['https://example.com'],
    steps: [
      {
        index: 1,
        action: 'Invite teammate+qa@example.test',
        expected: 'Invitation created',
        actual: 'Rejected with 400',
        status: 'failed',
      },
    ],
    assertions: [
      { name: 'invitation.create', passed: false, detail: 'Expected 201, observed 400' },
    ],
    outcome: 'product_failed',
    summary: 'The seeded validator rejects a plus alias on the pinned build.',
    artifacts: [
      { name: 'run.log', sha256: sha256(log) },
      { name: 'assertions.json', sha256: sha256(assertions) },
      { name: 'replay.trace.zip', sha256: sha256(archive) },
    ],
  };
  const mismatched = await request.post(`${runBase}/evidence`, {
    headers: grant,
    data: { ...document, build: { ...document.build, revision: 'baseline-2' } },
  });
  expect(mismatched.status()).toBe(409);
  expect((await mismatched.json()).error.code).toBe('BUILD_MISMATCH');
  const offOrigin = await request.post(`${runBase}/evidence`, {
    headers: grant,
    data: { ...document, observedOrigins: ['https://example.com', 'https://cdn.example.net'] },
  });
  expect(offOrigin.status()).toBe(409);
  expect((await offOrigin.json()).error.code).toBe('EGRESS_VIOLATION');

  const submitted = await request.post(`${runBase}/evidence`, { headers: grant, data: document });
  expect(submitted.status()).toBe(201);
  const receipt = await submitted.json();
  expect(receipt.decision).toBe('pending_review');
  expect(receipt.artifactCount).toBe(3);
  // The grant dies with its run; the same evidence cannot arrive twice.
  const replayed = await request.post(`${runBase}/evidence`, { headers: grant, data: document });
  expect(replayed.status()).toBe(409);
  expect((await replayed.json()).error.code).toBe('RUN_CLOSED');
});

test('a builder records decisions that pay for the work and the reward', async ({ page }, info) => {
  const fixture = fixtures[info.project.name];
  await signIn(page, fixture.evidenceOwnerEmail, fixture.password);
  await page.getByRole('button', { name: /Evidence fixture project/ }).click();
  const brief = page.locator('.brief-record', { hasText: 'Evidence fixture campaign' });
  const review = brief.locator('.review-block');
  await expect(review).toContainText('Reports and decisions');
  // Two independent operators reported the same failure on the same build.
  await expect(review).toContainText('confirmed');
  await expect(review).toContainText('2 reports');
  await expect(review).toContainText('2 independent');
  await expect(review).toContainText('Clustering is deterministic and decides nothing');

  const pending = review.locator('.editor-panel', {
    hasText: `${fixture.submitterHandle} · execution not decided`,
  });
  await pending.getByLabel('Outcome').selectOption('accepted');
  await pending
    .getByLabel('Reason, against the pinned acceptance criteria')
    .fill('Every assigned step ran and the trace replays.');
  await pending.getByRole('button', { name: 'Record decision' }).click();
  await expect(review.locator('.decision-trail')).toContainText('execution accepted');
  await expect(review.locator('.decision-trail')).toContainText('2.00 USDC');
  await expect(review.locator('.decision-trail')).toContainText(
    'Criteria applied: Reports must replay from the exported trace',
  );
  // Accepting the work moved exactly its price and fee out of the reservation.
  await expect(brief).toContainText('2.20 USDC');

  const finding = review
    .locator('.editor-panel', { hasText: `@${fixture.submitterHandle}` })
    .first();
  await finding.getByRole('button', { name: 'Discovery decision' }).click();
  await finding.getByLabel('Outcome').selectOption('awarded');
  await finding.getByLabel('Reward (USDC, up to the published cap)').fill('1');
  await finding
    .getByLabel('Reason, against the published rubric')
    .fill('First complete report of a confirmed in-scope defect.')
    .catch(() => undefined);
  await finding.getByRole('button', { name: 'Record decision' }).click();
  await expect(review.locator('.decision-trail')).toContainText('discovery awarded');
  await expect(review.locator('.decision-trail')).toContainText('1.00 USDC');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('review.png'), fullPage: true, scale: 'css' });
});

test('an operator reads the decisions on their work and cannot appeal an acceptance', async ({
  request,
}, info) => {
  const fixture = fixtures[info.project.name];
  const auth = { Authorization: `Bearer ${fixture.submittedCredential}` };
  const read = await request.get('/api/agent/v1/decisions', { headers: auth });
  expect(read.status()).toBe(200);
  const body = await read.json();
  expect(body.appealWindowHours).toBe(168);
  const execution = body.decisions.find(
    (decision: { matter: string }) => decision.matter === 'execution',
  );
  expect(execution.outcome).toBe('accepted');
  expect(execution.amount_units).toBe('2000000');
  expect(execution.criteria).toBe('Reports must replay from the exported trace');
  const refused = await request.post(
    `/api/agent/v1/assignments/${fixture.submittedAssignmentId}/appeal`,
    { headers: auth, data: { subject: 'execution', reason: 'Appealing an acceptance.' } },
  );
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.code).toBe('NOT_REFUSED');
});

test('an accepted decision shows as an owed payment, blocked until a payout wallet exists', async ({
  page,
  request,
}, info) => {
  const fixture = fixtures[info.project.name];
  await signIn(page, fixture.evidenceOwnerEmail, fixture.password);
  await page.getByRole('button', { name: /Evidence fixture project/ }).click();
  const payments = page
    .locator('.brief-record', { hasText: 'Evidence fixture campaign' })
    .locator('.payout-block');
  await expect(payments).toContainText('Payments');
  await expect(payments).toContainText('paid only after finalized verification');
  // The work is accepted and owed; no recipient can be fixed yet.
  await expect(payments).toContainText('2.00 USDC');
  await expect(payments).toContainText('no recipient fixed yet');
  await expect(payments).toContainText('no payout wallet');
  // The platform fee is its own transfer, waiting on its own recipient.
  await expect(payments).toContainText('Platform fee');
  await expect(payments).toContainText('fee recipient unconfigured');

  const listed = await (await page.request.get(`${campaignBase(fixture)}/payouts`)).json();
  const execution = listed.payouts.find(
    (payout: { category: string }) => payout.category === 'execution',
  );
  expect(execution.state).toBe('blocked');
  expect(execution.transaction_hash).toBe(null);
  expect(execution.operation_key).toMatch(/^trp_[a-f0-9]{48}$/);

  // The operator sees the same block over the agent API.
  const payouts = await request.get('/api/agent/v1/payouts', {
    headers: { Authorization: `Bearer ${fixture.submittedCredential}` },
  });
  expect(payouts.status()).toBe(200);
  const body = await payouts.json();
  expect(body.currency.address).toBe('0xcebA9300f2b948710d2653dD7B07f33A8B32118C');
  expect(body.payouts.every((payout: { state: string }) => payout.state === 'blocked')).toBe(true);
  expect(body.payouts[0].blocked_reason).toBe('no_payout_wallet');
  expect(body.note).toContain('finalized verification');
});

test('a repair is shown as delivered for review and is payable only once confirmed', async ({
  page,
}, info) => {
  const fixture = fixtures[info.project.name];
  await signIn(page, fixture.evidenceOwnerEmail, fixture.password);
  await page.getByRole('button', { name: /Evidence fixture project/ }).click();
  const brief = page.locator('.brief-record', { hasText: 'Repair the invitation validator' });
  await expect(brief).toContainText('Trialoom never merges or deploys it');
  // The quote the owner approved, and what it bought.
  await expect(brief).toContainText(`@${fixture.repairAuthorHandle}`);
  await expect(brief).toContainText('2.00 USDC');
  await expect(brief).toContainText('approved');
  await expect(brief).toContainText('src/invitations');
  await expect(brief).toContainText('Independently confirmed');
  // The gate the delivery passed is stated, not just asserted.
  await expect(brief).toContainText('delivered a patch');
  await expect(brief).toContainText('baseline-1');
  await expect(brief).toContainText('candidate-2');
  await expect(brief).toContainText('invitation.expiry failed on every clean replay of baseline-1');
  await expect(brief).toContainText('1 independent confirmation; this repair can be accepted.');
  await expect(brief).toContainText(`@${fixture.repairVerifierHandle}`);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  const repairBase = `/api/v1/workspaces/${fixture.evidenceWorkspaceId}/projects/${fixture.evidenceProjectId}/campaigns/${fixture.repairCampaignId}`;
  const record = await (await page.request.get(`${repairBase}/repairs`)).json();
  expect(record.quote.state).toBe('approved');
  expect(record.repair.gate_state).toBe('passed');
  expect(record.verifications).toHaveLength(1);
  expect(record.verifications[0].outcome).toBe('confirmed');

  // The published price buys the repair, not a verification of it.
  const accept = {
    outcome: 'accepted',
    reason: 'The regression replays cleanly on both revisions.',
    evidenceRefs: [],
  };
  const origin = { Origin: 'http://127.0.0.1:3100' };
  const unpriced = await page.request.post(
    `${repairBase}/assignments/${fixture.repairVerifierAssignmentId}/execution`,
    { headers: origin, data: accept },
  );
  expect(unpriced.status()).toBe(409);
  expect((await unpriced.json()).error.code).toBe('VERIFICATION_PRICE_REQUIRED');
  const priced = await page.request.post(
    `${repairBase}/assignments/${fixture.repairVerifierAssignmentId}/execution`,
    { headers: origin, data: { ...accept, amountUnits: '400000' } },
  );
  expect(priced.status()).toBe(201);
  expect((await priced.json()).repairPosition).toBe('verifier');

  const paid = await page.request.post(
    `${repairBase}/assignments/${fixture.repairAuthorAssignmentId}/execution`,
    { headers: origin, data: accept },
  );
  expect(paid.status()).toBe(201);
  expect((await paid.json()).repairPosition).toBe('author');
  await page.reload();
  await page.getByRole('button', { name: /Evidence fixture project/ }).click();
  await expect(
    page.locator('.brief-record', { hasText: 'Repair the invitation validator' }),
  ).toContainText('Accepted and owed');
});

test('a resource is shown at its eligible cost, and a run grant cannot buy one', async ({
  page,
  request,
}, info) => {
  const fixture = fixtures[info.project.name];
  await signIn(page, fixture.evidenceOwnerEmail, fixture.password);
  await page.getByRole('button', { name: /Evidence fixture project/ }).click();
  const brief = page.locator('.brief-record', { hasText: 'Resource fixture campaign' });
  // The outer evidence block also carries this class, so the panel's own
  // section is named rather than filtered out of the pair.
  const resources = brief.locator('section.evidence-block', { hasText: 'Resources' });
  await expect(resources).toContainText('reimburses the eligible actual cost');
  // One reconciled purchase: authorized well above what it actually cost.
  await expect(resources).toContainText('browser.session');
  await expect(resources).toContainText('Authorized up to 0.01 USDC');
  await expect(resources).toContainText('cost 0.003606 USDC');
  await expect(resources).toContainText('reimbursable by you');
  await expect(resources).toContainText('Reconciled');
  // One whose settlement is unresolved: nothing recorded, reservation held.
  await expect(resources).toContainText('vm.micro');
  await expect(resources).toContainText('no cost recorded');
  await expect(resources).toContainText('charge undecided, reservation held');
  await expect(resources).toContainText('Settlement uncertain');

  const resourceBase = `/api/v1/workspaces/${fixture.evidenceWorkspaceId}/projects/${fixture.evidenceProjectId}/campaigns/${fixture.resourceCampaignId}`;
  const listed = await (await page.request.get(`${resourceBase}/resources`)).json();
  const reconciled = listed.purchases.find(
    (purchase: { id: string }) => purchase.id === fixture.reconciledPurchaseId,
  );
  expect(reconciled.charge).toBe('builder');
  expect(reconciled.cost_units).toBe('3606');
  expect(reconciled.intent_key).toMatch(/^trr_[a-f0-9]{48}$/);
  const uncertain = listed.purchases.find(
    (purchase: { id: string }) => purchase.id === fixture.uncertainPurchaseId,
  );
  expect(uncertain.charge).toBe('pending');
  expect(uncertain.cost_units).toBe(null);

  // The reimbursement is owed to the platform resource wallet, which is not
  // configured, and it answers to a purchase rather than to a decision.
  const payouts = await (await page.request.get(`${resourceBase}/payouts`)).json();
  const reimbursement = payouts.payouts.find(
    (payout: { kind: string }) => payout.kind === 'resource',
  );
  expect(reimbursement.amount_units).toBe('3606');
  expect(reimbursement.state).toBe('blocked');
  expect(reimbursement.blocked_reason).toBe('resource_recipient_unconfigured');

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  // A run grant travels with the runner, so it must not be able to spend. The
  // route is not on its allowlist at all.
  const purchase = await request.post(`/api/agent/v1/runs/${fixture.resourceRunId}/resources`, {
    headers: { Authorization: `Bearer ${fixture.liveRunToken}` },
    data: {
      attemptToken: fixture.liveAttemptToken,
      provider: 'buy',
      sku: 'browser.session',
      request: {},
      maxAmountUnits: '1000',
    },
  });
  // The route is not on the grant's allowlist, so the grant is not even read as
  // a grant there: it is rejected as an agent credential, which it is not.
  expect(purchase.status()).toBe(401);
  expect((await purchase.json()).error.code).toBe('CREDENTIAL_INVALID');
  // The operator's own credential does reach it.
  const asAgent = await request.get(`/api/agent/v1/runs/${fixture.resourceRunId}/resources`, {
    headers: { Authorization: `Bearer ${fixture.resourceCredential}` },
  });
  expect(asAgent.status()).toBe(200);
  const own = await asAgent.json();
  expect(own.purchases).toHaveLength(2);
  expect(own.currency.address).toBe('0xcebA9300f2b948710d2653dD7B07f33A8B32118C');
});

test('a builder exports the brief as a file and the queue names what is waiting', async ({
  page,
}, info) => {
  const fixture = fixtures[info.project.name];
  await signIn(page, fixture.evidenceOwnerEmail, fixture.password);

  // The queue is one place that answers what is waiting and on whom.
  await page.getByRole('button', { name: /What's waiting/ }).click();
  const queue = page.locator('.attention-panel');
  await expect(queue).toContainText('Work state and money state are separate');
  await expect(queue).toContainText('Evidence fixture campaign');
  await expect(queue).toContainText('awaiting your decision');
  await expect(queue).toContainText('blocked and still owed');
  await expect(queue).toContainText('holding a reservation');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('queue.png'), fullPage: true, scale: 'css' });

  const served = await page.request.get(`${campaignBase(fixture)}/export`);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toBe('application/zip');
  expect(served.headers()['content-disposition']).toContain('.zip');
  expect(served.headers()['x-trialoom-redaction']).toBe('text-secrets-v1');
  const files = unzipSync(new Uint8Array(await served.body()));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.redaction.rawBytesIncluded).toBe(false);
  expect(served.headers()['x-trialoom-export-hash']).toBe(manifest.contentHash);
  // The replay instructions carry what the claim pinned.
  const replay = JSON.parse(strFromU8(files['replay.json'])).replays[0];
  expect(replay.build.revision).toBe('baseline-1');
  expect(replay.isolation).toEqual({
    freshBrowserContext: true,
    ephemeralProfile: true,
    clearedStorage: true,
  });
  // Nothing in the whole export carries the secret the seeded report leaked,
  // and the archive it could not clean is named instead of included.
  const everything = Object.values(files)
    .map((bytes) => strFromU8(bytes))
    .join('\n');
  expect(everything).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  const withheld = JSON.parse(strFromU8(files['withheld.json']));
  expect(withheld.artifacts.map((artifact: { name: string }) => artifact.name)).toContain(
    'replay.trace.zip',
  );
  expect(Object.keys(files)).not.toContain('artifacts/replay.trace.zip');
  expect(Object.keys(files)).toContain('artifacts/report.json');

  // A reviewer reads the same queue, and cannot take a copy of the record.
  const reviewerContext = await page.context().browser()?.newContext({
    baseURL: 'http://127.0.0.1:3100',
  });
  if (!reviewerContext) throw new Error('No browser context for the reviewer.');
  const reviewerPage = await reviewerContext.newPage();
  await signIn(reviewerPage, fixture.evidenceReviewerEmail, fixture.password);
  await reviewerPage.getByRole('button', { name: /Review queue/ }).click();
  await expect(reviewerPage.locator('.attention-panel')).toContainText('Review queue');
  const refused = await reviewerPage.request.get(`${campaignBase(fixture)}/export`);
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.code).toBe('ACCESS_DENIED');
  await reviewerContext.close();
});

test('the egress witness is the host, and no agent credential can speak for it', async ({
  request,
}, info) => {
  const fixture = fixtures[info.project.name];
  const asHost = { Authorization: `Bearer ${fixture.hostCredential}` };
  const runBase = `/api/host/v1/runs/${fixture.witnessedRunId}`;

  // The contract a host accepts is public: a runner reads it before registering.
  const contract = await request.get('/api/host/v1/contract');
  expect(contract.status()).toBe(200);
  const published = (await contract.json()).contract;
  expect(published.version).toBe('runner-host-v1');
  expect(published.requirements.length).toBeGreaterThanOrEqual(6);
  // What stays an assertion is named rather than quietly implied.
  expect(published.stillAttested.length).toBeGreaterThanOrEqual(1);

  // The host reads the allowlist its proxy must enforce from Trialoom, not from
  // the runner it is supposed to be constraining.
  const view = await request.get(runBase, { headers: asHost });
  expect(view.status()).toBe(200);
  const run = await view.json();
  expect(run.isolationLevel).toBe('witnessed');
  expect(run.egressAllowlist).toEqual(['https://example.com']);

  const now = new Date().toISOString();
  const reported = await request.post(`${runBase}/egress`, {
    headers: asHost,
    data: {
      batch: 1,
      observations: [
        {
          origin: 'https://example.com',
          decision: 'allowed',
          requests: 4,
          firstSeenAt: now,
          lastSeenAt: now,
        },
        {
          origin: 'https://exfil.example.net',
          decision: 'denied',
          requests: 2,
          firstSeenAt: now,
          lastSeenAt: now,
        },
      ],
    },
  });
  expect(reported.status()).toBe(201);
  expect((await reported.json()).recorded).toBe(2);

  // A proxy that reports allowing what the manifest forbids is not enforcing it.
  const leak = await request.post(`${runBase}/egress`, {
    headers: asHost,
    data: {
      batch: 2,
      observations: [
        {
          origin: 'https://exfil.example.net',
          decision: 'allowed',
          requests: 1,
          firstSeenAt: now,
          lastSeenAt: now,
        },
      ],
    },
  });
  expect(leak.status()).toBe(409);
  expect((await leak.json()).error.code).toBe('EGRESS_NOT_ENFORCED');

  // The point of the separate credential: an agent taken over inside the
  // sandbox cannot write its own alibi. Neither the run grant it holds nor the
  // operator's own credential is a host.
  for (const token of [fixture.witnessedRunToken, fixture.witnessedCredential]) {
    const forged = await request.post(`${runBase}/egress`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        batch: 3,
        observations: [
          {
            origin: 'https://example.com',
            decision: 'allowed',
            requests: 1,
            firstSeenAt: now,
            lastSeenAt: now,
          },
        ],
      },
    });
    expect(forged.status()).toBe(401);
    expect((await forged.json()).error.code).toBe('HOST_CREDENTIAL_INVALID');
    expect(
      (await request.get(runBase, { headers: { Authorization: `Bearer ${token}` } })).status(),
    ).toBe(401);
  }
  // And the host credential reaches nothing on the agent API.
  const asAgent = await request.get(`/api/agent/v1/runs/${fixture.witnessedRunId}`, {
    headers: asHost,
  });
  expect(asAgent.status()).toBe(401);
});
