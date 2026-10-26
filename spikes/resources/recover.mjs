import { createPublicClient, http } from 'viem';
import { celo } from 'viem/chains';
import { assertLocalAnvil } from 'remesso-sdk/dev';
import { readJson, json } from '../payments/journal.mjs';
import { resourceJournal } from './journal.mjs';
import { reconcileResource } from './reconcile.mjs';

const config = readJson(process.argv[2]);
await assertLocalAnvil(config.rpcUrl);
const client = createPublicClient({ chain: celo, transport: http(config.rpcUrl) });
const result = await reconcileResource({ client, journal: resourceJournal(config.journalPath), id: config.id, finality: 'included' });
console.log(json(result));
