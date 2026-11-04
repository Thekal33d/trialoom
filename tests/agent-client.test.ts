import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { trialoomAgent } from '../src/client/trialoom-agent.ts';

test('the agent refuses foreign-purpose, foreign-origin, expired and resource-bearing challenges before signing', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  let signatures = 0;
  let message = '';
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        req.url === '/api/health'
          ? { walletLogin: 'enabled', walletSignup: 'enabled' }
          : { id: 'challenge-id', message },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const client = trialoomAgent(origin, {
    address: account.address,
    signMessage: async () => {
      signatures++;
      throw new Error('Must not sign');
    },
  });
  try {
    const base = {
      address: account.address,
      chainId: 42220,
      domain: new URL(origin).host,
      scheme: 'http',
      uri: origin,
      version: '1' as const,
      nonce: 'a'.repeat(48),
      requestId: 'challenge-id',
      issuedAt: new Date(),
      expirationTime: new Date(Date.now() + 300000),
      statement:
        'Sign in to Trialoom or create a free workspace with this wallet. This grants login access only, no spending permission.',
    };
    for (const change of [
      { domain: 'attacker.example' },
      { uri: 'https://attacker.example' },
      { statement: 'Authorize payment' },
      { expirationTime: new Date(Date.now() - 1000) },
      { resources: ['https://attacker.example/payment'] },
      { scheme: 'https' },
    ]) {
      message = createSiweMessage({ ...base, ...change });
      await assert.rejects(client.connect(), /unexpected wallet login challenge/);
    }
    assert.equal(signatures, 0);
    assert.throws(() => trialoomAgent('http://public.example', account), /HTTPS/);
    assert.throws(() => trialoomAgent(`${origin}/api`, account), /HTTPS/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
