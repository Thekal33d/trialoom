import type { EIP1193Provider } from 'viem';
import { celo } from 'viem/chains';
import type { WalletConnectionConfig, WalletIntent } from '../domain/wallet-connections.ts';
import { type LoginProof, signWalletLogin } from './wallet-proof.ts';

/** Loaded only after the user chooses Web3Auth, never for a direct wallet login. */
export async function signInWithWeb3Auth(
  config: NonNullable<WalletConnectionConfig['web3Auth']>,
  intent: WalletIntent,
  challenge: (address: string) => Promise<LoginProof>,
  verify: (proof: { id: string; signature: string }) => Promise<unknown>,
) {
  const { Web3Auth, authConnector, WALLET_CONNECTORS } = await import('@web3auth/modal');
  // SDK v11.4 uses storage adapters. Keep temporary OAuth tokens in this tab;
  // only the existing HttpOnly Trialoom session survives a successful sign-in.
  const storage = {
    get: async (key: string) => sessionStorage.getItem(key),
    set: async (key: string, value: string) => {
      sessionStorage.setItem(key, value);
    },
    remove: async (key: string) => {
      sessionStorage.removeItem(key);
    },
  };
  const auth = new Web3Auth({
    clientId: config.clientId,
    web3AuthNetwork: config.network,
    enableLogging: false,
    disableAnalytics: true,
    sessionTime: 3600,
    storage: { sessionId: storage, accessToken: storage, refreshToken: storage, idToken: storage },
    defaultChainId: '0xa4ec',
    chains: [
      {
        chainNamespace: 'eip155',
        chainId: '0xa4ec',
        displayName: celo.name,
        rpcTarget: celo.rpcUrls.default.http[0],
        blockExplorerUrl: celo.blockExplorers.default.url,
        ticker: celo.nativeCurrency.symbol,
        tickerName: celo.nativeCurrency.name,
        decimals: celo.nativeCurrency.decimals,
        logo: '',
      },
    ],
    connectors: [authConnector()],
    multiInjectedProviderDiscovery: false,
    useAAWithExternalWallet: false,
    modalConfig: {
      hideWalletDiscovery: true,
      connectors: { [WALLET_CONNECTORS.AUTH]: { label: 'Web3Auth', loginMethods: {} } },
    },
    uiConfig: { appName: 'Trialoom', mode: 'light', primaryButton: 'socialLogin', uxMode: 'popup' },
  });
  try {
    await auth.init();
    if (auth.coreOptions.accountAbstractionConfig?.chains?.length)
      throw new Error(
        'This sign-in requires an embedded EOA wallet. Disable smart accounts in the Web3Auth dashboard.',
      );
    const connection = await auth.connect();
    const provider = connection?.ethereumProvider;
    if (!provider) throw new Error('No wallet was connected.');
    // A social profile never creates or merges a Trialoom account. Prove control
    // of the embedded wallet with the same origin-bound SIWE challenge instead.
    const proof = await signWalletLogin(
      provider as EIP1193Provider,
      intent,
      window.location.origin,
      challenge,
    );
    await verify(proof);
  } finally {
    // Release embedded signing access when done or cancelled. No key is exported.
    try {
      await auth.logout({ cleanup: true });
    } catch {
      // Cleanup must not turn an already verified server session into a UI failure.
      await auth.cleanup().catch(() => undefined);
    }
  }
}
