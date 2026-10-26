import { test, openCleanJourney, invite, expect } from './harness.mjs';

for (const replay of [1, 2]) {
  test(`baseline reproduction ${replay}`, async ({ page, app, journal }) => {
    await openCleanJourney(page, app, journal);
    await invite(page, 'teammate@example.test', 201, 201, journal);
    await invite(page, 'teammate+qa@example.test', 201, 400, journal);
    await expect(page.getByRole('list', { name: 'Invitations' }).getByRole('listitem')).toHaveCount(1);
  });
}
