import type { WalletConnectionConfig } from '../../domain/wallet-connections.ts';

/** Only public SDK identifiers cross the server/client boundary. Never return a signer key. */
export function walletConnectionConfig(
  env: Record<string, string | undefined> = process.env,
): WalletConnectionConfig {
  const clientId = env.WEB3AUTH_CLIENT_ID?.trim() || null;
  if (clientId && !/^[A-Za-z0-9_=-]{32,512}$/.test(clientId))
    throw new Error('Invalid WEB3AUTH_CLIENT_ID');
  const network = env.WEB3AUTH_NETWORK || 'sapphire_devnet';
  if (!['sapphire_devnet', 'sapphire_mainnet'].includes(network))
    throw new Error('Invalid WEB3AUTH_NETWORK');
  return {
    web3Auth: clientId
      ? { clientId, network: network as 'sapphire_devnet' | 'sapphire_mainnet' }
      : null,
  };
}
