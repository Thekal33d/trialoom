# Remesso capability and recovery experiment

VAL-03 runs actual `remesso-sdk@0.3.0` and deployed contract code on an owned Anvil fork of Celo. All transactions go to loopback. It does not spend mainnet funds or use the user's wallet. The committed [evidence](../../docs/evidence/VAL-03.json) records the fork, source hashes, contract code hashes, and 19 passing checks.

With Node 24 and Anvil on PATH:

```sh
npm ci --ignore-scripts
npm run spike:payments
```

The runner needs read access to `https://forno.celo.org` and free loopback ports 18546/18547. It starts and closes its own Anvil and SDK backend emulator. Public Anvil fixture accounts are permitted only after URL, Anvil identity, and chain checks. USDC is minted inside the disposable fork by impersonating its discovered master minter; this changes no real token balances. SDK startup also seeds local USDT.

The runner creates a recipient-restricted USDC policy and a synthetic accepted payable for 250,000 base units (0.25 USDC). It kills a child process immediately after successful broadcast, before the SDK receives the RPC result. The signed intent already exists in a private durable journal. Separate replacement processes reconcile and retry that key. Assertions verify the original hash, a single recipient balance increase, one sender nonce, exact receipt terms, and refusal of changed terms. Policy revocation leaves the separate accepted payable blocked and intact.

Other checks cover the token's six decimals, deployed code, quote/allowance behavior, debit and policy limits, recipient restriction, invalid precision, corrupt journals, and a local-only builder attribution suffix. `npm test` also checks remote-signing guards. The `trialoom_local` code is test data, not an enrolled hackathon code.

Private payable fixtures, signed transaction journals, and possible SDK diagnostics stay under ignored `artifacts/payments/<run>/private/`. Only the allowlisted `evidence.json` summary is suitable for review and copying to `docs/evidence/VAL-03.json`. Local transaction hashes are not mainnet explorer evidence.

## Integration findings, checked 2026-10-26

The [Remesso production guide](https://docs.remesso.xyz/docs/guides/production-sdk) and pinned [SDK package](https://www.npmjs.com/package/remesso-sdk/v/0.3.0) provide durable payment stores, explicit reconciliation, and local fork tooling. Trialoom must keep its own commitments: a quote checks current ability to pay and does not reserve funds. The local result verifies the policy path; wallet-funded schedules are a different path.

- USDC token: `0xcebA9300f2b948710d2653dD7B07f33A8B32118C`, six decimals. Its gas adapter is `0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B`; these are different contracts.
- RemessoAgentAllowance: `0xA6351fAeEb097698289586C4D6188530300DB209`.
- RemessoExecutorV5: `0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8`.
- The policy quote reported zero protocol fee; network gas remains a separate cost. The SDK's `confirmed` send result means inclusion, not verified real-network finality.

Addresses come from the pinned SDK deployment manifest and were checked against fork state. Local minting uses [Circle's published token interface](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v1/FiatTokenV1.sol). [Builder-code support](https://docs.remesso.xyz/docs/guides/builder-codes) is exercised with a test code only.

## Limits and next implementation requirements

This is single-writer capability evidence. File stores have no cross-process locking; test workers run sequentially. Production must share payout identities, all SDK journals, and signer/nonce coordination across workers. The SDK's PostgreSQL adapter is a candidate, not yet tested here. Application acceptance/payable/outbox atomicity, cross-campaign liability, claims pausing, shared allowances, and receipt reorg handling still belong to the alpha implementation.

The production backend/indexer, funded production authorization, gas policy, real finality timing, and concurrent recovery are not validated. The accepted work is a fixture and has no independent operator. Neither Remesso authorization nor this test creates escrow. The SDK's [security guidance](https://docs.remesso.xyz/docs/resources/security) remains relevant before funded operation.
