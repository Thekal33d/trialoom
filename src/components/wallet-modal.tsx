'use client';

import '@rainbow-me/rainbowkit/styles.css';
import {
  ConnectButton,
  connectorsForWallets,
  createAuthenticationAdapter,
  lightTheme,
  RainbowKitAuthenticationProvider,
  RainbowKitProvider,
} from '@rainbow-me/rainbowkit';
import { injectedWallet, rabbyWallet } from '@rainbow-me/rainbowkit/wallets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { celo } from 'viem/chains';
import { createConfig, http, WagmiProvider } from 'wagmi';
import { getAccount } from 'wagmi/actions';
import { directMetaMaskWallet } from '@/client/injected-wallets';
import { type LoginProof, validateLoginProof } from '@/client/wallet-proof';
import { api } from './live-types';
import type { WalletLoginProps } from './wallet-login';
import { Web3AuthLogin } from './web3auth-login';

function config() {
  const ethereum = (window as Window & { ethereum?: { isMetaMask?: boolean; isRabby?: boolean } })
    .ethereum;
  return createConfig({
    chains: [celo],
    // This component is client-only. No persisted connection should auto-sign in.
    ssr: false,
    storage: null,
    multiInjectedProviderDiscovery: true,
    connectors: connectorsForWallets(
      [
        {
          groupName: 'Browser wallets',
          wallets: [
            directMetaMaskWallet,
            rabbyWallet,
            () => ({
              ...injectedWallet(),
              installed: Boolean(ethereum),
              // Deduplicate the legacy provider when the same wallet announces EIP-6963.
              rdns: ethereum?.isRabby
                ? 'io.rabby'
                : ethereum?.isMetaMask
                  ? 'io.metamask'
                  : undefined,
              hidden: () => !ethereum || Boolean(ethereum.isMetaMask || ethereum.isRabby),
            }),
          ],
        },
      ],
      // RainbowKit's helper accepts this field for QR connectors. None of these connectors
      // above uses that protocol: no Reown project or relay is initialized.
      { appName: 'Trialoom', projectId: '' },
    ),
    transports: { [celo.id]: http() },
  });
}

const theme = lightTheme({
  accentColor: '#205b3e',
  accentColorForeground: '#ffffff',
  borderRadius: 'medium',
  fontStack: 'system',
  overlayBlur: 'small',
});
theme.colors.modalTextSecondary = '#626b66';
theme.colors.modalTextDim = '#626b66';

export default function WalletModal({
  intent = 'sign-in',
  primary = false,
  label,
  connections,
}: WalletLoginProps) {
  const [wagmi] = useState(config);
  const [query] = useState(() => new QueryClient());
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'unauthenticated' | 'authenticated'>('unauthenticated');
  useEffect(() => {
    // RainbowKit 2.2.11 renders decorative wallet logos as unnamed role=img
    // elements. Keep the adjacent wallet labels, omit duplicate unlabeled images.
    const hideDecorativeIcons = () => {
      for (const icon of document.querySelectorAll(
        '[data-rk] [role="dialog"] [role="img"]:not([aria-label]):not([aria-labelledby])',
      )) {
        icon.setAttribute('aria-hidden', 'true');
      }
    };
    const observer = new MutationObserver(hideDecorativeIcons);
    observer.observe(document.body, { childList: true, subtree: true });
    hideDecorativeIcons();
    return () => observer.disconnect();
  }, []);
  const adapter = useMemo(() => {
    let proof: LoginProof | undefined;
    return createAuthenticationAdapter({
      getNonce: async () => {
        setError('');
        const { address } = getAccount(wagmi);
        if (!address) throw new Error('Choose a wallet to continue.');
        proof = await api<LoginProof>('/api/auth/wallet/challenge', 'POST', { address, intent });
        return validateLoginProof(proof, address, intent, window.location.origin).nonce as string;
      },
      createMessage: ({ address, chainId, nonce }) => {
        if (!proof || chainId !== celo.id) throw new Error('Switch to Celo to continue.');
        const message = validateLoginProof(proof, address, intent, window.location.origin);
        if (message.nonce !== nonce) throw new Error('Please reconnect your wallet.');
        return proof.message;
      },
      verify: async ({ message, signature }) => {
        if (!proof || message !== proof.message) return false;
        try {
          await api('/api/auth/wallet/verify', 'POST', { id: proof.id, signature });
          setStatus('authenticated');
          window.location.assign(intent === 'link' ? '/account' : '/workspace');
          return true;
        } catch {
          setError('We couldn’t finish signing in. Close the wallet window and try again.');
          return false;
        }
      },
      signOut: async () => {
        // Disconnecting the picker must not log an existing email owner out while
        // linking. Trialoom's server session is ended by the app's Sign out action.
        proof = undefined;
        setStatus('unauthenticated');
      },
    });
  }, [wagmi, intent]);
  return (
    <WagmiProvider config={wagmi} reconnectOnMount={false}>
      <QueryClientProvider client={query}>
        <RainbowKitAuthenticationProvider adapter={adapter} status={status}>
          <RainbowKitProvider
            theme={theme}
            modalSize="compact"
            initialChain={celo}
            appInfo={{ appName: 'Trialoom' }}
          >
            <div className="wallet-login app-form">
              <ConnectButton.Custom>
                {({ mounted, openConnectModal }) => (
                  <button
                    type="button"
                    className={`button ${primary ? 'primary' : 'secondary'}`}
                    disabled={!mounted}
                    onClick={openConnectModal}
                  >
                    {label ?? (intent === 'link' ? 'Link a wallet' : 'Connect wallet')}
                  </button>
                )}
              </ConnectButton.Custom>
              <small className="wallet-note">
                Sign a free message. No payment or spending permission.
              </small>
              {connections.web3Auth && (
                <Web3AuthLogin config={connections.web3Auth} intent={intent} />
              )}
              <p className="wallet-install">
                Use MetaMask, Rabby or your browser wallet.{' '}
                <a href="https://metamask.io/download" target="_blank" rel="noreferrer">
                  Get a wallet ↗
                </a>
              </p>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          </RainbowKitProvider>
        </RainbowKitAuthenticationProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
