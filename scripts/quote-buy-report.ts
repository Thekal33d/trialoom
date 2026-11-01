import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { quoteBuyReport } from '../src/server/buy-report.ts';

// Synthetic, public-safe invitation observation, not private customer evidence.
const input = {
  steps: [{ check: 'http_status', outcome: 'failed', expected: 201, observed: 400 }],
};
const quote = await quoteBuyReport(input);
const directory = resolve('artifacts/buy-reports');
await mkdir(directory, { recursive: true, mode: 0o700 });
const path = resolve(directory, `quote-${Date.now()}.json`);
await writeFile(path, `${JSON.stringify(quote, null, 2)}\n`, { mode: 0o600 });
console.log(
  JSON.stringify({
    service: quote.service,
    paid: false,
    amountUnits: quote.offer.maxAmountRequired,
    token: 'USDC',
    chainId: 42220,
    requestHash: quote.requestHash,
    path,
  }),
);
