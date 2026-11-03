import { readFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';

/**
 * ERC-8004 agent identity on Celo mainnet.
 *
 * The registry address was verified against the chain on 2026-11-02 and the
 * registration sequence against a simulation on 2026-11-03: `register()` with
 * no argument, then `setAgentURI` once the file carries the id the receipt
 * returns. See docs/ERC-8004.md.
 *
 * Nothing here is called by the product. It is operator tooling for a
 * one-off act that only the key holder can perform, and every path refuses
 * unless a key is configured.
 */
export const identityRegistry = {
  address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const,
  chainId: 42220,
  /** Allowed in the repository for reference; only mainnet counts. */
  sepolia: '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const,
};

export const registryAbi = [
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'setAgentURI',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'agentURI', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'tokenURI',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'string' }],
  },
  {
    name: 'ownerOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'Transfer',
    type: 'event',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
] as const;

/**
 * The wallet the entry names. The rules require the identity to be registered
 * from it, and it is the same wallet that signs sponsored payments, so one key
 * configures both rather than two keys quietly disagreeing about who we are.
 */
export function identityKey(env: NodeJS.ProcessEnv = process.env): `0x${string}` | null {
  const key = env.TRIALOOM_SPONSOR_AGENT_KEY ?? '';
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as `0x${string}`) : null;
}

export function identityClients(key: `0x${string}`, rpcUrl: string) {
  const account = privateKeyToAccount(key);
  return {
    account,
    chain: createPublicClient({ chain: celo, transport: http(rpcUrl) }),
    wallet: createWalletClient({ account, chain: celo, transport: http(rpcUrl) }),
  };
}

/** The registration file with its own id filled in, as a URI that needs no host. */
export async function agentUri(agentId: bigint, path = 'public/agent.json') {
  const file = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  file.registrations = [
    {
      agentId: Number(agentId),
      agentRegistry: `eip155:${identityRegistry.chainId}:${identityRegistry.address}`,
    },
  ];
  const body = JSON.stringify(file);
  return {
    body,
    uri: `data:application/json;base64,${Buffer.from(body, 'utf8').toString('base64')}`,
  };
}

/** The agent id a registration minted, read from the token's own Transfer log. */
export function agentIdFrom(logs: readonly unknown[]): bigint | null {
  const [minted] = parseEventLogs({
    abi: registryAbi,
    eventName: 'Transfer',
    logs: logs as never,
  });
  return minted?.args.tokenId ?? null;
}
