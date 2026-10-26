import { test, openCleanJourney, invite, expect } from './harness.mjs';

// This exact specification is executed unchanged on baseline and candidate.
// Do not mark baseline failures as expected: the verifier checks a real exit 1.
for (const replay of [1, 2]) {
  test(`plus-address regression ${replay}`, async ({ page, app, journal }) => {
    await openCleanJourney(page, app, journal);
    await invite(page, 'teammate@example.test', 201, 201, journal);
    await invite(page, 'teammate+qa@example.test', 201, 201, journal);
    await expect(page.getByRole('list', { name: 'Invitations' }).getByRole('listitem')).toHaveCount(2);
  });
}
