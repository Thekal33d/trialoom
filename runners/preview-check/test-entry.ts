import { readIdentities } from './read-identities.ts';

await readIdentities();
await import('./proxy.test.ts');
