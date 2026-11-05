export type WalletConnectionConfig = {
  web3Auth: {
    clientId: string;
    network: 'sapphire_devnet' | 'sapphire_mainnet';
  } | null;
};

export type WalletIntent = 'sign-in' | 'sign-up' | 'link';
