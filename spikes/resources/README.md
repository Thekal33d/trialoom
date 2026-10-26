# buy resource capability experiment

VAL-04 has live unsigned quotes, SDK fault tests, and actual EIP-3009 settlement/recovery on a local Celo fork. **No real browser or VM has been purchased.** Provisioning, useful output, isolation, and Playwright/CDP trace export remain open.

```sh
npm ci --ignore-scripts
npm test
npm run spike:resource-quotes
npm run spike:resources
```

The quote command has no signer. It sends ordinary unsigned POST requests to two pinned public endpoints and records their HTTP 402 offers under ignored `artifacts/resources/`. The settlement runner requires Anvil and read-only upstream RPC access, uses an owned loopback fork, and sends signed requests only to an injected `resource.invalid` fixture. The harness rejects live payment URLs. It does not use the buy CLI, a keychain, or a user wallet.

## Observed capabilities

Checked 2026-10-26 against the [official buy documentation](https://usebuy.ai/docs), its live endpoints, and pinned [@celo/buy-core 0.8.4](https://www.npmjs.com/package/@celo/buy-core/v/0.8.4). Reviewed quote bodies are in [VAL-04-quotes.json](../../docs/evidence/VAL-04-quotes.json); observations expire and must be refreshed before any purchase.

| Requested service | Endpoint | Observed Celo USDC quote | What was verified |
| --- | --- | --- | --- |
| One-minute browser | `POST https://gateway.usebuy.ai/v1/browser/sessions`, `durationMinutes: 1` | 3,606 base units = 0.003606 USDC | Valid unsigned quote; also advertises Celo Sepolia sandbox USDC |
| e2-micro VM running `uname -a` | `POST https://usebuy.ai/google/vm` | 16,753 base units = 0.016753 USDC | Valid unsigned quote for one hour; this response offered mainnet networks only |

The observed USDC asset and recipient are pinned in the quote parser. A future provider-address change must be reviewed. The fork confirms the quote's EIP-712 domain against the USDC contract's `DOMAIN_SEPARATOR`. Actual provisioning response formats, remote browser connectivity, lease cleanup, target restrictions, and trace retrieval are not inferred from a quote.

## Payment and accounting experiment

The SDK signs real EIP-3009 authorizations. A simulated provider redeems them against USDC inside the local fork, then either drops the response or returns HTTP 500. A new process reopens the journal and checks the authorization nonce, successful canonical receipt, and exact token transfer. Both cases settle once. [VAL-04.json](../../docs/evidence/VAL-04.json) records 14 passing fork checks and source hashes. These local transaction hashes are not mainnet payment evidence.

The adapter enforces pinned token/network/recipient/domain, integer caps, a shared resource ceiling, and successful funding lookup before signing. The SDK's optional balance preflight fails open on RPC errors; this harness adds a failing-closed check in `onChallenge`. Reservation occurs after signing but before dispatch, and public authorization fields are durably saved immediately before the request. No signature is saved in the resource journal.

Every intent has one durable identity. Any paid HTTP response—including 200, 400, 402, or 500—or lost response retains the commitment until chain reconciliation. Reopening the journal cannot create a second authorization for that intent. Cancellation/used nonce alone is insufficient payment evidence. An unused authorization can release its reservation only after expiry at a finalized block. RPC failure or missing/mismatched receipt evidence keeps it committed.

Settled costs still consume the resource-wallet ceiling. This experiment authorizes zero builder charges because it validates no delivered resource output. Production eligibility, reimbursement, fees, and platform-loss accounting remain unimplemented. Single-process overlapping reservations are tested; the JSON journal is **not safe for independent concurrent workers**.

## Reproducibility and limits

`npm test` includes 13 resource cases covering quote tampering, funding failures, paid-response statuses, connection loss, restart refusal, poll origin restrictions, budget contention, journal failures before/after dispatch, expiry, and exact receipt matching. The full suite also contains browser and Remesso guard tests.

The first fork settlement attempt failed signature validation with the standard public Anvil payer, which has EIP-7702 delegated code in current Celo state. The quote's domain and type hash matched the token. A fresh ephemeral EOA passed; this points to account-type compatibility, not a domain mismatch. Contract/delegated-wallet support remains untested. The successful runner checks the new payer has no code and never exports or persists its ephemeral key.

Local minting uses the shared guarded helper from [the Remesso spike](../payments/README.md). Settlement uses [Circle's published EIP-3009 interface](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol). Private journals/diagnostics stay under ignored `artifacts/`. Evidence summaries omit signatures and keys. Source hashes represent each recorded execution; supporting tests added afterward are recorded separately.

## Remaining VAL-04 gate

Provision one capped browser session using a dedicated funded sandbox or approved mainnet resource wallet, connect a runner, execute the seeded journey against an authorized reachable fixture, export a trace, verify isolation/lease cleanup, and reconcile the actual receipt. The recorded browser quote provides a concrete candidate; it does not authorize spending or prove usability. The wallet/funding source and fresh quote must be established first. Mainnet hackathon evidence and attribution are separate from a sandbox experiment.

Architecture selection can proceed with the local runner baseline and these provider constraints. The live buy adapter must remain disabled until this gate is met; no marketplace or hackathon readiness is claimed by the local simulation.
