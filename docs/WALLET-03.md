# Standard wallet entry and Web3Auth

Date: 2026-11-05. Decision: D063. Local implementation; hosted Trialoom is unchanged.

## User flow

At `/sign-in`, **Connect wallet** opens RainbowKit. Choose an installed wallet, approve connecting/switching to Celo, then **Sign message**. The same flow creates a free workspace or returns to the wallet's existing one. There is no dropdown and no payment request. On desktop, EIP-6963 wallets appear by their own names/icons; legacy MetaMask, Rabby and other browser providers remain available. On a phone, use the wallet's own browser for an injected connection.

**Continue with Web3Auth** opens the project's embedded-wallet login choices, including Google when enabled in its dashboard. Its resulting EVM wallet signs Trialoom's login challenge. Selecting a different social account or a different external wallet can represent a different wallet identity. To keep an existing workspace, sign in to it first and use **Account settings → Link a wallet**. Never merge identities using an unverified social email.

The default MetaMask connector in RainbowKit 2.2.11 includes other transports; the small `directMetaMaskWallet` descriptor uses Wagmi's injected connector instead. A blank internal `projectId` satisfies RainbowKit's wallet-list helper signature, but no configured connector consumes it or starts WalletConnect. EIP-6963 discovery and the standard modal remain library-managed. The MetaMask icon is distributed with RainbowKit under the adjacent MIT notice in `public/wallets/`.

## Configuration

Existing flags and migration 0025 from [WALLET-01](WALLET-01.md) still apply. No new migration.

```dotenv
TRIALOOM_WALLET_LOGIN=true
TRIALOOM_PUBLIC_WALLET_SIGNUP=true
WEB3AUTH_CLIENT_ID=your-public-app-client-id
WEB3AUTH_NETWORK=sapphire_devnet
```

- `WEB3AUTH_CLIENT_ID` and `WEB3AUTH_NETWORK` are read at server runtime; only these public values cross into the browser. No `NEXT_PUBLIC` signer variable or Reown ID is needed.
- Omitting the client ID removes the optional Web3Auth button. Direct wallet login remains available.
- Match the network to the Web3Auth dashboard project. Use Sapphire Devnet for localhost. For production, create/configure the Mainnet project and allowlist `https://trialoom.xyz`. Allowlist the exact local origin for local development, including `http://127.0.0.1:3000` if used. Restart the app after environment changes.
- Enable the desired social login connections in the dashboard. Keep smart accounts disabled: Trialoom currently verifies EOA signatures. The client refuses a smart-account configuration rather than silently changing identity.
- The optional SDK uses a Celo chain override and tab-scoped token storage; the app never exports a private key or uses a social profile as a session credential. Temporary SDK access is cleaned up after signing/cancellation. Trialoom's session remains an HttpOnly server cookie.
- These switches do not enable hosted testing, operator admission, sponsor spending or paid work.

## Verification and remaining checks

The automated browser wallet transport is simulated, with real cryptographic signatures, real auth HTTP/cookies, disposable PostgreSQL and the actual standard picker. It covers new/returning accounts, explicit email-account linking, separate installed identities, legacy providers, cancellation, Celo switching, exact account-only permission requests, and no transaction/signing methods beyond login. Desktop/mobile accessibility, screenshots and overflow are checked. Unit tests reject foreign origin/purpose/chain/account/time and refuse signing when accounts change or network switching is cancelled. Backend tests cover replay, one-use challenge consumption and account/workspace entitlement boundaries.

The configured local Web3Auth project was actually initialized in Chromium on desktop/mobile; Google and other choices rendered. No OAuth login was completed, no code/email was sent, and no embedded account was created during inspection. The shared embedded EIP-1193 signing path is exercised with a simulated provider; a full social-provider round trip and a real wallet-extension approval still need the user's manual check. This is not a claim of deployed or fully certified provider integration.

Dependency audit on 2026-11-05 reports **57 production findings: 17 high, 21 moderate, 19 low, zero critical**, including propagated findings. The installed SDK graph contains older optional WalletConnect/Reown, Coinbase and MetaMask dependencies even though the direct wallet flow does not initialize those transports. Primary advisory roots include `ws`, `decode-uri-component`, nested Zod 3, `uuid`, `deepmerge` and `elliptic`. Do not treat unreachable optional code as proof that all findings are harmless. Production dependency review/remediation remains open; no automatic major downgrade/upgrade or `audit fix --force` was applied. Full machine output stays in ignored `artifacts/wallet-dependency-audit.json`.

No QR relay, EIP-1271, MiniPay message-signing compatibility, lost-wallet recovery or automatic account merge is claimed. No remote push, deployment or purchase was made.

## Sources checked

- Installed Celopedia skill (`/Users/0t41k1/.agents/skills/celopedia-skill/SKILL.md`): applied the installed skill's `references/sdk-reference.md` and `references/builder-guide.md` (Wagmi/RainbowKit, Celo chain 42220, MiniPay signing limitations).
- [RainbowKit custom wallets](https://rainbowkit.com/docs/custom-wallet-list), [custom authentication](https://rainbowkit.com/docs/custom-authentication), and [custom connect button](https://rainbowkit.com/docs/custom-connect-button).
- [MetaMask Embedded Wallets JavaScript SDK](https://docs.metamask.io/embedded-wallets/sdk/js/), [configuration](https://docs.metamask.io/embedded-wallets/sdk/js/advanced/) and [dashboard](https://docs.metamask.io/embedded-wallets/dashboard/).

Implementation follows the pinned SDK declarations where the current documentation lags: v11.4.3 uses storage adapters and `connection.ethereumProvider`. RainbowKit 2.2.11's adapter signs the returned message string directly. Provider verification is still server-side; neither SDK establishes application authorization on its own.
