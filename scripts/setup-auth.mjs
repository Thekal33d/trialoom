import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, readFileSync } from 'node:fs';

const file = new URL('../.env', import.meta.url);
const keys = new Set(
  readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.split('=')[0]),
);
let additions = '';
if (!keys.has('BETTER_AUTH_SECRET'))
  additions += `BETTER_AUTH_SECRET=${randomBytes(48).toString('base64url')}\n`;
if (!keys.has('BETTER_AUTH_URL')) additions += 'BETTER_AUTH_URL=http://127.0.0.1:3000\n';
if (additions) appendFileSync(file, `\n# Authentication for this local app only.\n${additions}`);
chmodSync(file, 0o600);
console.log('Local authentication configuration ready; existing values preserved.');
