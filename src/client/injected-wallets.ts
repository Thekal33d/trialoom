import type { Wallet } from '@rainbow-me/rainbowkit';
import { createConnector } from 'wagmi';
import { type InjectedParameters, injected } from 'wagmi/connectors';

// RainbowKit's default MetaMask connector also enables SDK/QR transport. This
// descriptor keeps its familiar picker/install flow but connects directly to the
// extension. EIP-6963 wallets are discovered by Wagmi and deduplicated by rdns.
export function directMetaMaskWallet(): Wallet {
  const target = {
    id: 'metaMask',
    name: 'MetaMask',
    provider: (window) => {
      const ethereum = window?.ethereum;
      return (ethereum?.providers ?? [ethereum]).find(
        (provider) => provider?.isMetaMask && !provider.isRabby,
      );
    },
  } satisfies NonNullable<InjectedParameters['target']>;
  return {
    id: 'metaMask',
    name: 'MetaMask',
    rdns: 'io.metamask',
    iconUrl: '/wallets/metamask.svg',
    iconBackground: '#ffffff',
    // Wallet SDKs augment Window with incompatible optional provider flags.
    installed: Boolean(target.provider(window as unknown as Parameters<typeof target.provider>[0])),
    downloadUrls: {
      browserExtension: 'https://metamask.io/download',
      mobile: 'https://metamask.io/download',
    },
    createConnector: (details) =>
      createConnector((config) => ({ ...injected({ target })(config), ...details })),
  };
}
