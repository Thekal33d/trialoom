import assert from 'node:assert/strict';
import test from 'node:test';
import type { EIP1193Provider } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { signWalletLogin, validateLoginProof } from '../src/client/wallet-proof.ts';
import { walletConnectionConfig } from '../src/server/auth/connections.ts';

const account = privateKeyToAccount(generatePrivateKey());
const origin = 'http://127.0.0.1:3000';
function proof(overrides = {}) {
  const id = '6cfb8211-2b5d-4e90-8f32-9c9ef64373ef';
  return {
    id,
    message: createSiweMessage({
      domain: '127.0.0.1:3000',
      uri: origin,
      scheme: 'http',
      version: '1',
      chainId: 42220,
      address: account.address,
      nonce: 'a'.repeat(48),
      requestId: id,
      issuedAt: new Date(),
      expirationTime: new Date(Date.now() + 300000),
      statement: 'Sign in to Trialoom. This grants login access only, no spending permission.',
      ...overrides,
    }),
  };
}

test('browser and embedded wallet proofs refuse foreign origins, intent, chain, time and account', () => {
  assert.equal(validateLoginProof(proof(), account.address, 'sign-in', origin).chainId, 42220);
  for (const overrides of [
    { domain: 'attacker.example' },
    { uri: 'https://attacker.example' },
    { scheme: 'https' },
    { chainId: 1 },
    { address: privateKeyToAccount(generatePrivateKey()).address },
    { statement: 'Authorize a token payment' },
    { resources: ['https://example.com/transfer'] },
    { nonce: 'b'.repeat(10) },
    { requestId: 'different' },
    { issuedAt: new Date(Date.now() - 360000) },
    { expirationTime: new Date(Date.now() - 1) },
    { expirationTime: new Date(Date.now() + 600000) },
    { notBefore: new Date() },
  ])
    assert.throws(() => validateLoginProof(proof(overrides), account.address, 'sign-in', origin));
  assert.throws(() => validateLoginProof(proof(), account.address, 'link', origin));
});

function transport({ changedAccount = false, addChain = false, rejectSwitch = false } = {}) {
  let chain = 1;
  let added = false;
  const methods: string[] = [];
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      methods.push(method);
      if (method === 'eth_requestAccounts') return [account.address];
      if (method === 'eth_accounts')
        return [
          changedAccount ? privateKeyToAccount(generatePrivateKey()).address : account.address,
        ];
      if (method === 'eth_chainId') return `0x${chain.toString(16)}`;
      if (method === 'wallet_switchEthereumChain') {
        if (rejectSwitch) throw Object.assign(new Error('Cancelled'), { code: 4001 });
        if (addChain && !added) throw Object.assign(new Error('Unknown chain'), { code: 4902 });
        chain = 42220;
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        added = true;
        return null;
      }
      if (method === 'personal_sign')
        return account.signMessage({ message: { raw: String(params?.[0]) as `0x${string}` } });
      throw new Error(`Unexpected method: ${method}`);
    },
  } as EIP1193Provider;
  return { provider, methods };
}

test('shared EIP-1193 path adds missing Celo, signs only the validated login and never transacts', async () => {
  const { provider, methods } = transport({ addChain: true });
  const challenge = proof();
  const result = await signWalletLogin(provider, 'sign-in', origin, async () => challenge);
  assert.equal(result.signature, await account.signMessage({ message: challenge.message }));
  assert.equal(result.id, challenge.id);
  assert.deepEqual(methods, [
    'eth_requestAccounts',
    'eth_chainId',
    'wallet_switchEthereumChain',
    'wallet_addEthereumChain',
    'wallet_switchEthereumChain',
    'eth_chainId',
    'eth_accounts',
    'personal_sign',
  ]);
});

test('account changes, rejected network switches and unsafe challenges never reach signing', async () => {
  for (const options of [{ changedAccount: true }, { rejectSwitch: true }, {}]) {
    const { provider, methods } = transport(options);
    await assert.rejects(
      signWalletLogin(provider, 'sign-in', origin, async () =>
        proof(Object.keys(options).length ? {} : { domain: 'attacker.example' }),
      ),
    );
    assert.equal(methods.includes('personal_sign'), false);
  }
});

test('public connection configuration exposes only the Web3Auth app ID and network', () => {
  assert.deepEqual(walletConnectionConfig({}), { web3Auth: null });
  const clientId = 'a'.repeat(64);
  assert.deepEqual(
    walletConnectionConfig({
      WEB3AUTH_CLIENT_ID: clientId,
      WEB3AUTH_NETWORK: 'sapphire_mainnet',
      TRIALOOM_SPONSOR_AGENT_KEY: 'never-render-this',
    }),
    { web3Auth: { clientId, network: 'sapphire_mainnet' } },
  );
  assert.throws(() => walletConnectionConfig({ WEB3AUTH_CLIENT_ID: 'bad' }));
  assert.throws(() => walletConnectionConfig({ WEB3AUTH_NETWORK: 'unknown' }));
});
