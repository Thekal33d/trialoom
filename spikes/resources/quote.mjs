import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { catalog, readQuote } from './quotes.mjs';

const results = await Promise.all(catalog.map(readQuote));
const directory = fileURLToPath(new URL('../../artifacts/resources/', import.meta.url));
await mkdir(directory, { recursive: true });
const path = `${directory}quotes-${Date.now()}.json`;
await writeFile(path, JSON.stringify({ task: 'VAL-04', mode: 'unsigned-live-quotes', results }, null, 2) + '\n');
for (const result of results) console.log(`${result.id}: ${result.selected.maxAmountRequired} USDC base units (unsigned quote)`);
console.log(`Evidence: ${path}`);
