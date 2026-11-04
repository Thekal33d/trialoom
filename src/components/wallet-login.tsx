'use client';
import { useEffect, useState } from 'react';
import { createWalletClient, custom, type EIP1193Provider } from 'viem';
import { celo } from 'viem/chains';
import { api } from './live-types';

type Wallet = { id: string; name: string; provider: EIP1193Provider };
export function WalletLogin({ intent = 'sign-in' }: { intent?: 'sign-in' | 'sign-up' | 'link' }) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const fallback = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
    if (fallback) setWallets([{ id: 'injected', name: 'Browser wallet', provider: fallback }]);
    function announce(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (
        !detail?.provider?.request ||
        typeof detail.info?.uuid !== 'string' ||
        typeof detail.info?.name !== 'string'
      )
        return;
      const wallet = {
        id: detail.info.uuid,
        name: detail.info.name.slice(0, 60),
        provider: detail.provider,
      };
      setWallets((current) =>
        current.some((item) => item.id === wallet.id)
          ? current
          : [...current.filter((item) => item.id !== 'injected'), wallet],
      );
    }
    window.addEventListener('eip6963:announceProvider', announce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    return () => window.removeEventListener('eip6963:announceProvider', announce);
  }, []);

  async function connect() {
    setBusy(true);
    setError('');
    try {
      const wallet = wallets.find((item) => item.id === selected) ?? wallets[0];
      if (!wallet)
        throw new Error(
          'Open Trialoom in your wallet’s browser, or install a browser wallet such as MetaMask or Rabby.',
        );
      const client = createWalletClient({ chain: celo, transport: custom(wallet.provider) });
      const [address] = await client.requestAddresses();
      if (!address) throw new Error('Choose a wallet account to continue.');
      if ((await client.getChainId()) !== celo.id) {
        try {
          await client.switchChain({ id: celo.id });
        } catch (cause) {
          const code =
            (cause as { code?: number; cause?: { code?: number } }).cause?.code ??
            (cause as { code?: number }).code;
          if (code !== 4902) throw new Error('Switch your wallet to Celo, then try again.');
          await client.addChain({ chain: celo });
          await client.switchChain({ id: celo.id });
        }
      }
      if ((await client.getChainId()) !== celo.id)
        throw new Error('Switch your wallet to Celo, then try again.');
      const challenge = await api<{ id: string; message: string }>(
        '/api/auth/wallet/challenge',
        'POST',
        { address, intent },
      );
      const signature = await client.signMessage({ account: address, message: challenge.message });
      await api('/api/auth/wallet/verify', 'POST', { id: challenge.id, signature });
      window.location.assign(intent === 'link' ? '/account' : '/workspace');
    } catch (cause) {
      const code =
        (cause as { code?: number; cause?: { code?: number } }).cause?.code ??
        (cause as { code?: number }).code;
      setError(
        code === 4001
          ? 'Wallet request cancelled. You can try again when ready.'
          : cause instanceof Error
            ? cause.message.split('\n')[0]
            : 'Wallet sign-in failed. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wallet-login app-form">
      {wallets.length > 1 && (
        <label>
          Choose a wallet
          <select
            value={selected || wallets[0]?.id}
            onChange={(event) => setSelected(event.target.value)}
            disabled={busy}
          >
            {wallets.map((wallet) => (
              <option key={wallet.id} value={wallet.id}>
                {wallet.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() => void connect()}
      >
        {busy
          ? 'Continue in your wallet…'
          : intent === 'link'
            ? 'Link a wallet'
            : intent === 'sign-up'
              ? 'Create workspace with a wallet'
              : 'Sign in with a wallet'}
      </button>
      <small>
        Celo wallet signature only. No gas fee or spending permission. Supports browser wallets;
        smart contract wallets are not supported yet.
      </small>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
