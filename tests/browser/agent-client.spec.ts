import { expect, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { trialoomAgent } from '../../src/client/trialoom-agent';

test.skip(
  process.env.TRIALOOM_WALLET_LOGIN !== 'true' ||
    process.env.TRIALOOM_PUBLIC_WALLET_SIGNUP !== 'true',
  'Enable wallet login and signup for this suite.',
);

test('a headless wallet client owns a free workspace and cannot select another wallet’s workspace', async ({
  baseURL,
}) => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  if (!baseURL) throw new Error('Missing test server URL');
  const client = trialoomAgent(baseURL, wallet);
  const stranger = trialoomAgent(baseURL, privateKeyToAccount(generatePrivateKey()));
  try {
    const connection = await client.connect();
    expect(connection.address).toBe(wallet.address);
    expect(connection.status.tests).toEqual([]);
    expect(() => client.addWebsite('https://example.com', false)).toThrow('permission');
    expect(() => client.start({ projectId: 'unused' })).toThrow('permission');
    const project = await client.addWebsite('https://example.com', true);
    expect((await client.projects()).projects.map((item) => item.id)).toContain(project.id);
    await expect(stranger.connect(connection.workspaceId)).rejects.toThrow('owned free workspace');
    expect(() => stranger.status()).toThrow('Connect the wallet first');
    await client.close();
    expect(() => client.status()).toThrow('Connect the wallet first');
    expect((await client.connect()).workspaceId).toBe(connection.workspaceId);
    expect((await client.projects()).projects.map((item) => item.id)).toContain(project.id);
  } finally {
    await Promise.all([client.close(), stranger.close()]);
  }
});
