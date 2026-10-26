import { test as base, expect } from '@playwright/test';
import { startFixture, fixtureId, fixtureRoot, canaries } from '../fixture.mjs';

export const test = base.extend({
  journal: async ({}, use, testInfo) => {
    const journal = {
      schemaVersion: 1, fixtureId, campaignId: 'local-capability-demo',
      assignmentId: testInfo.title, termsVersion: 'fixture-terms-v1',
      actor: 'local-test-harness', independentOperator: false,
      startedAt: new Date().toISOString(), steps: [], assertions: [],
    };
    await use(journal);
    journal.finishedAt = new Date().toISOString();
    await testInfo.attach('evidence.json', { body: JSON.stringify(journal, null, 2), contentType: 'application/json' });
  },
  app: async ({ context, journal }, use) => {
    const fixture = await startFixture(process.env.TRIALOOM_FIXTURE_ROOT || fixtureRoot);
    journal.build = fixture.build;
    journal.environment = { browser: 'chromium', version: context.browser().version(), viewport: { width: 1280, height: 800 }, locale: 'en-US', timezone: 'UTC' };
    await context.setExtraHTTPHeaders({ 'x-fixture-token': canaries[0] });
    await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort('blockedbyclient'));
    try { await use(fixture); } finally { await fixture.close(); }
  },
});
export { expect };

export async function openCleanJourney(page, app, journal) {
  await test.step('Open the pinned build with clean browser and server state', async () => {
    await page.goto(app.origin);
    await expect(page.locator('#owner')).toHaveText(canaries[1]);
    const meta = await page.evaluate(() => fetch('/api/meta').then(response => response.json()));
    expect(meta.buildId).toBe(app.build.id);
    expect(meta.invitationCount).toBe(0);
    expect(await page.context().cookies()).toEqual([]);
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    journal.steps.push({ action: 'open', buildId: meta.buildId, cleanSession: true, invitationCount: meta.invitationCount });
    // A later test's context must not inherit this marker.
    await page.evaluate(() => localStorage.setItem('previous-run', 'seeded'));
  });
}

export async function invite(page, email, desiredStatus, observedStatus, journal) {
  await test.step(`Invite ${email}`, async () => {
    await page.getByLabel('Teammate email').fill(email);
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/invitations') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send invitation' }).click();
    const response = await responsePromise;
    const body = await response.json();
    await expect(page.getByRole('status')).toHaveAttribute('data-outcome', response.ok() ? 'invited' : 'rejected');
    journal.steps.push({ action: 'submit invitation', email, actualStatus: response.status(), actualMessage: body.message });
    journal.assertions.push({ name: `Invitation response for ${email}`, expected: desiredStatus, actual: response.status(), passed: response.status() === desiredStatus });
    expect(response.status()).toBe(observedStatus);
    return body;
  });
}
