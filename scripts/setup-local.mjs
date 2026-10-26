import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const password = randomBytes(24).toString('hex');
const body = `# Local Trialoom development database only. Never commit this file.
POSTGRES_USER=trialoom
POSTGRES_PASSWORD=${password}
POSTGRES_DB=trialoom_dev
DB_PORT=55432
DATABASE_URL=postgresql://trialoom:${password}@127.0.0.1:55432/trialoom_dev
`;
try {
  writeFileSync(new URL('../.env', import.meta.url), body, { flag: 'wx', mode: 0o600 });
  console.log('Created private .env. Next: npm run db:up, then npm run db:migrate.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing .env preserved.');
}
