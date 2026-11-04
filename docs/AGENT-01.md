# Wallet access for builder agents

Updated: 2026-11-04. D062. Implemented locally; the public deployment still needs this release and configuration.

A builder agent can now use the same workspace APIs as the browser without entering an email or password. The reference client is `src/client/trialoom-agent.ts`; the executable is `scripts/trialoom-agent.ts`. This is a Node client, not a published npm package, MCP server or A2A endpoint.

## Use the client

Install this repository's dependencies with Node 24. Supply a wallet key privately in `TRIALOOM_CLIENT_PRIVATE_KEY`, using your runtime's secret management. Do not put a key in command arguments, Git, screenshots or chat. The application never asks for a private key; this local client signs through its runtime wallet.

```sh
# Read status; the default origin is https://trialoom.xyz.
node scripts/trialoom-agent.ts --origin http://127.0.0.1:3000

# Save a website you are authorized to test.
node scripts/trialoom-agent.ts --origin http://127.0.0.1:3000 --website https://your-preview.example --authorized

# Run the prepared sample when the worker is available.
node scripts/trialoom-agent.ts --origin http://127.0.0.1:3000 --sample

# Test a saved project when its origin is enabled by the beta operator.
node scripts/trialoom-agent.ts --origin http://127.0.0.1:3000 --project PROJECT_UUID --authorized

# Re-read results, replay metadata and any paid-service proof.
node scripts/trialoom-agent.ts --origin http://127.0.0.1:3000
```

Each test command prints its request ID before posting. On an ambiguous response, retry the same action with `--request-id UUID`; do not create another request. Use `--workspace UUID` if the account owns multiple workspaces. Use `--cancel TEST_UUID` to request cancellation; occupied execution capacity is released only after verified cleanup.

## Authentication and limits

The client verifies the challenge's exact origin, scheme, chain 42220, wallet, nonce, request ID, purpose and expiry before asking its wallet to sign. Unexpected resource or validity extensions are refused. Cookies stay in memory, redirects are refused, and the session is revoked when the CLI exits. The TypeScript client accepts a signing interface, so callers can provide their own EOA signing implementation rather than a raw private key.

The APIs enforce account ownership, testing permission, enabled origins, atomic quotas and request idempotency. A caller's `--authorized` assertion does not override target isolation or operator enablement. This client never signs a transaction or token approval. Platform-sponsored analysis uses a separate capped signer. A verified receipt is shown only after independent settlement checks; delivered advice and payment status remain separate.

This client is for **builder-owned tests**. Paid-work operators use the separate admitted, scoped `/api/agent/v1` API documented in [WALLET-01](WALLET-01.md). Creating a wallet account grants neither assignments nor review/payment authority.

## Actual execution in this checkpoint

The client authenticated through the local HTTP application with a real wallet signature and requested the previously authorized Blokaz homepage. The first run was interrupted; its recorded containers were verified removed and the existing dispatch journal recovered it without repeating execution. A later explicit request completed as **blocked**, with homepage=false, scope=false, infrastructure=true and sanitized replay. This does not prove a website defect. The prepared sample also ran in real gVisor Chromium, passed all four checks and correctly skipped buying analysis.

These are internal engineering runs. They establish neither external adoption nor bounty demand. The public Railway deployment has not received these changes. Manual browser-extension testing remains outstanding; automated wallet tests simulate only wallet transport and use real signatures, HTTP, sessions and SQL.
