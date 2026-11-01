import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Page, Response } from 'playwright-core';

export function ladderResponse(bytes: Buffer) {
  assert(bytes.length <= 512 * 1024, 'LADDER_RESPONSE_TOO_LARGE');
  const data = JSON.parse(bytes.toString('utf8'));
  assert(
    data &&
      Array.isArray(data.standings) &&
      data.standings.length <= 25 &&
      Number.isSafeInteger(data.players) &&
      data.players >= data.standings.length,
    'LADDER_SHAPE_INVALID',
  );
  return {
    count: data.players as number,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

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
  const result = ladderResponse(await response.body());
  await page.getByText(`${result.count} CLIMBING`, { exact: true }).waitFor();
  return result;
}
