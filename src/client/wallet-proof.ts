import { createWalletClient, custom, type EIP1193Provider, getAddress } from 'viem';
import { celo } from 'viem/chains';
import { parseSiweMessage } from 'viem/siwe';
import type { WalletIntent } from '../domain/wallet-connections.ts';

export type LoginProof = { id: string; message: string };
const statements: Record<WalletIntent, string> = {
  'sign-in': 'Sign in to Trialoom. This grants login access only, no spending permission.',
  'sign-up':
    'Sign in to Trialoom or create a free workspace with this wallet. This grants login access only, no spending permission.',
  link: 'Link this wallet to your signed-in Trialoom account. This grants login access only, no spending permission.',
};

export function validateLoginProof(
  proof: LoginProof,
  address: string,
  intent: WalletIntent,
  origin: string,
) {
  const message = parseSiweMessage(proof.message);
  const url = new URL(origin);
  const now = Date.now();
  if (
    message.domain !== url.host ||
    message.uri !== url.origin ||
    message.scheme !== url.protocol.slice(0, -1) ||
    message.chainId !== celo.id ||
    message.address?.toLowerCase() !== address.toLowerCase() ||
    message.version !== '1' ||
    message.requestId !== proof.id ||
    !/^[a-f0-9]{48}$/.test(message.nonce ?? '') ||
    message.statement !== statements[intent] ||
    message.resources !== undefined ||
    message.notBefore !== undefined ||
    !message.issuedAt ||
    !message.expirationTime ||
    message.issuedAt.getTime() > now + 60000 ||
    message.issuedAt.getTime() < now - 300000 ||
    message.expirationTime.getTime() <= now ||
    message.expirationTime.getTime() > message.issuedAt.getTime() + 300000
  )
    throw new Error('The login request could not be verified. Please start again.');
  return message;
}

/** Shared EOA proof path for external wallets and the Web3Auth EIP-1193 provider. */
export async function signWalletLogin(
  provider: EIP1193Provider,
  intent: WalletIntent,
  origin: string,
  challenge: (address: string) => Promise<LoginProof>,
) {
  const client = createWalletClient({ chain: celo, transport: custom(provider) });
  const [address] = await client.requestAddresses();
  if (!address) throw new Error('Choose a wallet account to continue.');
  if ((await client.getChainId()) !== celo.id) {
    try {
      await client.switchChain({ id: celo.id });
    } catch (cause) {
      const error = cause as { code?: number; cause?: { code?: number } };
      if ((error.cause?.code ?? error.code) !== 4902) throw cause;
      await client.addChain({ chain: celo });
      await client.switchChain({ id: celo.id });
    }
  }
  if ((await client.getChainId()) !== celo.id)
    throw new Error('Switch your wallet to Celo, then try again.');
  const proof = await challenge(address);
  validateLoginProof(proof, address, intent, origin);
  const [current] = await client.getAddresses();
  if (!current || getAddress(current) !== getAddress(address))
    throw new Error('The selected account changed. Please start again.');
  const signature = await client.signMessage({ account: address, message: proof.message });
  return { id: proof.id, signature };
}
