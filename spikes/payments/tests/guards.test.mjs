import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalAnvil } from 'remesso-sdk/dev';
import { localClient } from '../local.mjs';

test('public fixture signer refuses remote and deceptive RPC targets before use', async () => {
  for (const rpcUrl of ['https://forno.celo.org', 'http://127.0.0.1.example.com',
    'http://user:password@127.0.0.1:18546', 'http://127.0.0.1:18546/path']) {
    await assert.rejects(localClient({ rpcUrl, functionsUrl: 'http://127.0.0.1:18547', directory: '/unused' }));
  }
});

test('loopback guard requires both Anvil identity and Celo chain', async () => {
  for (const [version, chainId] of [['geth', '0xa4ec'], ['anvil/v1.4.3', '0x1']]) {
    const fetcher = async (_url, init) => {
      const { method, id } = JSON.parse(init.body);
      return Response.json({ jsonrpc: '2.0', id, result: method === 'web3_clientVersion' ? version : chainId });
    };
    await assert.rejects(assertLocalAnvil('http://127.0.0.1:18546', fetcher));
  }
});
