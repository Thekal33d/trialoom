/**
 * The Remesso allowance contract a builder's spending policy lives in, and the
 * only three pieces of its interface this product needs.
 *
 * These are copied rather than imported from `remesso-sdk` so the browser
 * bundle does not carry a server SDK. `tests/remesso-allowance.test.ts` asserts
 * they still equal the SDK's pinned deployment, so a copy that drifts fails a
 * check instead of a transaction.
 *
 * Verified 2026-11-08 against the installed SDK's deployment and Remesso's own
 * skill documentation, which both give the same address on Celo mainnet.
 * The contract is live and unaudited; a builder approves it directly.
 */
export const remessoAllowance = {
  chainId: 42220,
  address: '0xA6351fAeEb097698289586C4D6188530300DB209',
} as const;

export const allowanceCreateAbi = [
  {
    type: 'function',
    name: 'createPolicy',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agent', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'perPayment', type: 'uint128' },
      { name: 'perDay', type: 'uint128' },
      { name: 'expiresAt', type: 'uint64' },
      { name: 'allowlistOnly', type: 'bool' },
      { name: 'recipients', type: 'address[]' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'PolicyCreated',
    anonymous: false,
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'agent', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: false },
      { name: 'perPayment', type: 'uint128', indexed: false },
      { name: 'perDay', type: 'uint128', indexed: false },
      { name: 'expiresAt', type: 'uint64', indexed: false },
      { name: 'allowlistOnly', type: 'bool', indexed: false },
    ],
  },
] as const;

export const erc20ApproveAbi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
