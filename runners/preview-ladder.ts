import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Page, Response } from 'playwright-core';

/** Fixed public-data journey: no login, identity editor or game action. */
export async function readLadder(page: Page, read: Promise<Response | null>) {
  await page.getByRole('button', { name: 'LEADERBOARD', exact: true }).click();
  await page.getByRole('button', { name: 'THE LADDER', exact: true }).last().click();
  await page.getByText('WHO IS WHERE', { exact: true }).waitFor();
  const response = await read;
  assert(
    response?.status() === 200 && response.headers()['x-trialoom-proxy-denied'] !== '1',
    'LADDER_READ_BLOCKED',
  );
  const bytes = await response.body();
  assert(bytes.length <= 512 * 1024, 'LADDER_RESPONSE_TOO_LARGE');
  const data = JSON.parse(bytes.toString('utf8'));
  assert(Array.isArray(data.players) && data.players.length <= 25, 'LADDER_SHAPE_INVALID');
  const count: number = data.players.length;
  await page.waitForFunction((expected) => {
    // biome-ignore lint/performance/useDomNodeTextContent: compare rendered count, excluding hidden content.
    const text = document.body.innerText.replace(/\s+/g, ' ');
    return new RegExp(`\\b${expected}\\s+CLASSIC PLAYERS\\b`).test(text);
  }, count);
  return { count, sha256: createHash('sha256').update(bytes).digest('hex') };
}
